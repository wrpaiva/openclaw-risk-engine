import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RiskDecisionV1 } from '../../src/domain/RiskDecision.js';
import { count, createIsolatedDatabase, seedAccount, seedPolicy, type IsolatedDatabase } from './support/database.js';
import { AGENT, executorPrincipal, harness, uniqueProposal, type Harness } from './support/harness.js';

let db: IsolatedDatabase;
let h: Harness;

beforeAll(async () => {
  db = await createIsolatedDatabase();
  await seedAccount(db.pool);
  await seedPolicy(db.pool);
});
afterAll(async () => db.drop());
beforeEach(() => {
  h = harness(db.pool);
});

async function authorize(): Promise<RiskDecisionV1> {
  const r = await h.evaluate.execute({ proposal: uniqueProposal(), authenticatedAgentId: AGENT });
  if (r.kind !== 'DECISION' || r.decision.status !== 'ALLOW_PAPER') throw new Error('esperava ALLOW_PAPER');
  return r.decision;
}

const status = async (reservationId: string | null) => {
  const { rows } = await db.pool.query<{ status: string }>('SELECT status FROM risk_reservations WHERE reservation_id = $1', [reservationId]);
  return rows[0]?.status;
};

const consume = (d: RiskDecisionV1, paperOrderId = `order-${d.decisionId}`) =>
  h.consume.execute({ principal: executorPrincipal(), decisionId: d.decisionId, accountId: d.accountId, paperOrderId, proposalHash: d.proposalHash });

describe('consumo da autorização (I-01, I-04)', () => {
  it('consome uma vez e é idempotente para a mesma ordem', async () => {
    const d = await authorize();
    expect(await consume(d, 'order-1')).toEqual({ kind: 'CONSUMED', reservationId: d.reservationId, replayed: false });
    expect(await consume(d, 'order-1')).toEqual({ kind: 'CONSUMED', reservationId: d.reservationId, replayed: true });
    expect(await status(d.reservationId)).toBe('CONSUMED');
    expect(await count(db.pool, 'risk_audit_events', `event_type = 'RESERVATION_CONSUMED' AND decision_id = $1`, [d.decisionId])).toBe(1);
  });

  it('segunda ordem diferente para a mesma autorização → conflito', async () => {
    const d = await authorize();
    await consume(d, 'order-a');
    expect(await consume(d, 'order-b')).toEqual({ kind: 'CONFLICT' });
  });

  it('mesma ordem simulada não consome duas autorizações', async () => {
    const [a, b] = [await authorize(), await authorize()];
    await consume(a, 'order-unica');
    expect(await consume(b, 'order-unica')).toEqual({ kind: 'CONFLICT' });
    expect(await status(b.reservationId)).toBe('ACTIVE');
  });

  it('UT-020, I-07: consumo após o TTL não autoriza e expira a reserva', async () => {
    const d = await authorize();
    h.clock.set(d.authorizationExpiresAt ?? '');
    expect(await consume(d)).toEqual({ kind: 'NOT_AUTHORIZED', reason: 'EXPIRED' });
    expect(await status(d.reservationId)).toBe('EXPIRED');
  });

  it('decisão BLOCK, inexistente ou de outra conta não é consumível', async () => {
    const r = await h.evaluate.execute({ proposal: uniqueProposal({ stopLossPrice: '100.02' }), authenticatedAgentId: AGENT });
    if (r.kind !== 'DECISION') throw new Error(r.kind);
    const d0 = r.decision;
    expect(await consume(r.decision)).toEqual({ kind: 'NOT_AUTHORIZED', reason: 'BLOCKED' });
    expect(await h.consume.execute({ principal: executorPrincipal(), decisionId: '00000000-0000-4000-8000-000000000000', accountId: 'paper-fixture', paperOrderId: 'x', proposalHash: d0.proposalHash })).toEqual({ kind: 'NOT_FOUND' });
    const d = await authorize();
    expect(await h.consume.execute({ principal: executorPrincipal(), decisionId: d.decisionId, accountId: 'outra', paperOrderId: 'x', proposalHash: d.proposalHash })).toEqual({ kind: 'FORBIDDEN' });
  });
});

describe('liberação', () => {
  it('libera uma única vez (idempotente) e não permite consumo depois', async () => {
    const d = await authorize();
    const id = d.reservationId ?? '';
    expect(await h.release.execute({ principal: executorPrincipal(), reservationId: id, reason: 'cancelado' })).toEqual({ kind: 'RELEASED', replayed: false });
    expect(await h.release.execute({ principal: executorPrincipal(), reservationId: id, reason: 'cancelado' })).toEqual({ kind: 'RELEASED', replayed: true });
    expect(await count(db.pool, 'risk_audit_events', `event_type = 'RESERVATION_RELEASED' AND reservation_id = $1`, [id])).toBe(1);
    expect(await consume(d)).toEqual({ kind: 'NOT_AUTHORIZED', reason: 'RELEASED' });
  });

  it('reserva consumida não pode ser liberada (dupla contabilização)', async () => {
    const d = await authorize();
    await consume(d);
    expect(await h.release.execute({ principal: executorPrincipal(), reservationId: d.reservationId ?? '', reason: 'x' })).toEqual({ kind: 'CONFLICT', status: 'CONSUMED' });
  });

  it('banco recusa transição fora da máquina de estados', async () => {
    const d = await authorize();
    await consume(d);
    await expect(db.pool.query(`UPDATE risk_reservations SET status = 'RELEASED', paper_order_id = NULL WHERE reservation_id = $1`, [d.reservationId])).rejects.toThrow(/transição/);
  });
});

describe('expiração', () => {
  it('varredura expira só reservas vencidas, uma vez, e devolve capacidade', async () => {
    const isolated = await createIsolatedDatabase();
    try {
      await seedAccount(isolated.pool);
      await seedPolicy(isolated.pool, { maxGrossExposureBase: '1.5' });
      const local = harness(isolated.pool);
      const run = () => local.evaluate.execute({ proposal: uniqueProposal(), authenticatedAgentId: AGENT });

      const first = await run();
      expect(first.kind === 'DECISION' && first.decision.status).toBe('ALLOW_PAPER');
      // Reserva vencida mas ainda ACTIVE continua ocupando capacidade (conservador).
      local.clock.set('2026-11-13T22:00:30.000Z');
      local.external.snapshot = { ...(local.external.snapshot ?? never()), asOf: '2026-11-13T22:00:29.000Z' };
      local.external.marketQuote = { ...(local.external.marketQuote ?? never()), asOf: '2026-11-13T22:00:29.500Z' };
      const proposal = uniqueProposal({ createdAt: '2026-11-13T22:00:20.000Z', expiresAt: '2026-11-13T22:01:00.000Z' });
      const blocked = await local.evaluate.execute({ proposal, authenticatedAgentId: AGENT });
      expect(blocked.kind === 'DECISION' && blocked.decision.violations.map((v) => v.code)).toContain('MAX_GROSS_EXPOSURE');

      expect(await local.expire.execute()).toBe(1);
      expect(await local.expire.execute()).toBe(0);

      const retry = uniqueProposal({ createdAt: '2026-11-13T22:00:20.000Z', expiresAt: '2026-11-13T22:01:00.000Z' });
      const allowed = await local.evaluate.execute({ proposal: retry, authenticatedAgentId: AGENT });
      expect(allowed.kind === 'DECISION' && allowed.decision.status).toBe('ALLOW_PAPER');
    } finally {
      await isolated.drop();
    }
  });
});

function never(): never {
  throw new Error('fixture ausente');
}

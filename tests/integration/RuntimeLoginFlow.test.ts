import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RiskDecisionV1 } from '../../src/domain/RiskDecision.js';
import { count, createIsolatedDatabase, createRuntimeLogin, seedAccount, seedPolicy, type IsolatedDatabase, type RuntimeLogin } from './support/database.js';
import { AGENT, agentPrincipal, executorPrincipal, harness, uniqueProposal, type Harness } from './support/harness.js';

// Prova de que o privilégio mínimo da 0003 (sem UPDATE/DELETE/TRUNCATE amplos) basta para os fluxos reais:
// todos os casos de uso rodam conectados como LOGIN DE RUNTIME; só o seed usa a conexão administrativa do teste.
let db: IsolatedDatabase;
let rt: RuntimeLogin;
let h: Harness;

beforeAll(async () => {
  db = await createIsolatedDatabase();
  await seedAccount(db.pool);
  await seedPolicy(db.pool);
  rt = await createRuntimeLogin(db);
  h = harness(rt.pool);
});
afterAll(async () => {
  await rt.drop();
  await db.drop();
});

async function authorize(): Promise<RiskDecisionV1> {
  const r = await h.evaluate.execute({ proposal: uniqueProposal(), authenticatedAgentId: AGENT });
  if (r.kind !== 'DECISION' || r.decision.status !== 'ALLOW_PAPER') throw new Error(`esperava ALLOW_PAPER: ${JSON.stringify(r)}`);
  return r.decision;
}
const status = async (id: string | null) => (await db.pool.query<{ status: string }>('SELECT status FROM risk_reservations WHERE reservation_id = $1', [id])).rows[0]?.status;
const consume = (d: RiskDecisionV1, paperOrderId: string) =>
  h.consume.execute({ principal: executorPrincipal(), decisionId: d.decisionId, accountId: d.accountId, paperOrderId, proposalHash: d.proposalHash });

describe('fluxos completos com o login de runtime (nenhum erro de privilégio)', () => {
  it('avaliação ALLOW_PAPER grava decisão, proposta, reserva e auditoria; get devolve a decisão', async () => {
    const before = await count(db.pool, 'risk_audit_events');
    const d = await authorize();
    expect(d.violations).toEqual([]);
    expect(await status(d.reservationId)).toBe('ACTIVE');
    expect(await count(db.pool, 'risk_audit_events')).toBeGreaterThan(before);
    const got = await h.get.execute({ decisionId: d.decisionId, principal: agentPrincipal() });
    expect(got.kind).toBe('FOUND');
  });

  it('BLOCK não grava reserva; replay idempotente devolve a mesma decisão; chave com outro conteúdo → conflito', async () => {
    const proposal = uniqueProposal({ stopLossPrice: '100.02' });
    const first = await h.evaluate.execute({ proposal, authenticatedAgentId: AGENT });
    if (first.kind !== 'DECISION') throw new Error(first.kind);
    expect(first.decision.status).toBe('BLOCK');
    expect(first.decision.reservationId).toBeNull();
    const again = await h.evaluate.execute({ proposal, authenticatedAgentId: AGENT });
    expect(again).toMatchObject({ kind: 'DECISION', replayed: true });
    const conflict = await h.evaluate.execute({ proposal: { ...proposal, quantity: '0.02' }, authenticatedAgentId: AGENT });
    expect(conflict).toEqual({ kind: 'IDEMPOTENCY_CONFLICT' });
    expect(await count(db.pool, 'risk_reservations', 'decision_id = $1', [first.decision.decisionId])).toBe(0);
  });

  it('consume (idempotente), conflito com outra ordem, release, release de consumida', async () => {
    const d = await authorize();
    expect(await consume(d, 'order-rt-1')).toEqual({ kind: 'CONSUMED', reservationId: d.reservationId, replayed: false });
    expect(await consume(d, 'order-rt-1')).toMatchObject({ kind: 'CONSUMED', replayed: true });
    expect(await consume(d, 'order-rt-2')).toEqual({ kind: 'CONFLICT' });
    expect(await status(d.reservationId)).toBe('CONSUMED');
    expect(await h.release.execute({ principal: executorPrincipal(), reservationId: d.reservationId ?? '', reason: 'x' })).toEqual({ kind: 'CONFLICT', status: 'CONSUMED' });

    const r = await authorize();
    expect(await h.release.execute({ principal: executorPrincipal(), reservationId: r.reservationId ?? '', reason: 'cancelado' })).toEqual({ kind: 'RELEASED', replayed: false });
    expect(await status(r.reservationId)).toBe('RELEASED');
  });

  it('expiração por consume após o TTL e pela varredura (ExpireRiskReservations) funcionam com UPDATE só em 3 colunas', async () => {
    const a = await authorize();
    const b = await authorize();
    h.clock.set(a.authorizationExpiresAt ?? '');
    expect(await consume(a, 'order-rt-late')).toEqual({ kind: 'NOT_AUTHORIZED', reason: 'EXPIRED' });
    expect(await status(a.reservationId)).toBe('EXPIRED');
    expect(await h.expire.execute()).toBeGreaterThanOrEqual(1);
    expect(await status(b.reservationId)).toBe('EXPIRED');
    h.clock.set('2026-11-13T22:00:00.000Z');
  });

  it.each([1, 2, 3])('rodada %i: 8 consumos concorrentes da mesma autorização com ordens diferentes → exatamente 1 CONSUMED', async () => {
    const d = await authorize();
    const results = await Promise.all(Array.from({ length: 8 }, (_v, i) => consume(d, `order-par-${randomUUID()}-${i}`)));
    expect(results.filter((r) => r.kind === 'CONSUMED')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'CONFLICT')).toHaveLength(7);
    expect(await status(d.reservationId)).toBe('CONSUMED');
  });

  it('o login de runtime continua sem poder apagar nem alterar o histórico após os fluxos', async () => {
    for (const sql of ['DELETE FROM risk_decisions', 'UPDATE risk_decisions SET status = status', 'TRUNCATE risk_audit_events', 'DELETE FROM risk_reservations']) {
      await expect(rt.pool.query(sql), sql).rejects.toMatchObject({ code: '42501' });
    }
  });
});

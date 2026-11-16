import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RiskUnitOfWork } from '../../src/application/ports/RiskUnitOfWork.js';
import type { TransactionManager } from '../../src/application/ports/TransactionManager.js';
import { PgTransactionManager } from '../../src/infrastructure/postgres/PgTransactionManager.js';
import { validProposal } from '../fixtures/proposals.js';
import { count, createIsolatedDatabase, seedAccount, seedPolicy, type IsolatedDatabase } from './support/database.js';
import { AGENT, harness, TEST_DB_TIMEOUTS, uniqueProposal, type Harness } from './support/harness.js';

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

const evaluate = (proposal: unknown, agent = AGENT) => h.evaluate.execute({ proposal, authenticatedAgentId: agent });

describe('ALLOW_PAPER atômico (UT-013)', () => {
  it('persiste proposta, decisão, reserva, auditoria e outbox no mesmo commit', async () => {
    const proposal = uniqueProposal();
    const r = await evaluate(proposal);
    expect(r.kind).toBe('DECISION');
    if (r.kind !== 'DECISION') return;
    const d = r.decision;
    expect(d.status).toBe('ALLOW_PAPER');
    expect(d.reservationId).not.toBeNull();
    expect(d.authorizationExpiresAt).toBe('2026-11-13T22:00:30.000Z');

    expect(await count(db.pool, 'trade_proposals', 'proposal_id = $1', [d.proposalId])).toBe(1);
    expect(await count(db.pool, 'risk_decisions', `decision_id = $1 AND status = 'ALLOW_PAPER'`, [d.decisionId])).toBe(1);
    expect(await count(db.pool, 'risk_reservations', `reservation_id = $1 AND status = 'ACTIVE' AND exposure_base = 1.0001`, [d.reservationId])).toBe(1);
    expect(await count(db.pool, 'risk_audit_events', 'decision_id = $1', [d.decisionId])).toBe(2);
    expect(await count(db.pool, 'risk_outbox', 'aggregate_id = $1', [d.decisionId])).toBe(1);
  });

  it('auditoria e outbox não guardam o payload da proposta', async () => {
    const r = await evaluate(uniqueProposal({ strategyId: 'strategy-segredo-xyz' }));
    if (r.kind !== 'DECISION') throw new Error(r.kind);
    const { rows } = await db.pool.query<{ t: string }>(
      `SELECT details_json::text AS t FROM risk_audit_events WHERE decision_id = $1::uuid
       UNION ALL SELECT payload_json::text FROM risk_outbox WHERE aggregate_id = $1::text`,
      [r.decision.decisionId],
    );
    expect(rows.map((x) => x.t).join()).not.toMatch(/segredo|stopLossPrice|quantity/);
  });
});

describe('BLOCK persistido', () => {
  it('bloqueio é gravado sem reserva', async () => {
    const r = await evaluate(uniqueProposal({ stopLossPrice: '100.02' }));
    if (r.kind !== 'DECISION') throw new Error(r.kind);
    expect(r.decision.status).toBe('BLOCK');
    expect(r.decision.violations.map((v) => v.code)).toContain('INVALID_STOP_LOSS');
    expect(await count(db.pool, 'risk_reservations', 'decision_id = $1', [r.decision.decisionId])).toBe(0);
  });

  it('cotação indisponível → BLOCK MARKET_DATA_UNAVAILABLE (UT-004)', async () => {
    h.external.marketQuote = null;
    const r = await evaluate(uniqueProposal());
    expect(r.kind === 'DECISION' && r.decision.violations.map((v) => v.code)).toEqual(['MARKET_DATA_UNAVAILABLE']);
  });

  it('snapshot indisponível → BLOCK ACCOUNT_SNAPSHOT_STALE', async () => {
    h.external.snapshot = null;
    const r = await evaluate(uniqueProposal());
    expect(r.kind === 'DECISION' && r.decision.violations.map((v) => v.code)).toEqual(['ACCOUNT_SNAPSHOT_STALE']);
  });

  it('conta inexistente no servidor → sem grant: REJECTED/FORBIDDEN, nada gravado', async () => {
    const before = await count(db.pool, 'risk_decisions');
    const r = await evaluate(uniqueProposal({ accountId: 'paper-desconhecida' }));
    expect(r.kind === 'REJECTED' && r.reason).toBe('FORBIDDEN');
    expect(await count(db.pool, 'risk_decisions')).toBe(before);
  });
});

describe('rejeições sem persistência (UT-015, UT-016, UT-003)', () => {
  it.each([
    ['sem identidade', uniqueProposal(), '', 'UNAUTHENTICATED'],
    ['agentId divergente', uniqueProposal(), 'agent-fixture-forex', 'FORBIDDEN'],
    ['agente fora da allowlist', uniqueProposal({ agentId: 'intruso' }), 'intruso', 'FORBIDDEN'],
    ['ambiente LIVE', uniqueProposal({ environment: 'LIVE' }), AGENT, 'INVALID_CONTRACT'],
    ['quantidade exponencial', uniqueProposal({ quantity: '1e-2' }), AGENT, 'INVALID_CONTRACT'],
  ])('%s → REJECTED %s e nada gravado', async (_label, proposal, agent, reason) => {
    const before = await count(db.pool, 'trade_proposals');
    const r = await evaluate(proposal, agent);
    expect(r).toMatchObject({ kind: 'REJECTED', reason });
    expect(await count(db.pool, 'trade_proposals')).toBe(before);
  });

  it('agente não consegue ocupar a chave idempotente de outro', async () => {
    const victim = uniqueProposal();
    await evaluate({ ...victim, agentId: 'agent-fixture-forex' }, 'agent-fixture-crypto');
    const r = await evaluate(victim);
    expect(r.kind === 'DECISION' && r.decision.status).toBe('ALLOW_PAPER');
  });
});

describe('idempotência (UT-018, UT-019)', () => {
  it('payload idêntico devolve a decisão original sem segunda reserva', async () => {
    const proposal = uniqueProposal();
    const first = await evaluate(proposal);
    const second = await evaluate(structuredClone(proposal));
    if (first.kind !== 'DECISION' || second.kind !== 'DECISION') throw new Error('esperava decisões');
    expect(second.replayed).toBe(true);
    expect(second.decision).toEqual(first.decision);
    expect(await count(db.pool, 'risk_reservations', 'decision_id = $1', [first.decision.decisionId])).toBe(1);
  });

  it('replay devolve a decisão original mesmo após o mercado mudar', async () => {
    const proposal = uniqueProposal();
    const first = await evaluate(proposal);
    h.external.marketQuote = null;
    const second = await evaluate(proposal);
    expect(second.kind === 'DECISION' && second.decision).toEqual(first.kind === 'DECISION' && first.decision);
  });

  it('mesma chave com payload diferente → conflito, sem nova decisão', async () => {
    const proposal = uniqueProposal();
    await evaluate(proposal);
    const decisions = await count(db.pool, 'risk_decisions');
    const r = await evaluate({ ...proposal, quantity: '0.02' });
    expect(r).toEqual({ kind: 'IDEMPOTENCY_CONFLICT' });
    expect(await count(db.pool, 'risk_decisions')).toBe(decisions);
    expect(await count(db.pool, 'risk_audit_events', `event_type = 'IDEMPOTENCY_CONFLICT' AND proposal_id = $1`, [proposal['proposalId']])).toBe(1);
  });

  it('proposalId reaproveitado com outra chave → conflito', async () => {
    const proposal = uniqueProposal();
    await evaluate(proposal);
    expect(await evaluate({ ...proposal, idempotencyKey: 'outra-chave' })).toEqual({ kind: 'IDEMPOTENCY_CONFLICT' });
  });
});

describe('falhas → nenhuma autorização (UT-014, I-05, ADR-0006)', () => {
  function failingAt(method: keyof RiskUnitOfWork): TransactionManager {
    const real = new PgTransactionManager(db.pool, TEST_DB_TIMEOUTS);
    return {
      run: (work) =>
        real.run((uow) =>
          work(
            new Proxy(uow, {
              get(target, prop, receiver) {
                if (prop === method) return () => Promise.reject(new Error(`falha simulada em ${method}`));
                return Reflect.get(target, prop, receiver) as unknown;
              },
            }),
          ),
        ),
    };
  }

  it.each(['insertReservation', 'insertDecision', 'appendAudit', 'appendOutbox'] as const)(
    'falha em %s antes do commit → UNAVAILABLE e rollback completo',
    async (method) => {
      const failing = harness(db.pool, failingAt(method));
      const proposal = uniqueProposal();
      const r = await failing.evaluate.execute({ proposal, authenticatedAgentId: AGENT });
      expect(r).toEqual({ kind: 'UNAVAILABLE' });
      expect(await count(db.pool, 'trade_proposals', 'proposal_id = $1', [proposal['proposalId']])).toBe(0);
      expect(await count(db.pool, 'risk_reservations r JOIN risk_decisions d USING (decision_id)', 'd.proposal_id = $1', [proposal['proposalId']])).toBe(0);
    },
  );

  it('falha da fonte de snapshot → UNAVAILABLE, nada gravado', async () => {
    h.external.failSnapshot = true;
    const proposal = uniqueProposal();
    expect(await evaluate(proposal)).toEqual({ kind: 'UNAVAILABLE' });
    expect(await count(db.pool, 'trade_proposals', 'proposal_id = $1', [proposal['proposalId']])).toBe(0);
  });

  it('banco inacessível → UNAVAILABLE', async () => {
    const { default: pg } = await import('pg');
    const dead = new pg.Pool({ connectionString: 'postgres://x:y@127.0.0.1:1/nada_test', connectionTimeoutMillis: 500 });
    const offline = harness(dead);
    expect(await offline.evaluate.execute({ proposal: validProposal(), authenticatedAgentId: AGENT })).toEqual({ kind: 'UNAVAILABLE' });
    await dead.end();
  });
});

describe('reservas pendentes e política', () => {
  it('reservas ativas contam na exposição das avaliações seguintes', async () => {
    const isolated = await createIsolatedDatabase();
    try {
      await seedAccount(isolated.pool);
      // Limite bruto comporta 2 ordens de 1.0001, não 3.
      await seedPolicy(isolated.pool, { maxGrossExposureBase: '2.5' });
      const local = harness(isolated.pool);
      const statuses = [];
      for (let i = 0; i < 3; i++) {
        const r = await local.evaluate.execute({ proposal: uniqueProposal(), authenticatedAgentId: AGENT });
        statuses.push(r.kind === 'DECISION' ? r.decision.status : r.kind);
      }
      expect(statuses).toEqual(['ALLOW_PAPER', 'ALLOW_PAPER', 'BLOCK']);
    } finally {
      await isolated.drop();
    }
  });

  it('cada decisão referencia a versão completa de política vigente quando foi avaliada', async () => {
    const isolated = await createIsolatedDatabase();
    try {
      await seedAccount(isolated.pool);
      const v1 = await seedPolicy(isolated.pool, { version: '1.0.0-fixture' });
      const local = harness(isolated.pool);
      const a = await local.evaluate.execute({ proposal: uniqueProposal(), authenticatedAgentId: AGENT });

      await isolated.pool.query(`UPDATE risk_policies SET active = false WHERE version = '1.0.0-fixture'`);
      const v2 = await seedPolicy(isolated.pool, { version: '2.0.0-fixture', maxOrderNotionalBase: '1' });
      const b = await local.evaluate.execute({ proposal: uniqueProposal(), authenticatedAgentId: AGENT });

      if (a.kind !== 'DECISION' || b.kind !== 'DECISION') throw new Error('esperava decisões');
      expect([a.decision.policyVersion, a.decision.policyHash]).toEqual([v1.version, v1.policyHash]);
      expect([b.decision.policyVersion, b.decision.policyHash]).toEqual([v2.version, v2.policyHash]);
      expect(b.decision.violations.map((v) => v.code)).toEqual(['MAX_ORDER_NOTIONAL']);
    } finally {
      await isolated.drop();
    }
  });
});

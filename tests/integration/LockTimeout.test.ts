import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RiskDecisionV1 } from '../../src/domain/RiskDecision.js';
import { PgTransactionManager } from '../../src/infrastructure/postgres/PgTransactionManager.js';
import { count, createIsolatedDatabase, seedAccount, seedPolicy, type IsolatedDatabase } from './support/database.js';
import { AGENT, executorPrincipal, harness, TEST_DB_TIMEOUTS, uniqueProposal } from './support/harness.js';

// lockTimeoutMs pequeno e FICTÍCIO, só para provocar a espera pelo lock da conta.
const SHORT_LOCK_MS = 300;
const MAX_WAIT_MS = 5000;

let db: IsolatedDatabase;
beforeAll(async () => {
  db = await createIsolatedDatabase();
  await seedAccount(db.pool);
  await seedPolicy(db.pool);
});
afterAll(async () => db.drop());

/** Segura o lock advisory da conta numa transação aberta, como uma avaliação concorrente lenta. */
async function holdAccountLock(accountId = 'paper-fixture'): Promise<{ release(): Promise<void> }> {
  const client: pg.PoolClient = await db.pool.connect();
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [accountId]);
  return {
    async release() {
      await client.query('ROLLBACK');
      client.release();
    },
  };
}

describe('lock da conta com timeout curto', () => {
  it('evaluate, consume e release devolvem UNAVAILABLE rápido e nada é gravado; depois do lock, voltam a funcionar', async () => {
    const normal = harness(db.pool);
    const first = await normal.evaluate.execute({ proposal: uniqueProposal(), authenticatedAgentId: AGENT });
    if (first.kind !== 'DECISION' || first.decision.status !== 'ALLOW_PAPER') throw new Error('esperava ALLOW_PAPER');
    const d: RiskDecisionV1 = first.decision;

    const slow = harness(db.pool, new PgTransactionManager(db.pool, { statementTimeoutMs: TEST_DB_TIMEOUTS.statementTimeoutMs, lockTimeoutMs: SHORT_LOCK_MS }));
    const before = {
      proposals: await count(db.pool, 'trade_proposals'),
      decisions: await count(db.pool, 'risk_decisions'),
      reservations: await count(db.pool, 'risk_reservations'),
      audit: await count(db.pool, 'risk_audit_events'),
      outbox: await count(db.pool, 'risk_outbox'),
    };

    const lock = await holdAccountLock();
    try {
      const started = Date.now();
      const evaluated = await slow.evaluate.execute({ proposal: uniqueProposal(), authenticatedAgentId: AGENT });
      const consumed = await slow.consume.execute({
        principal: executorPrincipal(),
        decisionId: d.decisionId,
        accountId: d.accountId,
        paperOrderId: 'order-locked',
        proposalHash: d.proposalHash,
      });
      const released = await slow.release.execute({ principal: executorPrincipal(), reservationId: d.reservationId ?? '', reason: 'x' });
      expect(Date.now() - started).toBeLessThan(MAX_WAIT_MS);
      expect(evaluated).toEqual({ kind: 'UNAVAILABLE' });
      expect(consumed).toEqual({ kind: 'UNAVAILABLE' });
      expect(released).toEqual({ kind: 'UNAVAILABLE' });
    } finally {
      await lock.release();
    }

    expect({
      proposals: await count(db.pool, 'trade_proposals'),
      decisions: await count(db.pool, 'risk_decisions'),
      reservations: await count(db.pool, 'risk_reservations'),
      audit: await count(db.pool, 'risk_audit_events'),
      outbox: await count(db.pool, 'risk_outbox'),
    }).toEqual(before);
    const { rows } = await db.pool.query<{ status: string }>('SELECT status FROM risk_reservations WHERE reservation_id = $1', [d.reservationId]);
    expect(rows[0]?.status).toBe('ACTIVE');
    expect(slow.logger.entries.filter((e) => e.level === 'error').map((e) => e.event).sort()).toEqual([
      'consume.unavailable',
      'evaluate.unavailable',
      'release.unavailable',
    ]);

    // Sem o lock, o mesmo gerenciador volta a operar (o pool não ficou preso).
    const again = await slow.consume.execute({ principal: executorPrincipal(), decisionId: d.decisionId, accountId: d.accountId, paperOrderId: 'order-after', proposalHash: d.proposalHash });
    expect(again).toMatchObject({ kind: 'CONSUMED' });
  });
});

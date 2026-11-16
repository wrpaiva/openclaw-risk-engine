import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { count, createIsolatedDatabase, seedAccount, seedPolicy, type IsolatedDatabase } from '../integration/support/database.js';
import { AGENT, executorPrincipal, harness, uniqueProposal } from '../integration/support/harness.js';

// Concorrência real: cada chamada usa sua própria conexão do pool (SPEC §9.2, I-03, I-04).
const PARALLEL = 12;

let db: IsolatedDatabase;
beforeEach(async () => {
  db = await createIsolatedDatabase(PARALLEL + 2);
  await seedAccount(db.pool);
});
afterEach(async () => db.drop());

const statuses = (results: Awaited<ReturnType<ReturnType<typeof harness>['evaluate']['execute']>>[]) =>
  results.map((r) => (r.kind === 'DECISION' ? r.decision.status : r.kind));

describe('concorrência', () => {
  it('propostas válidas isoladamente mas não em conjunto: limite nunca é ultrapassado', async () => {
    // 3 ordens de 1.0001 cabem em 3.5; 12 simultâneas não.
    await seedPolicy(db.pool, { maxGrossExposureBase: '3.5' });
    const h = harness(db.pool);
    const results = await Promise.all(
      Array.from({ length: PARALLEL }, () => h.evaluate.execute({ proposal: uniqueProposal(), authenticatedAgentId: AGENT })),
    );
    const s = statuses(results);
    expect(s.filter((x) => x === 'ALLOW_PAPER')).toHaveLength(3);
    expect(s.filter((x) => x === 'BLOCK')).toHaveLength(PARALLEL - 3);
    const { rows } = await db.pool.query<{ total: string }>(`SELECT SUM(exposure_base)::text AS total FROM risk_reservations WHERE status = 'ACTIVE'`);
    expect(Number(rows[0]?.total)).toBeLessThanOrEqual(3.5);
  });

  it('mesma proposta repetida simultaneamente: uma decisão, uma reserva, mesma resposta', async () => {
    await seedPolicy(db.pool);
    const h = harness(db.pool);
    const proposal = uniqueProposal();
    const results = await Promise.all(
      Array.from({ length: PARALLEL }, () => h.evaluate.execute({ proposal: structuredClone(proposal), authenticatedAgentId: AGENT })),
    );
    const ids = new Set(results.map((r) => (r.kind === 'DECISION' ? r.decision.decisionId : r.kind)));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.kind === 'DECISION' && !r.replayed)).toHaveLength(1);
    expect(await count(db.pool, 'risk_decisions')).toBe(1);
    expect(await count(db.pool, 'risk_reservations')).toBe(1);
  });

  it('mesma chave com payloads diferentes simultâneos: uma decisão, demais em conflito', async () => {
    await seedPolicy(db.pool);
    const h = harness(db.pool);
    const base = uniqueProposal();
    const results = await Promise.all(
      Array.from({ length: PARALLEL }, (_, i) =>
        // Quantidades todas distintas (múltiplos do lote): nenhum payload repetido.
        h.evaluate.execute({ proposal: { ...base, quantity: `0.${String(i + 1).padStart(4, '0')}` }, authenticatedAgentId: AGENT }),
      ),
    );
    expect(results.filter((r) => r.kind === 'DECISION')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'IDEMPOTENCY_CONFLICT')).toHaveLength(PARALLEL - 1);
    expect(await count(db.pool, 'risk_decisions')).toBe(1);
    expect(await count(db.pool, 'risk_reservations')).toBeLessThanOrEqual(1);
  });

  it('consumo simultâneo da mesma autorização por ordens diferentes: só um vence', async () => {
    await seedPolicy(db.pool);
    const h = harness(db.pool);
    const r = await h.evaluate.execute({ proposal: uniqueProposal(), authenticatedAgentId: AGENT });
    if (r.kind !== 'DECISION') throw new Error(r.kind);
    const results = await Promise.all(
      Array.from({ length: PARALLEL }, (_, i) =>
        h.consume.execute({ principal: executorPrincipal(), decisionId: r.decision.decisionId, accountId: r.decision.accountId, paperOrderId: `order-${i}`, proposalHash: r.decision.proposalHash }),
      ),
    );
    expect(results.filter((x) => x.kind === 'CONSUMED')).toHaveLength(1);
    expect(results.filter((x) => x.kind === 'CONFLICT')).toHaveLength(PARALLEL - 1);
  });

  it('liberação e consumo simultâneos: exatamente um efeito', async () => {
    await seedPolicy(db.pool);
    const h = harness(db.pool);
    const r = await h.evaluate.execute({ proposal: uniqueProposal(), authenticatedAgentId: AGENT });
    if (r.kind !== 'DECISION') throw new Error(r.kind);
    const [released, consumed] = await Promise.all([
      h.release.execute({ principal: executorPrincipal(), reservationId: r.decision.reservationId ?? '', reason: 'cancelado' }),
      h.consume.execute({ principal: executorPrincipal(), decisionId: r.decision.decisionId, accountId: r.decision.accountId, paperOrderId: 'order-x', proposalHash: r.decision.proposalHash }),
    ]);
    const effects = [released.kind === 'RELEASED' && !released.replayed, consumed.kind === 'CONSUMED'].filter(Boolean);
    expect(effects).toHaveLength(1);
  });
});

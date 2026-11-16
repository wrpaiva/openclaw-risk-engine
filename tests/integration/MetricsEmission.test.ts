import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EvaluateTradeRisk } from '../../src/application/EvaluateTradeRisk.js';
import { LogMetrics } from '../../src/infrastructure/metrics/LogMetrics.js';
import { PgTransactionManager } from '../../src/infrastructure/postgres/PgTransactionManager.js';
import { CryptoIdGenerator } from '../../src/infrastructure/system/CryptoIdGenerator.js';
import { createRiskEvaluator } from '../../src/rules/RiskEvaluator.js';
import { FIXTURE_SKEW_MS } from '../fixtures/evaluation.js';
import { createIsolatedDatabase, seedAccount, seedPolicy, type IsolatedDatabase } from './support/database.js';
import { AGENT, CapturingLogger, FakeExternal, MutableClock, TEST_DB_TIMEOUTS, uniqueProposal } from './support/harness.js';

// Emissões de métrica da avaliação sobre PostgreSQL real; só enums/contagens/durações, nunca ids.
let db: IsolatedDatabase;
beforeAll(async () => {
  db = await createIsolatedDatabase();
  await seedAccount(db.pool);
  await seedPolicy(db.pool);
});
afterAll(async () => db.drop());

function build(pool: pg.Pool, withMetrics: boolean) {
  const logger = new CapturingLogger();
  const external = new FakeExternal();
  const useCase = new EvaluateTradeRisk({
    transactions: new PgTransactionManager(pool, TEST_DB_TIMEOUTS),
    evaluator: createRiskEvaluator(),
    snapshots: external,
    marketData: external,
    catalog: external,
    clock: new MutableClock(),
    ids: new CryptoIdGenerator(),
    logger: new CapturingLogger(),
    clockSkewToleranceMs: FIXTURE_SKEW_MS,
    ...(withMetrics ? { metrics: new LogMetrics(logger) } : {}),
  });
  return { useCase, logger, external };
}
const metricEvents = (logger: CapturingLogger) => logger.entries.map((e) => `${e.event}:${e.fields.outcome ?? ''}:${(e.fields.violationCodes ?? []).join('+')}`);

describe('métricas da avaliação', () => {
  it('ALLOW_PAPER → metric.evaluation(NONE) + duração; sem ids nos campos', async () => {
    const { useCase, logger } = build(db.pool, true);
    const r = await useCase.execute({ proposal: uniqueProposal(), authenticatedAgentId: AGENT });
    expect(r).toMatchObject({ kind: 'DECISION', decision: { status: 'ALLOW_PAPER' } });
    expect(metricEvents(logger)).toEqual(['metric.evaluation:ALLOW_PAPER:NONE', 'metric.evaluation_duration::']);
    const durationMs = logger.entries[1]?.fields.durationMs;
    expect(typeof durationMs === 'number' && durationMs >= 0).toBe(true);
    const text = JSON.stringify(logger.entries);
    expect(text).not.toMatch(/paper-fixture|agent-fixture|corr-fixture|idem-/);
    if (r.kind === 'DECISION') expect(text).not.toContain(r.decision.decisionId);
  });

  it('BLOCK → uma metric.evaluation por código de violação', async () => {
    const { useCase, logger } = build(db.pool, true);
    const r = await useCase.execute({ proposal: uniqueProposal({ stopLossPrice: '100.02' }), authenticatedAgentId: AGENT });
    if (r.kind !== 'DECISION') throw new Error(r.kind);
    const codes = r.decision.violations.map((v) => v.code);
    expect(codes.length).toBeGreaterThan(0);
    expect(metricEvents(logger).filter((e) => e.startsWith('metric.evaluation:BLOCK'))).toEqual(codes.map((c) => `metric.evaluation:BLOCK:${c}`));
    expect(metricEvents(logger).at(-1)).toBe('metric.evaluation_duration::');
  });

  it('replay idempotente → só idempotency_replay (sem recontar avaliação); conflito → transport_error CONFLICT', async () => {
    const { useCase, logger } = build(db.pool, true);
    const proposal = uniqueProposal();
    await useCase.execute({ proposal, authenticatedAgentId: AGENT });
    logger.entries.length = 0;
    expect(await useCase.execute({ proposal, authenticatedAgentId: AGENT })).toMatchObject({ kind: 'DECISION', replayed: true });
    expect(metricEvents(logger)).toEqual(['metric.idempotency_replay::']);
    logger.entries.length = 0;
    expect(await useCase.execute({ proposal: { ...proposal, quantity: '0.02' }, authenticatedAgentId: AGENT })).toEqual({ kind: 'IDEMPOTENCY_CONFLICT' });
    expect(logger.entries.map((e) => [e.event, e.fields.outcome])).toEqual([['metric.transport_error', 'CONFLICT']]);
  });

  it('contrato inválido → CONTRACT; agente diferente do autenticado → AUTH; nada é gravado', async () => {
    const { useCase, logger } = build(db.pool, true);
    expect((await useCase.execute({ proposal: uniqueProposal({ quantity: '1e3' }), authenticatedAgentId: AGENT })).kind).toBe('REJECTED');
    expect((await useCase.execute({ proposal: uniqueProposal(), authenticatedAgentId: 'agent-outro' })).kind).toBe('REJECTED');
    expect(logger.entries.map((e) => [e.event, e.fields.outcome])).toEqual([
      ['metric.transport_error', 'CONTRACT'],
      ['metric.transport_error', 'AUTH'],
    ]);
  });

  it('banco indisponível → transport_error UNAVAILABLE e nenhuma metric.evaluation', async () => {
    const dead = new pg.Pool({ connectionString: db.url, max: 1 });
    dead.on('error', () => undefined);
    await dead.end();
    const { useCase, logger } = build(dead, true);
    expect(await useCase.execute({ proposal: uniqueProposal(), authenticatedAgentId: AGENT })).toEqual({ kind: 'UNAVAILABLE' });
    expect(logger.entries.map((e) => [e.event, e.fields.outcome])).toEqual([['metric.transport_error', 'UNAVAILABLE']]);
  });

  it('sem coletor injetado o resultado é idêntico (mesmo status e violações)', async () => {
    const withMetrics = await build(db.pool, true).useCase.execute({ proposal: uniqueProposal({ stopLossPrice: '100.02' }), authenticatedAgentId: AGENT });
    const without = await build(db.pool, false).useCase.execute({ proposal: uniqueProposal({ stopLossPrice: '100.02' }), authenticatedAgentId: AGENT });
    if (withMetrics.kind !== 'DECISION' || without.kind !== 'DECISION') throw new Error('esperava DECISION');
    expect(without.decision.status).toBe(withMetrics.decision.status);
    expect(without.decision.violations.map((v) => v.code)).toEqual(withMetrics.decision.violations.map((v) => v.code));
  });
});

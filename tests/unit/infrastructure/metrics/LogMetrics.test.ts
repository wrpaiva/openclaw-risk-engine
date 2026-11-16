import { describe, expect, it, vi } from 'vitest';
import { ConsumePaperAuthorization } from '../../../../src/application/ConsumePaperAuthorization.js';
import { NoopMetrics } from '../../../../src/application/NoopMetrics.js';
import { ReleaseRiskReservation } from '../../../../src/application/ReleaseRiskReservation.js';
import { safeMetrics } from '../../../../src/application/SafeMetrics.js';
import type { LogFields, Logger } from '../../../../src/application/ports/Logger.js';
import type { ReservationRecord, RiskUnitOfWork } from '../../../../src/application/ports/RiskUnitOfWork.js';
import type { RiskMetrics } from '../../../../src/application/ports/RiskMetrics.js';
import { LogMetrics } from '../../../../src/infrastructure/metrics/LogMetrics.js';
import { CapturingLogger, MutableClock } from '../../../integration/support/harness.js';

// Tudo FICTÍCIO. Métricas derivadas de log: só enums, contagens e durações; nunca ids.
const ALLOWED_KEYS = new Set(['outcome', 'violationCodes', 'count', 'durationMs', 'op', 'kind']);
const ID_FIELDS = ['requestId', 'correlationId', 'proposalId', 'decisionId', 'reservationId', 'principalId', 'accountId', 'route', 'httpStatus', 'errorKind'];

function callAll(m: RiskMetrics): void {
  m.evaluation('ALLOW_PAPER', 'NONE');
  m.evaluation('BLOCK', 'MARKET_DATA_STALE');
  m.evaluationDuration(0.25);
  m.transportError('AUTH');
  m.transportError('CONTRACT');
  m.transportError('CONFLICT');
  m.transportError('UNAVAILABLE');
  m.reservationConflict('CONSUME');
  m.reservationOp('RELEASE', 'OK');
  m.dependencyFailure('DATABASE');
  m.idempotencyReplay();
}

describe('LogMetrics: formato dos eventos', () => {
  it('cada método emite um evento metric.* em info com campos esperados', () => {
    const logger = new CapturingLogger();
    const m = new LogMetrics(logger);
    callAll(m);
    expect(logger.entries.map((e) => [e.level, e.event, e.fields])).toEqual([
      ['info', 'metric.evaluation', { outcome: 'ALLOW_PAPER', violationCodes: ['NONE'], count: 1 }],
      ['info', 'metric.evaluation', { outcome: 'BLOCK', violationCodes: ['MARKET_DATA_STALE'], count: 1 }],
      ['info', 'metric.evaluation_duration', { durationMs: 250 }],
      ['info', 'metric.transport_error', { outcome: 'AUTH', count: 1 }],
      ['info', 'metric.transport_error', { outcome: 'CONTRACT', count: 1 }],
      ['info', 'metric.transport_error', { outcome: 'CONFLICT', count: 1 }],
      ['info', 'metric.transport_error', { outcome: 'UNAVAILABLE', count: 1 }],
      ['info', 'metric.reservation_conflict', { op: 'CONSUME', count: 1 }],
      ['info', 'metric.reservation_op', { op: 'RELEASE', outcome: 'OK', count: 1 }],
      ['info', 'metric.dependency_failure', { kind: 'DATABASE', count: 1 }],
      ['info', 'metric.idempotency_replay', { count: 1 }],
    ]);
  });

  it('só campos de enum/contagem/duração; nunca ids nem rota/erro', () => {
    const logger = new CapturingLogger();
    callAll(new LogMetrics(logger));
    for (const e of logger.entries) {
      expect(e.event.startsWith('metric.')).toBe(true);
      for (const key of Object.keys(e.fields)) expect(ALLOWED_KEYS.has(key), `${e.event}.${key}`).toBe(true);
      for (const id of ID_FIELDS) expect(e.fields, `${e.event} não tem ${id}`).not.toHaveProperty(id);
    }
  });

  it('a duração é convertida de segundos para milissegundos sem usar texto', () => {
    const logger = new CapturingLogger();
    new LogMetrics(logger).evaluationDuration(0.0015);
    expect(logger.entries[0]?.fields.durationMs).toBeCloseTo(1.5, 10);
    expect(typeof logger.entries[0]?.fields.durationMs).toBe('number');
  });

  it('nunca lança, mesmo com logger que lança em todos os níveis', () => {
    const boom = (): never => {
      throw new Error('logger quebrado');
    };
    const logger: Logger = { info: boom, warn: boom, error: boom };
    expect(() => {
      callAll(new LogMetrics(logger));
    }).not.toThrow();
  });

  it('logger que lança só na 3a chamada não impede as demais', () => {
    const entries: string[] = [];
    let n = 0;
    const logger: Logger = {
      info: (event: string) => {
        n += 1;
        if (n === 3) throw new Error('x');
        entries.push(event);
      },
      warn: () => undefined,
      error: () => undefined,
    };
    callAll(new LogMetrics(logger));
    expect(entries).toHaveLength(10);
  });
});

describe('safeMetrics', () => {
  it('sem coletor: no-op que não lança', () => {
    expect(() => {
      callAll(safeMetrics(undefined));
    }).not.toThrow();
  });

  it('engole exceção de cada método do coletor', () => {
    const boom = vi.fn(() => {
      throw new Error('coletor quebrado');
    });
    const collector: RiskMetrics = {
      evaluation: boom,
      evaluationDuration: boom,
      transportError: boom,
      reservationConflict: boom,
      reservationOp: boom,
      dependencyFailure: boom,
      idempotencyReplay: boom,
    };
    expect(() => {
      callAll(safeMetrics(collector));
    }).not.toThrow();
    expect(boom).toHaveBeenCalledTimes(11);
  });

  it('encaminha os argumentos ao coletor', () => {
    const logger = new CapturingLogger();
    callAll(safeMetrics(new LogMetrics(logger)));
    expect(logger.entries).toHaveLength(11);
    expect(new NoopMetrics()).toBeDefined();
  });
});

// --- Injeção opcional não muda resultados; emissões por cenário (consume/release com uow falso) ---
const ids = { uuid: () => '11111111-1111-4111-8111-111111111111' };
const DEC = 'b65c0b58-0cb0-43ca-8f53-6d12d6cb3c5f';
const RES = '7c1f0a4e-2b8d-4f7a-9c3e-5d6b7a8c9d0e';
const HASH = `sha256:${'a'.repeat(64)}`;
const EXPIRES = '2026-11-13T22:00:30.000Z';
const executor = { kind: 'PAPER_EXECUTOR', principalId: 'executor-fixture' } as const;
const decision = {
  schemaVersion: 1, decisionId: DEC, proposalId: '3dd99fb7-2fa8-4700-9d4f-4baf9a4e35f6', accountId: 'paper-fixture', agentId: 'agent-fixture-crypto',
  proposalHash: HASH, policyId: 'policy-fixture', policyVersion: '1.0.0-fixture', policyHash: `sha256:${'b'.repeat(64)}`, status: 'ALLOW_PAPER', violations: [],
  evaluatedAt: '2026-11-13T22:00:00.000Z', marketDataAsOf: '2026-11-13T21:59:59.000Z', snapshotVersion: 'snapshot-fixture-1', reservationId: RES,
  authorizationExpiresAt: EXPIRES, correlationId: 'corr-fixture-001',
};
const reservation: ReservationRecord = {
  reservationId: RES, decisionId: DEC, accountId: 'paper-fixture', instrument: 'FIXTURE-BTC-USD', strategyId: 'strategy-fixture', exposureBase: '100',
  riskBase: '1', status: 'ACTIVE', expiresAt: EXPIRES, createdAt: '2026-11-13T22:00:00.000Z', closedAt: null, paperOrderId: null,
};

function fake(opts: { decision?: unknown; reservation?: ReservationRecord | null; grant?: boolean; fail?: boolean }) {
  const uow = {
    lockAccount: () => Promise.resolve({ accountId: 'paper-fixture', environment: 'PAPER' }),
    hasActiveGrant: () => Promise.resolve(opts.grant ?? true),
    findDecisionById: () => Promise.resolve((opts.decision === undefined ? decision : opts.decision) as never),
    findReservationByDecision: () => Promise.resolve(opts.reservation === undefined ? reservation : opts.reservation),
    findReservation: () => Promise.resolve(opts.reservation === undefined ? reservation : opts.reservation),
    closeReservation: () => Promise.resolve(true),
    appendAudit: () => Promise.resolve(),
    appendOutbox: () => Promise.resolve(),
  } as unknown as RiskUnitOfWork;
  return { run: <T>(work: (u: RiskUnitOfWork) => Promise<T>) => (opts.fail ? Promise.reject(new Error('db fora')) : work(uow)) };
}

const consume = (f: ReturnType<typeof fake>, metrics: RiskMetrics | undefined, now = '2026-11-13T22:00:10.000Z', order = 'order-1') =>
  new ConsumePaperAuthorization({ transactions: f, clock: new MutableClock(now), ids, logger: new CapturingLogger(), ...(metrics ? { metrics } : {}) }).execute({
    principal: executor, decisionId: DEC, accountId: 'paper-fixture', paperOrderId: order, proposalHash: HASH,
  });
const release = (f: ReturnType<typeof fake>, metrics: RiskMetrics | undefined, now = '2026-11-13T22:00:10.000Z') =>
  new ReleaseRiskReservation({ transactions: f, clock: new MutableClock(now), ids, logger: new CapturingLogger(), ...(metrics ? { metrics } : {}) }).execute({
    principal: executor, reservationId: RES, reason: 'cancelado',
  });
const emitted = (logger: CapturingLogger) => logger.entries.map((e) => `${e.event}:${e.fields.op ?? ''}:${e.fields.outcome ?? ''}`);

describe('emissões esperadas por cenário (consume/release)', () => {
  it('consume OK → reservation_op CONSUME/OK', async () => {
    const logger = new CapturingLogger();
    expect((await consume(fake({}), new LogMetrics(logger))).kind).toBe('CONSUMED');
    expect(emitted(logger)).toEqual(['metric.reservation_op:CONSUME:OK']);
  });

  it('consume com outra ordem → conflito + op CONFLICT', async () => {
    const logger = new CapturingLogger();
    const f = fake({ reservation: { ...reservation, status: 'CONSUMED', paperOrderId: 'order-A' } });
    expect(await consume(f, new LogMetrics(logger), undefined, 'order-B')).toEqual({ kind: 'CONFLICT' });
    expect(emitted(logger)).toEqual(['metric.reservation_conflict:CONSUME:', 'metric.reservation_op:CONSUME:CONFLICT']);
  });

  it('consume após TTL (NOT_AUTHORIZED) → op CONFLICT sem metric de conflito de capacidade', async () => {
    const logger = new CapturingLogger();
    expect((await consume(fake({}), new LogMetrics(logger), EXPIRES)).kind).toBe('NOT_AUTHORIZED');
    expect(emitted(logger)).toEqual(['metric.reservation_op:CONSUME:CONFLICT']);
  });

  it('consume sem grant → FORBIDDEN; banco indisponível → UNAVAILABLE', async () => {
    const a = new CapturingLogger();
    expect(await consume(fake({ grant: false }), new LogMetrics(a))).toEqual({ kind: 'FORBIDDEN' });
    expect(emitted(a)).toEqual(['metric.reservation_op:CONSUME:FORBIDDEN']);
    const b = new CapturingLogger();
    expect(await consume(fake({ fail: true }), new LogMetrics(b))).toEqual({ kind: 'UNAVAILABLE' });
    expect(emitted(b)).toEqual(['metric.reservation_op:CONSUME:UNAVAILABLE']);
  });

  it('consume de decisão inexistente → NOT_FOUND sem emissão', async () => {
    const logger = new CapturingLogger();
    expect(await consume(fake({ decision: null }), new LogMetrics(logger))).toEqual({ kind: 'NOT_FOUND' });
    expect(logger.entries).toEqual([]);
  });

  it('release OK / vencida / indisponível', async () => {
    const ok = new CapturingLogger();
    expect(await release(fake({}), new LogMetrics(ok))).toEqual({ kind: 'RELEASED', replayed: false });
    expect(emitted(ok)).toEqual(['metric.reservation_op:RELEASE:OK']);
    const late = new CapturingLogger();
    expect((await release(fake({}), new LogMetrics(late), EXPIRES)).kind).toBe('CONFLICT');
    expect(emitted(late)).toEqual(['metric.reservation_conflict:RELEASE:', 'metric.reservation_op:RELEASE:CONFLICT']);
    const down = new CapturingLogger();
    expect(await release(fake({ fail: true }), new LogMetrics(down))).toEqual({ kind: 'UNAVAILABLE' });
    expect(emitted(down)).toEqual(['metric.reservation_op:RELEASE:UNAVAILABLE']);
  });

  it('nenhuma emissão contém ids (decisão, reserva, conta, ordem) nem o hash', async () => {
    const logger = new CapturingLogger();
    await consume(fake({}), new LogMetrics(logger));
    await release(fake({}), new LogMetrics(logger));
    await consume(fake({ grant: false }), new LogMetrics(logger));
    const text = JSON.stringify(logger.entries);
    for (const secret of [DEC, RES, HASH, 'paper-fixture', 'executor-fixture', 'order-1']) expect(text).not.toContain(secret);
  });

  it('injeção opcional não muda resultados: com LogMetrics, coletor que lança ou ausente → mesmo resultado', async () => {
    const boom = new Proxy({} as RiskMetrics, {
      get: () => () => {
        throw new Error('coletor quebrado');
      },
    });
    for (const metrics of [undefined, new LogMetrics(new CapturingLogger()), boom, new LogMetrics({ info: boom as never, warn: boom as never, error: boom as never })]) {
      expect(await consume(fake({}), metrics)).toEqual({ kind: 'CONSUMED', reservationId: RES, replayed: false });
      expect(await consume(fake({ grant: false }), metrics)).toEqual({ kind: 'FORBIDDEN' });
      expect(await release(fake({}), metrics)).toEqual({ kind: 'RELEASED', replayed: false });
      expect(await consume(fake({ fail: true }), metrics)).toEqual({ kind: 'UNAVAILABLE' });
    }
  });
});

describe('LogFields', () => {
  it('aceita os campos de métrica op/kind/count', () => {
    const fields: LogFields = { op: 'CONSUME', kind: 'DATABASE', count: 1 };
    expect(Object.keys(fields)).toEqual(['op', 'kind', 'count']);
  });
});

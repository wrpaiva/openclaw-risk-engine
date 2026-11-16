import { describe, expect, it } from 'vitest';
import { ConsumePaperAuthorization } from '../../../src/application/ConsumePaperAuthorization.js';
import { GetRiskDecision } from '../../../src/application/GetRiskDecision.js';
import { ReleaseRiskReservation } from '../../../src/application/ReleaseRiskReservation.js';
import type { AuditEvent, ReservationRecord, RiskUnitOfWork } from '../../../src/application/ports/RiskUnitOfWork.js';
import type { RiskDecisionV1 } from '../../../src/domain/RiskDecision.js';
import { CapturingLogger, at, MutableClock } from '../../integration/support/harness.js';

// Tudo FICTÍCIO. uow falso em memória: registra escritas para provar que nada foi consumido.
const ids = { uuid: () => '11111111-1111-4111-8111-111111111111' };
const DEC = 'b65c0b58-0cb0-43ca-8f53-6d12d6cb3c5f';
const RES = '7c1f0a4e-2b8d-4f7a-9c3e-5d6b7a8c9d0e';
const HASH = `sha256:${'a'.repeat(64)}`;
const EXPIRES = '2026-11-13T22:00:30.000Z';
const executor = { kind: 'PAPER_EXECUTOR', principalId: 'executor-fixture' } as const;

const decision: RiskDecisionV1 = {
  schemaVersion: 1,
  decisionId: DEC,
  proposalId: '3dd99fb7-2fa8-4700-9d4f-4baf9a4e35f6',
  accountId: 'paper-fixture',
  agentId: 'agent-fixture-crypto',
  proposalHash: HASH,
  policyId: 'policy-fixture',
  policyVersion: '1.0.0-fixture',
  policyHash: `sha256:${'b'.repeat(64)}`,
  status: 'ALLOW_PAPER',
  violations: [],
  evaluatedAt: '2026-11-13T22:00:00.000Z',
  marketDataAsOf: '2026-11-13T21:59:59.000Z',
  snapshotVersion: 'snapshot-fixture-1',
  reservationId: RES,
  authorizationExpiresAt: EXPIRES,
  correlationId: 'corr-fixture-001',
};
const reservation: ReservationRecord = {
  reservationId: RES,
  decisionId: DEC,
  accountId: 'paper-fixture',
  instrument: 'FIXTURE-BTC-USD',
  strategyId: 'strategy-fixture',
  exposureBase: '100',
  riskBase: '1',
  status: 'ACTIVE',
  expiresAt: EXPIRES,
  createdAt: '2026-11-13T22:00:00.000Z',
  closedAt: null,
  paperOrderId: null,
};

function fake(opts: { decision?: unknown; reservation?: ReservationRecord | null; grant?: boolean }) {
  const writes: string[] = [];
  const audits: AuditEvent[] = [];
  const uow = {
    lockAccount: () => Promise.resolve({ accountId: 'paper-fixture', environment: 'PAPER' }),
    hasActiveGrant: () => Promise.resolve(opts.grant ?? true),
    findDecisionById: () => Promise.resolve((opts.decision === undefined ? decision : opts.decision) as RiskDecisionV1 | null),
    findReservationByDecision: () => Promise.resolve(opts.reservation === undefined ? reservation : opts.reservation),
    findReservation: () => Promise.resolve(opts.reservation === undefined ? reservation : opts.reservation),
    closeReservation: (_id: string, to: string) => {
      writes.push(`close:${to}`);
      return Promise.resolve(true);
    },
    appendAudit: (e: AuditEvent) => {
      writes.push(`audit:${e.eventType}`);
      audits.push(e);
      return Promise.resolve();
    },
    appendOutbox: () => {
      writes.push('outbox');
      return Promise.resolve();
    },
  } as unknown as RiskUnitOfWork;
  const transactions = { run: <T>(work: (u: RiskUnitOfWork) => Promise<T>) => work(uow) };
  return { writes, audits, transactions };
}

function consumer(f: ReturnType<typeof fake>, nowIso = '2026-11-13T22:00:10.000Z') {
  const logger = new CapturingLogger();
  const clock = new MutableClock(nowIso);
  const useCase = new ConsumePaperAuthorization({ transactions: f.transactions, clock, ids, logger });
  return { logger, run: () => useCase.execute({ principal: executor, decisionId: DEC, accountId: 'paper-fixture', paperOrderId: 'order-1', proposalHash: HASH }) };
}

describe('Consume (M1): dados persistidos inválidos ou divergentes → UNAVAILABLE, nada consumido', () => {
  it('linha de controle: dados íntegros consomem', async () => {
    const f = fake({});
    expect(await consumer(f).run()).toEqual({ kind: 'CONSUMED', reservationId: RES, replayed: false });
    expect(f.writes).toEqual(['close:CONSUMED', 'audit:RESERVATION_CONSUMED', 'outbox']);
  });

  it.each([
    ['decision_json lixo', { foo: 1 }],
    ['decision_json string', 'texto'],
    ['ALLOW_PAPER sem reservationId', { ...decision, reservationId: null }],
    ['ALLOW_PAPER com violações', { ...decision, violations: [{ code: 'POLICY_MISSING', message: 'x' }] }],
    ['schemaVersion errado', { ...decision, schemaVersion: 2 }],
  ])('%s', async (_n, bad) => {
    const f = fake({ decision: bad });
    const c = consumer(f);
    expect(await c.run()).toEqual({ kind: 'UNAVAILABLE' });
    expect(f.writes).toEqual([]);
    expect(c.logger.entries.some((e) => e.level === 'error' && e.event === 'consume.unavailable')).toBe(true);
  });

  it.each([
    ['reservationId', { ...reservation, reservationId: '99999999-9999-4999-8999-999999999999' }],
    ['accountId', { ...reservation, accountId: 'paper-outra' }],
    ['decisionId', { ...reservation, decisionId: '99999999-9999-4999-8999-999999999999' }],
    ['expiresAt (+1 ms)', { ...reservation, expiresAt: '2026-11-13T22:00:30.001Z' }],
    ['expiresAt (-1 ms)', { ...reservation, expiresAt: '2026-11-13T22:00:29.999Z' }],
    ['expiresAt inválido', { ...reservation, expiresAt: 'ontem' }],
  ])('reserva com %s divergente da decisão', async (_n, bad) => {
    const f = fake({ reservation: bad });
    expect(await consumer(f).run()).toEqual({ kind: 'UNAVAILABLE' });
    expect(f.writes).toEqual([]);
  });

  it('reserva ausente para ALLOW_PAPER → UNAVAILABLE', async () => {
    const f = fake({ reservation: null });
    expect(await consumer(f).run()).toEqual({ kind: 'UNAVAILABLE' });
    expect(f.writes).toEqual([]);
  });

  it('divergência vence mesmo com reserva já fechada (não devolve status de reserva inconsistente)', async () => {
    const f = fake({ reservation: { ...reservation, status: 'CONSUMED', paperOrderId: 'order-1', expiresAt: '2026-11-13T22:05:00.000Z' } });
    expect(await consumer(f).run()).toEqual({ kind: 'UNAVAILABLE' });
  });
});

describe('Consume: expiração usa a expiresAt da reserva (limite exato)', () => {
  it('1 ms antes do vencimento consome', async () => {
    const f = fake({});
    expect((await consumer(f, '2026-11-13T22:00:29.999Z').run()).kind).toBe('CONSUMED');
  });
  it.each(['2026-11-13T22:00:30.000Z', '2026-11-13T22:00:30.001Z', '2026-11-14T00:00:00.000Z'])('now=%s (>= expiresAt) → EXPIRED, fecha como EXPIRED e não consome', async (now) => {
    const f = fake({});
    expect(await consumer(f, now).run()).toEqual({ kind: 'NOT_AUTHORIZED', reason: 'EXPIRED' });
    expect(f.writes).toEqual(['close:EXPIRED', 'audit:RESERVATION_EXPIRED']);
    expect(f.audits[0]?.details).toEqual({ trigger: 'consume-after-ttl' });
  });
});

describe('GetRiskDecision (M1): decision_json inválido → UNAVAILABLE, nunca FOUND', () => {
  const principals = [
    { kind: 'AGENT', principalId: 'agent-fixture-crypto' },
    { kind: 'PAPER_EXECUTOR', principalId: 'executor-fixture' },
  ] as const;
  it.each(principals)('principal %o', async (principal) => {
    for (const bad of [{ foo: 1 }, 'x', 42, { ...decision, status: 'TALVEZ' }, { ...decision, violations: 'nenhuma' }]) {
      const logger = new CapturingLogger();
      const f = fake({ decision: bad });
      const r = await new GetRiskDecision({ transactions: f.transactions, logger }).execute({ decisionId: DEC, principal });
      expect(r).toEqual({ kind: 'UNAVAILABLE' });
      expect(logger.entries.some((e) => e.level === 'error')).toBe(true);
    }
  });
  it('controle: decisão válida do dono é FOUND', async () => {
    const f = fake({});
    const r = await new GetRiskDecision({ transactions: f.transactions, logger: new CapturingLogger() }).execute({ decisionId: DEC, principal: principals[0] });
    expect(r.kind).toBe('FOUND');
  });
});

describe('Release (B4): TTL vencido fecha como EXPIRED, nunca RELEASED', () => {
  const release = (f: ReturnType<typeof fake>, now: string) =>
    new ReleaseRiskReservation({ transactions: f.transactions, clock: new MutableClock(now), ids, logger: new CapturingLogger() }).execute({
      reservationId: RES,
      reason: 'cancelado',
      principal: executor,
    });

  it('1 ms antes do vencimento libera', async () => {
    const f = fake({});
    expect(await release(f, '2026-11-13T22:00:29.999Z')).toEqual({ kind: 'RELEASED', replayed: false });
    expect(f.writes).toEqual(['close:RELEASED', 'audit:RESERVATION_RELEASED']);
  });
  it.each(['2026-11-13T22:00:30.000Z', '2026-11-13T22:00:30.001Z'])('now=%s → CONFLICT EXPIRED com auditoria release-after-ttl', async (now) => {
    const f = fake({});
    expect(await release(f, now)).toEqual({ kind: 'CONFLICT', status: 'EXPIRED' });
    expect(f.writes).toEqual(['close:EXPIRED', 'audit:RESERVATION_EXPIRED']);
    expect(f.audits[0]?.details).toEqual({ trigger: 'release-after-ttl' });
    expect(f.audits[0]?.createdAt).toBe(at(now).toISOString());
  });
  it('reserva com expiresAt ilegível é tratada como vencida (fail-closed)', async () => {
    const f = fake({ reservation: { ...reservation, expiresAt: 'lixo' } });
    expect(await release(f, '2026-11-13T22:00:00.000Z')).toEqual({ kind: 'CONFLICT', status: 'EXPIRED' });
  });
  it('reserva já EXPIRED: repetição continua CONFLICT EXPIRED e não grava nada', async () => {
    const f = fake({ reservation: { ...reservation, status: 'EXPIRED', closedAt: EXPIRES } });
    expect(await release(f, '2026-11-13T23:00:00.000Z')).toEqual({ kind: 'CONFLICT', status: 'EXPIRED' });
    expect(f.writes).toEqual([]);
  });
});

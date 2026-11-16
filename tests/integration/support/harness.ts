import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { ConsumePaperAuthorization } from '../../../src/application/ConsumePaperAuthorization.js';
import { EvaluateTradeRisk } from '../../../src/application/EvaluateTradeRisk.js';
import { GetRiskDecision } from '../../../src/application/GetRiskDecision.js';
import { ExpireRiskReservations } from '../../../src/application/ExpireRiskReservations.js';
import { ReleaseRiskReservation } from '../../../src/application/ReleaseRiskReservation.js';
import type { AccountSnapshot, AccountSnapshotProvider } from '../../../src/application/ports/AccountSnapshotProvider.js';
import type { AuthenticatedPrincipal } from '../../../src/application/ports/AuthenticatedAgentContext.js';
import type { Clock } from '../../../src/application/ports/Clock.js';
import type { LogFields, Logger } from '../../../src/application/ports/Logger.js';
import type { InstrumentCatalog } from '../../../src/application/ports/InstrumentCatalog.js';
import type { FxRate, MarketDataProvider, MarketQuote } from '../../../src/application/ports/MarketDataProvider.js';
import type { TransactionManager } from '../../../src/application/ports/TransactionManager.js';
import type { InstrumentSpec } from '../../../src/domain/InstrumentSpec.js';
import { UtcInstant } from '../../../src/domain/value-objects/UtcInstant.js';
import { PgTransactionManager } from '../../../src/infrastructure/postgres/PgTransactionManager.js';
import { CryptoIdGenerator } from '../../../src/infrastructure/system/CryptoIdGenerator.js';
import { createRiskEvaluator } from '../../../src/rules/RiskEvaluator.js';
import { FIXTURE_SKEW_MS } from '../../fixtures/evaluation.js';
import { fixtureInstrument } from '../../fixtures/instruments.js';
import { FIXTURE_NOW_ISO, validProposal } from '../../fixtures/proposals.js';

export interface LogEntry {
  readonly level: 'info' | 'warn' | 'error';
  readonly event: string;
  readonly fields: LogFields;
}

/** Logger que captura os registros, para afirmar o que foi (e o que não foi) logado. */
export class CapturingLogger implements Logger {
  readonly entries: LogEntry[] = [];
  info(event: string, fields: LogFields = {}): void {
    this.entries.push({ level: 'info', event, fields });
  }
  warn(event: string, fields: LogFields = {}): void {
    this.entries.push({ level: 'warn', event, fields });
  }
  error(event: string, fields: LogFields = {}): void {
    this.entries.push({ level: 'error', event, fields });
  }
}

export class MutableClock implements Clock {
  private current: UtcInstant;
  constructor(iso = FIXTURE_NOW_ISO) {
    this.current = at(iso);
  }
  now(): UtcInstant {
    return this.current;
  }
  set(iso: string): void {
    this.current = at(iso);
  }
}

export function at(iso: string): UtcInstant {
  const r = UtcInstant.parse(iso);
  if (!r.ok) throw new Error(iso);
  return r.value;
}

/** Fontes externas FICTÍCIAS (D-03/D-05 em aberto), mutáveis por teste. */
export class FakeExternal implements AccountSnapshotProvider, MarketDataProvider, InstrumentCatalog {
  snapshot: AccountSnapshot | null = {
    accountId: 'paper-fixture',
    snapshotVersion: 'snapshot-fixture-1',
    asOf: '2026-11-13T21:59:59.000Z',
    equityBase: '10000',
    availableCashBase: '10000',
    realizedDailyPnlBase: '0',
    unrealizedPnlBase: '0',
    openGrossExposureBase: '0',
    openInstrumentExposureBase: '0',
    openStrategyExposureBase: '0',
  };
  marketQuote: MarketQuote | null = {
    instrument: 'FIXTURE-BTC-USD',
    bid: '99.99',
    ask: '100.01',
    asOf: '2026-11-13T21:59:59.500Z',
    source: 'fixture-feed',
  };
  fx: FxRate | null = null;
  instrument: unknown = fixtureInstrument();
  failSnapshot = false;

  getSnapshot(): Promise<AccountSnapshot | null> {
    if (this.failSnapshot) return Promise.reject(new Error('fonte de snapshot fora do ar'));
    return Promise.resolve(this.snapshot);
  }
  quote(): Promise<MarketQuote | null> {
    return Promise.resolve(this.marketQuote);
  }
  fxRate(): Promise<FxRate | null> {
    return Promise.resolve(this.fx);
  }
  find(): Promise<InstrumentSpec | null> {
    return Promise.resolve(this.instrument as InstrumentSpec | null);
  }
}

export interface Harness {
  readonly clock: MutableClock;
  readonly external: FakeExternal;
  readonly evaluate: EvaluateTradeRisk;
  readonly consume: ConsumePaperAuthorization;
  readonly release: ReleaseRiskReservation;
  readonly get: GetRiskDecision;
  readonly logger: CapturingLogger;
  readonly expire: ExpireRiskReservations;
}

/** Timeouts FICTÍCIOS de teste; não representam SLA. */
export const TEST_DB_TIMEOUTS = { statementTimeoutMs: 15_000, lockTimeoutMs: 15_000 } as const;

export function harness(pool: pg.Pool, transactions: TransactionManager = new PgTransactionManager(pool, TEST_DB_TIMEOUTS)): Harness {
  const clock = new MutableClock();
  const external = new FakeExternal();
  const ids = new CryptoIdGenerator();
  const logger = new CapturingLogger();
  return {
    clock,
    logger,
    external,
    evaluate: new EvaluateTradeRisk({
      transactions,
      evaluator: createRiskEvaluator(),
      snapshots: external,
      marketData: external,
      catalog: external,
      clock,
      ids,
      logger,
      clockSkewToleranceMs: FIXTURE_SKEW_MS,
    }),
    consume: new ConsumePaperAuthorization({ transactions, clock, ids, logger }),
    release: new ReleaseRiskReservation({ transactions, clock, ids, logger }),
    get: new GetRiskDecision({ transactions, logger }),
    expire: new ExpireRiskReservations({ transactions, clock, ids }),
  };
}

/** Proposta válida com identificadores únicos (para múltiplas propostas distintas). */
export function uniqueProposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return validProposal({ proposalId: randomUUID(), idempotencyKey: `idem-${randomUUID()}`, ...overrides });
}

export const AGENT = 'agent-fixture-crypto';
export const EXECUTOR = 'executor-fixture';
export const agentPrincipal = (principalId = AGENT): AuthenticatedPrincipal => ({ kind: 'AGENT', principalId });
export const executorPrincipal = (principalId = EXECUTOR): AuthenticatedPrincipal => ({ kind: 'PAPER_EXECUTOR', principalId });

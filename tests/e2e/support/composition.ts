import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import pg from 'pg';
import { CheckReadiness } from '../../../src/application/CheckReadiness.js';
import { ConsumePaperAuthorization } from '../../../src/application/ConsumePaperAuthorization.js';
import { EvaluateTradeRisk } from '../../../src/application/EvaluateTradeRisk.js';
import { GetRiskDecision } from '../../../src/application/GetRiskDecision.js';
import { ReleaseRiskReservation } from '../../../src/application/ReleaseRiskReservation.js';
import type { AccountSnapshot, AccountSnapshotProvider } from '../../../src/application/ports/AccountSnapshotProvider.js';
import type { Clock } from '../../../src/application/ports/Clock.js';
import type { InstrumentCatalog } from '../../../src/application/ports/InstrumentCatalog.js';
import type { FxRate, MarketDataProvider, MarketQuote } from '../../../src/application/ports/MarketDataProvider.js';
import type { TransactionManager } from '../../../src/application/ports/TransactionManager.js';
import type { InstrumentSpec } from '../../../src/domain/InstrumentSpec.js';
import { UtcInstant } from '../../../src/domain/value-objects/UtcInstant.js';
import { Sha256TokenAuthenticator } from '../../../src/infrastructure/auth/Sha256TokenAuthenticator.js';
import { readBundledMigrations } from '../../../src/infrastructure/postgres/migrate.js';
import { PgPrivilegeInspector } from '../../../src/infrastructure/postgres/PgPrivilegeInspector.js';
import { PgReadinessProbe } from '../../../src/infrastructure/postgres/PgReadinessProbe.js';
import { PgTransactionManager } from '../../../src/infrastructure/postgres/PgTransactionManager.js';
import { CryptoIdGenerator } from '../../../src/infrastructure/system/CryptoIdGenerator.js';
import { createRiskHttpServer } from '../../../src/interfaces/http/server.js';
import { createRiskEvaluator } from '../../../src/rules/RiskEvaluator.js';
import { fixtureInstrument } from '../../fixtures/instruments.js';
import { CapturingLogger } from '../../integration/support/harness.js';
import { e2eEnv } from './env.js';

// Camada (b) da regressão: o servidor HTTP REAL (createRiskHttpServer) com os casos de uso reais, Postgres real conectado
// como LOGIN DE RUNTIME (sem superuser, sem DDL) e fontes externas FALSAS definidas aqui, em tests/. Este arquivo nunca
// vai para a imagem: a imagem real não tem modo fixture (fontes Unconfigured => só BLOCK). Fontes FICTÍCIAS (D-02/03/05).

/** Relógio congelado na criação (tempo real naquele instante); só avança por `advance`. Torna fronteiras determinísticas. */
export class FrozenClock implements Clock {
  private ms: number;
  constructor(startMs = Date.now()) {
    this.ms = Math.floor(startMs / 1000) * 1000;
  }
  now(): UtcInstant {
    return UtcInstant.fromEpochMillis(this.ms);
  }
  nowMs(): number {
    return this.ms;
  }
  advance(deltaMs: number): void {
    this.ms += deltaMs;
  }
  set(ms: number): void {
    this.ms = ms;
  }
}

/** Fontes FICTÍCIAS cujos `asOf` derivam do relógio; idades configuráveis para testar fronteiras. */
export class ClockedSources implements AccountSnapshotProvider, MarketDataProvider, InstrumentCatalog {
  quoteAgeMs = 500;
  snapshotAgeMs = 1000;
  quoteMissing = false;
  failSnapshot = false;
  failQuote = false;
  instrument: unknown = fixtureInstrument();
  constructor(private readonly clock: FrozenClock) {}

  getSnapshot(accountId: string): Promise<AccountSnapshot | null> {
    if (this.failSnapshot) return Promise.reject(new Error('fonte de snapshot fora do ar'));
    return Promise.resolve({
      accountId,
      snapshotVersion: 'snapshot-e2e-1',
      asOf: new Date(this.clock.nowMs() - this.snapshotAgeMs).toISOString(),
      equityBase: '10000',
      availableCashBase: '10000',
      realizedDailyPnlBase: '0',
      unrealizedPnlBase: '0',
      openGrossExposureBase: '0',
      openInstrumentExposureBase: '0',
      openStrategyExposureBase: '0',
    });
  }
  quote(instrument: string): Promise<MarketQuote | null> {
    if (this.failQuote) return Promise.reject(new Error('market data fora do ar'));
    if (this.quoteMissing) return Promise.resolve(null);
    return Promise.resolve({
      instrument,
      bid: '99.99',
      ask: '100.01',
      asOf: new Date(this.clock.nowMs() - this.quoteAgeMs).toISOString(),
      source: 'fixture-feed',
    });
  }
  fxRate(): Promise<FxRate | null> {
    return Promise.resolve(null);
  }
  find(): Promise<InstrumentSpec | null> {
    return Promise.resolve(this.instrument as InstrumentSpec | null);
  }
}

export interface Identity {
  readonly id: string;
  readonly token: string;
}
export interface Identities {
  readonly agents: readonly Identity[]; // fixture-agent-1..7 (com grants nas contas semeadas pelo teste)
  readonly nogrant: Identity; // token válido, sem grant em nenhuma conta
  readonly executor: Identity; // stub do paper executor
}
const sha = (t: string): string => createHash('sha256').update(t, 'utf8').digest('hex');
const mintToken = (): string => randomBytes(24).toString('base64url');

/** Identidades FICTÍCIAS com tokens aleatórios por execução (nunca persistidos). */
export function mintIdentities(): Identities {
  const agents = Array.from({ length: 7 }, (_v, i) => ({ id: `fixture-agent-${i + 1}`, token: mintToken() }));
  return { agents, nogrant: { id: 'fixture-agent-nogrant', token: mintToken() }, executor: { id: 'fixture-executor-1', token: mintToken() } };
}

/** Decorador de falha injetada: executa todo o trabalho transacional e então falha ANTES do COMMIT (rollback total). */
export class FailBeforeCommit implements TransactionManager {
  armed = false;
  constructor(private readonly inner: TransactionManager) {}
  run<T>(work: Parameters<TransactionManager['run']>[0] extends (uow: infer U) => Promise<unknown> ? (uow: U) => Promise<T> : never): Promise<T> {
    return this.inner.run(async (uow) => {
      const result = await work(uow);
      if (this.armed) throw new Error('falha injetada antes do commit');
      return result;
    });
  }
}

export interface Composition {
  readonly url: string;
  readonly clock: FrozenClock;
  readonly sources: ClockedSources;
  readonly logger: CapturingLogger;
  readonly identities: Identities;
  /** Pool do LOGIN DE RUNTIME. */
  readonly pool: pg.Pool;
  readonly fault: FailBeforeCommit;
  close(): Promise<void>;
}

export interface CompositionOptions {
  readonly identities?: Identities;
  /** Banco alvo; padrão: RISK_E2E_RUNTIME_DATABASE_URL (login de runtime). Sempre local e *_test. */
  readonly databaseUrl?: string;
  readonly poolMax?: number;
  readonly clock?: FrozenClock;
}

const MIGRATIONS_DIR = join(import.meta.dirname, '../../../migrations');
/** Timeouts FICTÍCIOS de teste; não representam SLA. */
const TIMEOUTS = { statementTimeoutMs: 8000, lockTimeoutMs: 8000 } as const;

export async function startComposition(options: CompositionOptions = {}): Promise<Composition> {
  const databaseUrl = options.databaseUrl ?? e2eEnv().runtimeDatabaseUrl;
  const parsed = new URL(databaseUrl);
  if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test')) throw new Error('composição só roda em banco local *_test');
  const identities = options.identities ?? mintIdentities();
  const pool = new pg.Pool({ connectionString: databaseUrl, max: options.poolMax ?? 16, connectionTimeoutMillis: 3000 });
  pool.on('error', () => undefined);
  // A composição NUNCA roda como superuser: prova de que o fluxo funciona só com os privilégios de runtime.
  const who = await pool.query<{ rolsuper: boolean; rolcreaterole: boolean; rolcreatedb: boolean }>(
    'SELECT rolsuper, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user',
  );
  if (who.rows[0]?.rolsuper !== false || who.rows[0].rolcreaterole || who.rows[0].rolcreatedb) {
    await pool.end();
    throw new Error('composição exige login de runtime sem poderes');
  }

  const clock = options.clock ?? new FrozenClock();
  const sources = new ClockedSources(clock);
  const logger = new CapturingLogger();
  const ids = new CryptoIdGenerator();
  const fault = new FailBeforeCommit(new PgTransactionManager(pool, TIMEOUTS));
  const principals = [
    ...identities.agents.map((a) => ({ principalId: a.id, kind: 'AGENT' as const, tokenSha256: [sha(a.token)] })),
    { principalId: identities.nogrant.id, kind: 'AGENT' as const, tokenSha256: [sha(identities.nogrant.token)] },
    { principalId: identities.executor.id, kind: 'PAPER_EXECUTOR' as const, tokenSha256: [sha(identities.executor.token)] },
  ];
  const inspector = new PgPrivilegeInspector(pool, { statementTimeoutMs: TIMEOUTS.statementTimeoutMs, logger });
  let draining = false;
  const server: Server = createRiskHttpServer({
    authenticator: new Sha256TokenAuthenticator(principals),
    evaluate: new EvaluateTradeRisk({
      transactions: fault,
      evaluator: createRiskEvaluator(),
      snapshots: sources,
      marketData: sources,
      catalog: sources,
      clock,
      ids,
      logger,
      clockSkewToleranceMs: 1000,
    }),
    consume: new ConsumePaperAuthorization({ transactions: fault, clock, ids, logger }),
    release: new ReleaseRiskReservation({ transactions: fault, clock, ids, logger }),
    getDecision: new GetRiskDecision({ transactions: fault, logger }),
    logger,
    ids,
    readiness: new CheckReadiness({
      probe: new PgReadinessProbe({
        pool,
        bundledMigrations: () => readBundledMigrations(MIGRATIONS_DIR),
        privileges: inspector,
        statementTimeoutMs: TIMEOUTS.statementTimeoutMs,
        logger,
      }),
      isDraining: () => draining,
    }),
    isDraining: () => draining,
    limits: { maxBodyBytes: 65_536, requestTimeoutMs: 8000, headersTimeoutMs: 4000 },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    clock,
    sources,
    logger,
    identities,
    pool,
    fault,
    async close() {
      draining = true;
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      await pool.end().catch(() => undefined);
    },
  };
}

import { proposalAt } from './data.js';
import { EVALUATE, call, type HttpResult } from './env.js';

/** Proposta FICTÍCIA datada pelo relógio da composição, emitida em nome de `agent`. */
export function agentProposal(c: Composition, accountId: string, agent: Identity, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return proposalAt(c.clock.nowMs(), { accountId, agentId: agent.id, ...overrides });
}

export const evaluateVia = (c: Composition, agent: Identity, proposal: unknown): Promise<HttpResult> => call(c.url, 'POST', EVALUATE, agent.token, proposal);

export function agentAt(c: Composition, index: number): Identity {
  const agent = c.identities.agents[index];
  if (agent === undefined) throw new Error('agente fora do intervalo');
  return agent;
}

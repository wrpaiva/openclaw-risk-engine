import { fileURLToPath } from 'node:url';
import { ConsumePaperAuthorization } from '../../application/ConsumePaperAuthorization.js';
import { EvaluateTradeRisk } from '../../application/EvaluateTradeRisk.js';
import { GetRiskDecision } from '../../application/GetRiskDecision.js';
import { ReleaseRiskReservation } from '../../application/ReleaseRiskReservation.js';
import { Sha256TokenAuthenticator } from '../../infrastructure/auth/Sha256TokenAuthenticator.js';
import { loadPrincipalCredentials } from '../../infrastructure/auth/PrincipalCredentials.js';
import { loadConfig } from '../../infrastructure/config/loadConfig.js';
import { CheckReadiness } from '../../application/CheckReadiness.js';
import { JsonLogger } from '../../infrastructure/logging/JsonLogger.js';
import { LogMetrics } from '../../infrastructure/metrics/LogMetrics.js';
import { readBundledMigrations } from '../../infrastructure/postgres/migrate.js';
import { createPool } from '../../infrastructure/postgres/pools.js';
import { PgPrivilegeInspector } from '../../infrastructure/postgres/PgPrivilegeInspector.js';
import { PgReadinessProbe } from '../../infrastructure/postgres/PgReadinessProbe.js';
import { PgTransactionManager } from '../../infrastructure/postgres/PgTransactionManager.js';
import { CryptoIdGenerator } from '../../infrastructure/system/CryptoIdGenerator.js';
import { SystemClock } from '../../infrastructure/system/SystemClock.js';
import {
  UnconfiguredAccountSnapshotProvider,
  UnconfiguredInstrumentCatalog,
  UnconfiguredMarketDataProvider,
} from '../../infrastructure/unconfigured/UnconfiguredSources.js';
import { createRiskEvaluator } from '../../rules/RiskEvaluator.js';
import { createRiskHttpServer } from './server.js';

// Saída: 1 = falha de execução (privilégio, banco, listen); 2 = configuração/credenciais inválidas (igual à CLI).
function fail(message: string, code = 1): never {
  // Só mensagens fixas ou de ConfigError/PrincipalCredentialsError (que nunca contêm valores).
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

// dist/interfaces/http -> raiz do pacote (migrations/ acompanha a imagem).
const MIGRATIONS_DIR = fileURLToPath(new URL('../../../migrations', import.meta.url));

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    return fail(error instanceof Error && error.name === 'ConfigError' ? error.message : 'configuração inválida', 2);
  }
  if (!config.http.enabled) return fail('RISK_HTTP_ENABLED não é true; servidor HTTP não iniciado', 2);
  const http = config.http;

  let credentials;
  try {
    credentials = loadPrincipalCredentials(http.principalsFile);
  } catch (error) {
    return fail(error instanceof Error && error.name === 'PrincipalCredentialsError' ? error.message : 'credenciais inválidas', 2);
  }

  const logger = new JsonLogger(config.logLevel);
  const clock = new SystemClock();
  const ids = new CryptoIdGenerator();
  const pool = createPool({ connectionString: config.databaseUrl, connectionTimeoutMs: config.db.connectionTimeoutMs });
  pool.on('error', (error) => {
    logger.error('pool.error', { errorKind: error.name });
  });
  const statementTimeoutMs = config.db.statementTimeoutMs;

  // Autoverificação: recusa subir com privilégio além do mínimo (decisão da 2.5). Só aqui, nunca nos casos de uso.
  const inspector = new PgPrivilegeInspector(pool, { statementTimeoutMs, connectionTimeoutMs: config.db.connectionTimeoutMs, logger });
  if (!(await inspector.inspect()).ok) {
    return fail('privilégios do usuário de runtime excedem o mínimo ou não puderam ser verificados; servidor não iniciado');
  }
  const readiness = new CheckReadiness({
    probe: new PgReadinessProbe({ pool, bundledMigrations: () => readBundledMigrations(MIGRATIONS_DIR), privileges: inspector, statementTimeoutMs, connectionTimeoutMs: config.db.connectionTimeoutMs, logger }),
    isDraining: () => draining,
  });
  const metrics = new LogMetrics(logger);
  let draining = false;
  const transactions = new PgTransactionManager(pool, { statementTimeoutMs: config.db.statementTimeoutMs, lockTimeoutMs: config.db.lockTimeoutMs, connectionTimeoutMs: config.db.connectionTimeoutMs }, { logger, metrics });

  const server = createRiskHttpServer({
    authenticator: new Sha256TokenAuthenticator(credentials),
    evaluate: new EvaluateTradeRisk({
      transactions,
      evaluator: createRiskEvaluator(),
      snapshots: new UnconfiguredAccountSnapshotProvider(),
      marketData: new UnconfiguredMarketDataProvider(),
      catalog: new UnconfiguredInstrumentCatalog(),
      clock,
      ids,
      logger,
      clockSkewToleranceMs: config.clockSkewToleranceMs,
      metrics,
    }),
    consume: new ConsumePaperAuthorization({ transactions, clock, ids, logger, metrics }),
    release: new ReleaseRiskReservation({ transactions, clock, ids, logger, metrics }),
    getDecision: new GetRiskDecision({ transactions, logger }),
    logger,
    ids,
    readiness,
    isDraining: () => draining,
    limits: { maxBodyBytes: http.maxBodyBytes, requestTimeoutMs: http.requestTimeoutMs, headersTimeoutMs: http.headersTimeoutMs },
  });

  const shutdown = (): void => {
    // Readiness passa a 503 imediatamente; /health/live segue 200 até o processo sair.
    draining = true;
    server.close(() => {
      void pool.end().finally(() => process.exit(0));
    });
    server.closeIdleConnections();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  server.once('error', () => {
    fail('falha ao iniciar o servidor HTTP');
  });
  server.listen(http.port, http.host, () => {
    logger.info('http.listening', {
      outcome: 'STARTED',
      bindScope: http.bindScope,
      ...(http.transport === null ? {} : { transport: http.transport }),
    });
  });
}

main().catch(() => {
  fail('falha ao iniciar o servidor HTTP');
});

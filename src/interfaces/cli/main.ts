/**
 * CLI operacional do Risk Engine (paper trading). Subcomandos one-shot; nada é agendado aqui.
 *
 *   migrate                    aplica migrações pendentes com a credencial de MIGRAÇÃO
 *   expire-reservations        expira reservas ACTIVE vencidas (uma varredura) com a credencial de runtime
 *   reconcile-after-restore    (operador, credencial de MIGRAÇÃO) expira TODAS as reservas ACTIVE e limpa restore_pending; idempotente
 *   mark-restore-pending       (operador, credencial de MIGRAÇÃO) marca restore_pending=true: o serviço fica not-ready
 *   verify-runtime-privileges  verifica que a credencial de runtime não excede o privilégio mínimo
 *   healthcheck                GET /health/live no host de sonda (healthProbeHost) e RISK_HTTP_PORT (não conecta ao banco, mas exige a config de runtime válida)
 *
 * Códigos de saída:
 *   0  sucesso (migrate: concluído, inclusive "nenhuma pendente"; verify: privilégios no mínimo; healthcheck: live 200)
 *   1  falha de execução (banco indisponível, migração falhou, privilégio excessivo, healthcheck sem 200 ou com timeout)
 *   2  uso ou configuração inválidos (subcomando desconhecido, variável ausente/inválida, arquivo de segredo ilegível)
 *
 * Mensagens são fixas: sem stack, sem valores de variáveis, sem conteúdo de arquivos, sem mensagens do banco.
 */
import { get } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { ExpireRiskReservations } from '../../application/ExpireRiskReservations.js';
import { ConfigError, loadConfig, loadMigrationConfig, type MigrationConfig, type RiskConfig } from '../../infrastructure/config/loadConfig.js';
import { healthProbeHost } from '../../infrastructure/config/httpBind.js';
import { JsonLogger } from '../../infrastructure/logging/JsonLogger.js';
import { LogMetrics } from '../../infrastructure/metrics/LogMetrics.js';
import { createPool } from '../../infrastructure/postgres/pools.js';
import { migrate } from '../../infrastructure/postgres/migrate.js';
import { PgRestoreReconciliation } from '../../infrastructure/postgres/PgRestoreReconciliation.js';
import { PgPrivilegeInspector } from '../../infrastructure/postgres/PgPrivilegeInspector.js';
import { PgTransactionManager } from '../../infrastructure/postgres/PgTransactionManager.js';
import { CryptoIdGenerator } from '../../infrastructure/system/CryptoIdGenerator.js';
import { SystemClock } from '../../infrastructure/system/SystemClock.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../migrations', import.meta.url));

const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;

function say(message: string): void {
  process.stdout.write(`${message}\n`);
}
function complain(message: string): void {
  process.stderr.write(`${message}\n`);
}

function configOrNull<T>(load: () => T): T | null {
  try {
    return load();
  } catch (error) {
    // ConfigError só cita nomes de variáveis, nunca valores.
    complain(error instanceof ConfigError ? error.message : 'configuração inválida');
    return null;
  }
}

// Credencial de MIGRAÇÃO: sempre com prazos (loadMigrationConfig exige os três RISK_DB_*_TIMEOUT_MS).
function migrationPool(config: MigrationConfig): Pool {
  return createPool({ connectionString: config.databaseUrl, connectionTimeoutMs: config.db.connectionTimeoutMs, max: 1 });
}

async function runMigrate(): Promise<number> {
  const config = configOrNull(() => loadMigrationConfig(process.env));
  if (config === null) return EXIT_USAGE;
  const pool = migrationPool(config);
  try {
    const applied = await migrate(pool, MIGRATIONS_DIR, config.db);
    say(applied.length === 0 ? 'nenhuma migração pendente' : applied.map((m) => `aplicada ${m.version}`).join('\n'));
    return EXIT_OK;
  } catch {
    complain('migração falhou; nada foi confirmado para a migração em curso');
    return EXIT_FAILURE;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

function runtimePool(config: RiskConfig): Pool {
  return createPool({ connectionString: config.databaseUrl, connectionTimeoutMs: config.db.connectionTimeoutMs, max: 2 });
}

async function runExpire(): Promise<number> {
  const config = configOrNull(() => loadConfig(process.env));
  if (config === null) return EXIT_USAGE;
  const pool = runtimePool(config);
  try {
    const logger = new JsonLogger(config.logLevel);
    const metrics = new LogMetrics(logger);
    const transactions = new PgTransactionManager(pool, { statementTimeoutMs: config.db.statementTimeoutMs, lockTimeoutMs: config.db.lockTimeoutMs, connectionTimeoutMs: config.db.connectionTimeoutMs }, { logger, metrics });
    const expired = await new ExpireRiskReservations({ transactions, clock: new SystemClock(), ids: new CryptoIdGenerator(), metrics }).execute();
    say(`reservas expiradas: ${expired}`);
    return EXIT_OK;
  } catch {
    complain('varredura de reservas falhou; nenhuma expiração foi confirmada');
    return EXIT_FAILURE;
  } finally {
    await pool.end().catch(() => undefined);
  }
}


async function runReconcile(): Promise<number> {
  const config = configOrNull(() => loadMigrationConfig(process.env));
  if (config === null) return EXIT_USAGE;
  const pool = migrationPool(config);
  const metrics = new LogMetrics(new JsonLogger('info'));
  try {
    const result = await new PgRestoreReconciliation(pool, config.db).reconcile(new SystemClock().now().toISOString());
    // Métrica EXPIRE só depois do COMMIT.
    for (let i = 0; i < result.expiredReservations; i += 1) metrics.reservationOp('EXPIRE', 'OK');
    say(result.reconciled ? `reconciliação concluída; reservas expiradas: ${result.expiredReservations}` : 'nada a reconciliar (restore_pending já é false)');
    return EXIT_OK;
  } catch {
    metrics.reservationOp('EXPIRE', 'UNAVAILABLE');
    complain('reconciliação falhou; nada foi confirmado');
    return EXIT_FAILURE;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function runMarkPending(): Promise<number> {
  const config = configOrNull(() => loadMigrationConfig(process.env));
  if (config === null) return EXIT_USAGE;
  const pool = migrationPool(config);
  try {
    const result = await new PgRestoreReconciliation(pool, config.db).markPending(new SystemClock().now().toISOString());
    say(result.changed ? 'restore_pending marcado: o serviço fica not-ready até reconcile-after-restore' : 'restore_pending já estava marcado');
    return EXIT_OK;
  } catch {
    complain('marcação falhou; nada foi confirmado');
    return EXIT_FAILURE;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function runVerifyPrivileges(): Promise<number> {
  const config = configOrNull(() => loadConfig(process.env));
  if (config === null) return EXIT_USAGE;
  const pool = runtimePool(config);
  try {
    const report = await new PgPrivilegeInspector(pool, { statementTimeoutMs: config.db.statementTimeoutMs, connectionTimeoutMs: config.db.connectionTimeoutMs, logger: new JsonLogger(config.logLevel) }).inspect();
    if (report.ok) {
      say('privilégios de runtime no mínimo');
      return EXIT_OK;
    }
    // Códigos fixos de categoria; sem nomes de objetos.
    complain(`privilégios de runtime acima do mínimo ou não verificáveis: ${report.violations.join(',')}`);
    return EXIT_FAILURE;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

function runHealthcheck(): Promise<number> {
  const config = configOrNull(() => loadConfig(process.env));
  if (config === null) return Promise.resolve(EXIT_USAGE);
  if (!config.http.enabled) {
    complain('RISK_HTTP_ENABLED não é true');
    return Promise.resolve(EXIT_USAGE);
  }
  const { port, requestTimeoutMs } = config.http;
  const host = healthProbeHost(config.http);
  return new Promise((resolve) => {
    const req = get({ host, port, path: '/health/live', timeout: requestTimeoutMs }, (res) => {
      res.resume();
      if (res.statusCode === 200) {
        say('live');
        resolve(EXIT_OK);
      } else {
        complain('healthcheck: resposta diferente de 200');
        resolve(EXIT_FAILURE);
      }
    });
    req.on('timeout', () => {
      req.destroy();
    });
    req.on('error', () => {
      complain('healthcheck: serviço indisponível');
      resolve(EXIT_FAILURE);
    });
  });
}

async function main(argv: readonly string[]): Promise<number> {
  if (argv.length !== 1) {
    complain('uso: main <migrate|expire-reservations|reconcile-after-restore|mark-restore-pending|verify-runtime-privileges|healthcheck>');
    return EXIT_USAGE;
  }
  switch (argv[0]) {
    case 'migrate':
      return runMigrate();
    case 'expire-reservations':
      return runExpire();
    case 'reconcile-after-restore':
      return runReconcile();
    case 'mark-restore-pending':
      return runMarkPending();
    case 'verify-runtime-privileges':
      return runVerifyPrivileges();
    case 'healthcheck':
      return runHealthcheck();
    default:
      complain('subcomando desconhecido');
      return EXIT_USAGE;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    complain('falha inesperada');
    process.exitCode = EXIT_FAILURE;
  },
);

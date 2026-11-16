import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ExpireRiskReservations } from '../../src/application/ExpireRiskReservations.js';
import type { RiskUnitOfWork } from '../../src/application/ports/RiskUnitOfWork.js';
import type { TransactionManager } from '../../src/application/ports/TransactionManager.js';
import { PgPrivilegeInspector } from '../../src/infrastructure/postgres/PgPrivilegeInspector.js';
import { PgReadinessProbe } from '../../src/infrastructure/postgres/PgReadinessProbe.js';
import { PgTransactionManager } from '../../src/infrastructure/postgres/PgTransactionManager.js';
import { migrate, readBundledMigrations } from '../../src/infrastructure/postgres/migrate.js';
import { CryptoIdGenerator } from '../../src/infrastructure/system/CryptoIdGenerator.js';
import { createIsolatedDatabase, createRuntimeLogin, MIGRATIONS_DIR, type IsolatedDatabase, type RuntimeLogin } from './support/database.js';
import { CapturingLogger, MutableClock, TEST_DB_TIMEOUTS } from './support/harness.js';
import { RecordingMetrics } from './support/metrics.js';

// Cliente do pool EM USO que perde a conexão (pg_terminate_backend, reinício) emite 'error'; sem listener vira
// uncaughtException. Com guardClient, a operação falha fechada e o cliente é destruído. O vitest falha a execução
// se houver exceção não tratada, então "sem uncaught" é verificado implicitamente (e com espera do evento tardio).
let db: IsolatedDatabase;
let rt: RuntimeLogin;
const uncaught: unknown[] = [];
const onUncaught = (e: unknown) => uncaught.push(e);

beforeAll(async () => {
  db = await createIsolatedDatabase();
  rt = await createRuntimeLogin(db);
});
afterAll(async () => {
  await rt.drop();
  await db.drop();
});
beforeEach(() => {
  uncaught.length = 0;
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUncaught);
});
afterEach(() => {
  process.off('uncaughtException', onUncaught);
  process.off('unhandledRejection', onUncaught);
});
const settle = () => new Promise((r) => setTimeout(r, 300));

const killRuntimeBackends = () =>
  db.pool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1 AND state LIKE 'idle in transaction%'`, [rt.role]);

describe('conexão perdida com o cliente em uso', () => {
  it('PgReadinessProbe: backend morto entre BEGIN e a consulta de schema → schema FAIL, sem exceção não tratada', async () => {
    const pool = new pg.Pool({ connectionString: rt.url, max: 3 });
    pool.on('error', () => undefined);
    const probe = new PgReadinessProbe({
      pool,
      bundledMigrations: async () => {
        await killRuntimeBackends();
        return readBundledMigrations(MIGRATIONS_DIR);
      },
      privileges: new PgPrivilegeInspector(pool, { statementTimeoutMs: 10_000 }),
      statementTimeoutMs: 10_000,
    });
    try {
      const report = await probe.check();
      expect(report.schema).toBe('FAIL');
      await settle();
      expect(uncaught).toEqual([]);
    } finally {
      await pool.end().catch(() => undefined);
    }
  });

  it('PgTransactionManager: backend morto durante o work → rejeita; caso de uso: UNAVAILABLE; log só com errorKind; sem uncaught', async () => {
    const pool = new pg.Pool({ connectionString: rt.url, max: 3 });
    pool.on('error', () => undefined);
    const logger = new CapturingLogger();
    const metrics = new RecordingMetrics();
    const inner = new PgTransactionManager(pool, TEST_DB_TIMEOUTS, { logger, metrics });
    const killing: TransactionManager = {
      run: (work) =>
        inner.run(async (uow: RiskUnitOfWork) => {
          await uow.findAccountsWithExpiredReservations('2026-11-13T22:00:00.000Z'); // abre a transação (idle in transaction)
          await killRuntimeBackends();
          return work(uow);
        }),
    };
    const expire = new ExpireRiskReservations({ transactions: killing, clock: new MutableClock(), ids: new CryptoIdGenerator(), metrics });
    try {
      await expect(expire.execute()).rejects.toBeDefined();
      await settle();
      expect(uncaught).toEqual([]);
      expect(metrics.calls).toContain('reservationOp:EXPIRE:UNAVAILABLE');
      expect(metrics.calls.filter((c) => c === 'reservationOp:EXPIRE:OK')).toHaveLength(0);
      expect(metrics.calls.filter((c) => c === 'dependencyFailure:DATABASE')).toHaveLength(1);
      for (const e of logger.entries.filter((x) => x.event === 'db.client_error')) expect(Object.keys(e.fields)).toEqual(['errorKind']);
      // o cliente quebrado não voltou ao pool: nova transação funciona
      await expect(new PgTransactionManager(pool, TEST_DB_TIMEOUTS).run(async (uow) => uow.findAccountsWithExpiredReservations('2026-11-13T22:00:00.000Z'))).resolves.toEqual([]);
    } finally {
      await pool.end().catch(() => undefined);
    }
  });

  it('migrate: conexão derrubada no meio → falha (rejeita) sem exceção não tratada', async () => {
    const empty = await createIsolatedDatabase(3, { migrate: false });
    const pool = new pg.Pool({ connectionString: empty.url, max: 2 });
    pool.on('error', () => undefined);
    const realConnect = pool.connect.bind(pool) as () => Promise<pg.PoolClient>;
    (pool as unknown as { connect: () => Promise<pg.PoolClient> }).connect = async () => {
      const client = await realConnect();
      const realQuery = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
      let n = 0;
      (client as unknown as { query: (...a: unknown[]) => Promise<unknown> }).query = async (...args: unknown[]) => {
        n += 1;
        if (n === 2) {
          // derruba o próprio backend deste cliente antes da 2ª consulta
          const { rows } = await empty.pool.query<{ pid: number }>(`SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'idle'`);
          for (const r of rows) await empty.pool.query('SELECT pg_terminate_backend($1)', [r.pid]);
          await settle();
        }
        return realQuery(...args);
      };
      return client;
    };
    try {
      await expect(migrate(pool, MIGRATIONS_DIR)).rejects.toBeDefined();
      await settle();
      expect(uncaught).toEqual([]);
    } finally {
      await pool.end().catch(() => undefined);
      await empty.drop().catch(() => undefined);
    }
  });
});


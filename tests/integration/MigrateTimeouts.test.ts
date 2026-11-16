import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { migrate, type MigrateTimeouts } from '../../src/infrastructure/postgres/migrate.js';
import { PgRestoreReconciliation } from '../../src/infrastructure/postgres/PgRestoreReconciliation.js';
import { count, createIsolatedDatabase, MIGRATIONS_DIR, seedAccount, seedPolicy, type IsolatedDatabase } from './support/database.js';
import { AGENT, harness, uniqueProposal } from './support/harness.js';

// Prazos de migração e reconciliação (etapa 2.5, onda 5). Valores FICTÍCIOS; banco descartável *_test.
const KEY = 7_340_011_001; // chave do advisory lock de migração (espelha migrate.ts)
const TIMEOUTS: MigrateTimeouts = { connectionTimeoutMs: 2000, statementTimeoutMs: 4000, lockTimeoutMs: 400 };
/** Teto de uma falha por lock_timeout: o lock_timeout + folga de rede/CI; sempre MUITO abaixo do statement timeout. */
const LOCK_CEILING_MS = TIMEOUTS.lockTimeoutMs + 1500;

const opened: pg.Client[] = [];
const dirs: string[] = [];
let admin: IsolatedDatabase;
afterEach(async () => {
  while (opened.length > 0) await opened.pop()?.end().catch(() => undefined);
  while (dirs.length > 0) rmSync(dirs.pop() ?? '', { recursive: true, force: true });
});
beforeAll(async () => {
  // Só para garantir que o ambiente de integração existe antes dos casos (cada caso cria o seu banco).
  admin = await createIsolatedDatabase(2);
});
afterAll(async () => admin.drop());

/** Sessão separada (outro backend) que segura algo no banco `url`. */
async function session(url: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: url });
  c.on('error', () => undefined);
  await c.connect();
  opened.push(c);
  return c;
}

const tmpMigrations = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), 'risk-mig-'));
  dirs.push(dir);
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
};

const elapsed = async (fn: () => Promise<unknown>): Promise<{ ms: number; error: unknown }> => {
  const t0 = Date.now();
  try {
    await fn();
    return { ms: Date.now() - t0, error: undefined };
  } catch (error) {
    return { ms: Date.now() - t0, error };
  }
};

describe('migrate com prazos', () => {
  it('aplica tudo e é idempotente; reexecução é no-op', async () => {
    const db = await createIsolatedDatabase(3, { migrate: false });
    try {
      const first = await migrate(db.pool, MIGRATIONS_DIR, TIMEOUTS);
      expect(first.map((m) => m.version)).toEqual(['0001_initial.sql', '0002_access_grants.sql', '0003_runtime_privileges.sql', '0004_restore_reconciliation.sql']);
      expect(await migrate(db.pool, MIGRATIONS_DIR, TIMEOUTS)).toEqual([]);
      expect(await count(db.pool, 'schema_migrations')).toBe(4);
    } finally {
      await db.drop();
    }
  });

  it('advisory lock de migração segurado por OUTRA sessão: falha dentro do lock_timeout, sem aplicar nada; depois do unlock, migra', async () => {
    const db = await createIsolatedDatabase(3, { migrate: false });
    try {
      const holder = await session(db.url);
      await holder.query('SELECT pg_advisory_lock($1)', [KEY]);
      const { ms, error } = await elapsed(() => migrate(db.pool, MIGRATIONS_DIR, TIMEOUTS));
      expect(error).toBeInstanceOf(Error);
      expect((error as { code?: string }).code).toBe('55P03'); // lock_not_available: foi o lock_timeout, não o prazo do cliente
      expect(ms).toBeLessThan(LOCK_CEILING_MS);
      expect(ms).toBeLessThan(TIMEOUTS.statementTimeoutMs);
      expect((await db.pool.query(`SELECT to_regclass('schema_migrations') AS t`)).rows[0]).toEqual({ t: null });
      expect((await db.pool.query(`SELECT 1 FROM pg_tables WHERE tablename = 'risk_accounts'`)).rowCount).toBe(0);
      // O cliente da tentativa falha não deixa conexão presa nem lock fantasma do nosso lado.
      expect(db.pool.waitingCount).toBe(0);

      await holder.query('SELECT pg_advisory_unlock($1)', [KEY]);
      expect((await migrate(db.pool, MIGRATIONS_DIR, TIMEOUTS)).length).toBe(4);
    } finally {
      await db.drop();
    }
  });

  it('dois migradores com prazos concorrentes: um migra, o outro espera (ou falha por lock_timeout) e o resultado final é 4 migrações exatamente uma vez', async () => {
    const db = await createIsolatedDatabase(4, { migrate: false });
    try {
      const generous: MigrateTimeouts = { connectionTimeoutMs: 5000, statementTimeoutMs: 20_000, lockTimeoutMs: 20_000 };
      const results = await Promise.allSettled([migrate(db.pool, MIGRATIONS_DIR, generous), migrate(db.pool, MIGRATIONS_DIR, generous)]);
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      const applied = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
      expect(applied.map((m) => m.version).sort()).toEqual(['0001_initial.sql', '0002_access_grants.sql', '0003_runtime_privileges.sql', '0004_restore_reconciliation.sql']);
      expect(await count(db.pool, 'schema_migrations')).toBe(4);
    } finally {
      await db.drop();
    }
  });

  it('migração mais lenta que statement_timeout falha, dá rollback e não registra a versão', async () => {
    const db = await createIsolatedDatabase(3, { migrate: false });
    try {
      const dir = tmpMigrations({ '0001_ok.sql': 'CREATE TABLE tmp_mig_ok (x int);', '0002_slow.sql': 'CREATE TABLE tmp_mig_slow (x int); SELECT pg_sleep(10);' });
      const { ms, error } = await elapsed(() => migrate(db.pool, dir, { connectionTimeoutMs: 2000, statementTimeoutMs: 400, lockTimeoutMs: 400 }));
      expect(error).toBeInstanceOf(Error);
      expect(ms).toBeLessThan(400 + 2000 + 2000);
      expect((await db.pool.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map((r) => r.version)).toEqual(['0001_ok.sql']);
      expect((await db.pool.query(`SELECT to_regclass('tmp_mig_slow') AS t`)).rows[0]).toEqual({ t: null });
      // O lock de migração foi liberado (a sessão foi destruída): um novo migrador não espera.
      const holder = await session(db.url);
      expect((await holder.query('SELECT pg_try_advisory_lock($1) AS ok', [KEY])).rows[0]).toEqual({ ok: true });
    } finally {
      await db.drop();
    }
  });

  it('migração que espera um lock de tabela (DDL bloqueada) falha por lock_timeout, não fica esperando', async () => {
    const db = await createIsolatedDatabase(3, { migrate: false });
    try {
      await migrate(db.pool, tmpMigrations({ '0001_base.sql': 'CREATE TABLE tmp_mig_lock (x int);' }), TIMEOUTS);
      const holder = await session(db.url);
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE tmp_mig_lock IN ACCESS EXCLUSIVE MODE');
      const dir = tmpMigrations({ '0001_base.sql': 'CREATE TABLE tmp_mig_lock (x int);', '0002_alter.sql': 'ALTER TABLE tmp_mig_lock ADD COLUMN y int;' });
      const { ms, error } = await elapsed(() => migrate(db.pool, dir, TIMEOUTS));
      expect((error as { code?: string }).code).toBe('55P03');
      expect(ms).toBeLessThan(LOCK_CEILING_MS);
      await holder.query('ROLLBACK');
      expect((await db.pool.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map((r) => r.version)).toEqual(['0001_base.sql']);
    } finally {
      await db.drop();
    }
  });

  it('checksum alterado continua interrompendo com prazos (migrações imutáveis)', async () => {
    const db = await createIsolatedDatabase(2, { migrate: false });
    try {
      const dir = tmpMigrations({ '0001_x.sql': 'CREATE TABLE tmp_x (a int);' });
      await migrate(db.pool, dir, TIMEOUTS);
      writeFileSync(join(dir, '0001_x.sql'), 'CREATE TABLE tmp_x (a int, b int);');
      await expect(migrate(db.pool, dir, TIMEOUTS)).rejects.toThrow(/alterada/);
    } finally {
      await db.drop();
    }
  });
});

describe('PgRestoreReconciliation com prazos', () => {
  async function seeded() {
    const db = await createIsolatedDatabase(6);
    await seedAccount(db.pool);
    await seedPolicy(db.pool);
    return db;
  }
  const state = async (db: IsolatedDatabase) => (await db.pool.query<{ restore_pending: boolean }>('SELECT restore_pending FROM risk_operational_state')).rows[0]?.restore_pending;
  const NOW = '2026-11-14T12:00:00.000Z';

  it('sem prazos continua funcionando (legado de testes) e com prazos concluem normalmente', async () => {
    const db = await seeded();
    try {
      const r = new PgRestoreReconciliation(db.pool, TIMEOUTS);
      expect(await r.markPending(NOW)).toEqual({ changed: true });
      expect(await r.markPending(NOW)).toEqual({ changed: false });
      expect(await r.reconcile(NOW)).toEqual({ reconciled: true, expiredReservations: 0 });
      expect(await r.reconcile(NOW)).toEqual({ reconciled: false, expiredReservations: 0 });
      const legacy = new PgRestoreReconciliation(db.pool);
      expect(await legacy.markPending(NOW)).toEqual({ changed: true });
      expect(await legacy.reconcile(NOW)).toMatchObject({ reconciled: true });
    } finally {
      await db.drop();
    }
  });

  it.each(['markPending', 'reconcile'] as const)('%s: linha de estado travada por outra transação → falha por lock_timeout, sem alterar nada', async (op) => {
    const db = await seeded();
    try {
      const r = new PgRestoreReconciliation(db.pool, TIMEOUTS);
      if (op === 'reconcile') await r.markPending(NOW);
      const before = { pending: await state(db), audit: await count(db.pool, 'risk_audit_events') };
      const holder = await session(db.url);
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM risk_operational_state WHERE singleton FOR UPDATE');
      const { ms, error } = await elapsed(() => r[op](NOW));
      expect((error as { code?: string }).code).toBe('55P03');
      expect(ms).toBeLessThan(LOCK_CEILING_MS);
      await holder.query('ROLLBACK');
      expect({ pending: await state(db), audit: await count(db.pool, 'risk_audit_events') }).toEqual(before);
      expect(db.pool.waitingCount).toBe(0);
    } finally {
      await db.drop();
    }
  });

  it('reconcile: advisory lock da conta segurado por avaliação em voo → falha por lock_timeout; reservas seguem ACTIVE e a pendência continua ligada', async () => {
    const db = await seeded();
    try {
      const h = harness(db.pool);
      const first = await h.evaluate.execute({ proposal: uniqueProposal(), authenticatedAgentId: AGENT });
      if (first.kind !== 'DECISION' || first.decision.status !== 'ALLOW_PAPER') throw new Error('esperava ALLOW_PAPER');
      const r = new PgRestoreReconciliation(db.pool, TIMEOUTS);
      await r.markPending(NOW);
      const holder = await session(db.url);
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['paper-fixture']);
      const { ms, error } = await elapsed(() => r.reconcile(NOW));
      expect((error as { code?: string }).code).toBe('55P03');
      expect(ms).toBeLessThan(LOCK_CEILING_MS);
      await holder.query('ROLLBACK');
      expect(await state(db)).toBe(true);
      expect((await db.pool.query('SELECT status FROM risk_reservations WHERE reservation_id = $1', [first.decision.reservationId])).rows[0]).toEqual({ status: 'ACTIVE' });
      expect(await count(db.pool, 'risk_audit_events', `event_type = 'RESTORE_RECONCILED'`)).toBe(0);
      // Sem o lock, a mesma operação conclui e expira a reserva.
      expect(await r.reconcile(NOW)).toEqual({ reconciled: true, expiredReservations: 1 });
    } finally {
      await db.drop();
    }
  });
});

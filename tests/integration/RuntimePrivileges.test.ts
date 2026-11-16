import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIsolatedDatabase, createRuntimeLogin, MIGRATIONS_DIR, RUNTIME_GROUP, type IsolatedDatabase, type RuntimeLogin } from './support/database.js';

// Privilégios mínimos do runtime (etapa 2.5, achado B8). Tudo FICTÍCIO; banco descartável *_test.
const APPEND_ONLY = ['trade_proposals', 'risk_decisions', 'risk_audit_events', 'risk_outbox'] as const;
const READ_ONLY = ['risk_accounts', 'risk_policies', 'risk_access_grants', 'schema_migrations'] as const;
// Uma coluna real por tabela, para o UPDATE só falhar por privilégio (nunca por coluna inexistente).
const UPDATE_COLUMN: Record<string, string> = {
  trade_proposals: 'correlation_id',
  risk_decisions: 'status',
  risk_audit_events: 'event_type',
  risk_outbox: 'event_type',
  risk_accounts: 'environment',
  risk_policies: 'policy_hash',
  risk_access_grants: 'revoked_at',
  schema_migrations: 'checksum',
};
const DOMAIN_TABLES = [...APPEND_ONLY, 'risk_reservations', 'risk_accounts', 'risk_policies', 'risk_access_grants'] as const;

let db: IsolatedDatabase;
let rt: RuntimeLogin;

beforeAll(async () => {
  db = await createIsolatedDatabase();
  rt = await createRuntimeLogin(db);
});
afterAll(async () => {
  await rt.drop();
  await db.drop();
});

async function sqlState(pool: pg.Pool, sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await pool.query(sql, params);
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? 'sem-codigo';
  }
}

describe('login de runtime de teste', () => {
  it('não é superuser nem owner e herda o grupo', async () => {
    const { rows } = await rt.pool.query<{ su: boolean; member: boolean; owner: string }>(
      `SELECT r.rolsuper AS su, pg_has_role(current_user, '${RUNTIME_GROUP}', 'USAGE') AS member,
              (SELECT tableowner FROM pg_tables WHERE tablename = 'risk_reservations') AS owner
       FROM pg_roles r WHERE r.rolname = current_user`,
    );
    expect(rows[0]?.su).toBe(false);
    expect(rows[0]?.member).toBe(true);
    expect(rows[0]?.owner).not.toBe(rt.role);
  });
});

describe('append-only: runtime não altera nem apaga', () => {
  for (const table of APPEND_ONLY) {
    it(`${table}: UPDATE, DELETE e TRUNCATE negados`, async () => {
      expect(await sqlState(rt.pool, `UPDATE ${table} SET ${UPDATE_COLUMN[table] ?? ''} = ${UPDATE_COLUMN[table] ?? ''} WHERE FALSE`)).toBe('42501');
      expect(await sqlState(rt.pool, `DELETE FROM ${table} WHERE FALSE`)).toBe('42501');
      expect(await sqlState(rt.pool, `TRUNCATE ${table} CASCADE`)).toBe('42501');
    });
  }

  for (const table of READ_ONLY) {
    it(`${table}: somente leitura (INSERT, UPDATE, DELETE, TRUNCATE negados; SELECT permitido)`, async () => {
      expect(await sqlState(rt.pool, `SELECT 1 FROM ${table} LIMIT 1`)).toBeNull();
      expect(await sqlState(rt.pool, `UPDATE ${table} SET ${UPDATE_COLUMN[table] ?? ''} = ${UPDATE_COLUMN[table] ?? ''} WHERE FALSE`)).toBe('42501');
      expect(await sqlState(rt.pool, `DELETE FROM ${table} WHERE FALSE`)).toBe('42501');
      expect(await sqlState(rt.pool, `TRUNCATE ${table} CASCADE`)).toBe('42501');
      // INSERT sem linhas válidas: o teste de privilégio vem antes de qualquer constraint.
      expect(await sqlState(rt.pool, `INSERT INTO ${table} SELECT * FROM ${table} WHERE FALSE`)).toBe('42501');
    });
  }

  it('risk_reservations: DELETE e TRUNCATE negados', async () => {
    expect(await sqlState(rt.pool, `DELETE FROM risk_reservations WHERE FALSE`)).toBe('42501');
    expect(await sqlState(rt.pool, `TRUNCATE risk_reservations CASCADE`)).toBe('42501');
  });

  it('nenhuma tabela de domínio concede DELETE, TRUNCATE ou REFERENCES/TRIGGER ao runtime', async () => {
    for (const table of [...DOMAIN_TABLES, 'schema_migrations']) {
      const { rows } = await db.pool.query<{ priv: string; ok: boolean }>(
        `SELECT p AS priv, has_table_privilege('${RUNTIME_GROUP}', $1, p) AS ok FROM unnest(ARRAY['DELETE','TRUNCATE','REFERENCES','TRIGGER']) p`,
        [table],
      );
      expect(rows.filter((r) => r.ok), table).toEqual([]);
    }
  });
});

describe('risk_reservations: UPDATE só em status, closed_at, paper_order_id', () => {
  it('colunas permitidas e negadas no catálogo', async () => {
    const { rows } = await db.pool.query<{ column_name: string; ok: boolean }>(
      `SELECT column_name, has_column_privilege('${RUNTIME_GROUP}', 'risk_reservations', column_name, 'UPDATE') AS ok
       FROM information_schema.columns WHERE table_name = 'risk_reservations' AND table_schema = 'public'`,
    );
    expect(rows.filter((r) => r.ok).map((r) => r.column_name).sort()).toEqual(['closed_at', 'paper_order_id', 'status']);
  });

  it('UPDATE de coluna não permitida é negado (42501), mesmo sem linhas afetadas', async () => {
    for (const col of ['exposure_base', 'risk_base', 'expires_at', 'account_id', 'created_at', 'reservation_id', 'decision_id']) {
      expect(await sqlState(rt.pool, `UPDATE risk_reservations SET ${col} = ${col} WHERE FALSE`), col).toBe('42501');
    }
  });

  it('UPDATE das colunas permitidas passa pelo controle de privilégio', async () => {
    expect(await sqlState(rt.pool, `UPDATE risk_reservations SET status = status, closed_at = closed_at, paper_order_id = paper_order_id WHERE FALSE`)).toBeNull();
  });

  it('UPDATE com coluna proibida misturada a permitidas continua negado', async () => {
    expect(await sqlState(rt.pool, `UPDATE risk_reservations SET status = status, risk_base = risk_base WHERE FALSE`)).toBe('42501');
  });
});

describe('INSERT e SELECT permitidos ao runtime', () => {
  it('risk_audit_events e risk_outbox: INSERT e SELECT funcionam', async () => {
    const id = randomUUID();
    await rt.pool.query(`INSERT INTO risk_audit_events (event_id, event_type, details_json, created_at) VALUES ($1, 'FIXTURE', '{}', now())`, [id]);
    await rt.pool.query(`INSERT INTO risk_outbox (event_id, aggregate_id, event_type, payload_json, created_at) VALUES ($1, 'fixture', 'FIXTURE', '{}', now())`, [id]);
    const a = await rt.pool.query(`SELECT 1 FROM risk_audit_events WHERE event_id = $1`, [id]);
    const o = await rt.pool.query(`SELECT 1 FROM risk_outbox WHERE event_id = $1`, [id]);
    expect(a.rowCount).toBe(1);
    expect(o.rowCount).toBe(1);
    // Append-only vale também para o que o próprio runtime escreveu.
    expect(await sqlState(rt.pool, `UPDATE risk_audit_events SET event_type = 'X' WHERE event_id = $1`, [id])).toBe('42501');
    expect(await sqlState(rt.pool, `DELETE FROM risk_outbox WHERE event_id = $1`, [id])).toBe('42501');
  });

  it('risk_reservations: INSERT permitido (reserva órfã é barrada só no COMMIT pela FK diferida)', async () => {
    const client = await rt.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO risk_reservations (reservation_id, decision_id, account_id, instrument, strategy_id, exposure_base, risk_base, status, expires_at, created_at)
         VALUES ($1, $2, 'paper-fixture', 'FIXTURE-BTC-USD', 'fixture', 1, 0, 'ACTIVE', now() + interval '1 minute', now())`,
        [randomUUID(), randomUUID()],
      );
      await expect(client.query('COMMIT')).rejects.toMatchObject({ code: '23503' });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('privilégios de INSERT/SELECT no catálogo para todas as tabelas de escrita', async () => {
    for (const table of [...APPEND_ONLY, 'risk_reservations']) {
      const { rows } = await db.pool.query<{ i: boolean; s: boolean }>(
        `SELECT has_table_privilege('${RUNTIME_GROUP}', $1, 'INSERT') AS i, has_table_privilege('${RUNTIME_GROUP}', $1, 'SELECT') AS s`,
        [table],
      );
      expect(rows[0], table).toEqual({ i: true, s: true });
    }
    for (const table of READ_ONLY) {
      const { rows } = await db.pool.query<{ i: boolean; s: boolean }>(
        `SELECT has_table_privilege('${RUNTIME_GROUP}', $1, 'INSERT') AS i, has_table_privilege('${RUNTIME_GROUP}', $1, 'SELECT') AS s`,
        [table],
      );
      expect(rows[0], table).toEqual({ i: false, s: true });
    }
  });
});

describe('TRUNCATE barrado por trigger, inclusive para o owner/superuser', () => {
  for (const table of DOMAIN_TABLES) {
    it(`${table}: TRUNCATE falha e não apaga linhas`, async () => {
      const before = await db.pool.query(`SELECT count(*)::int AS n FROM ${table}`);
      const code = await sqlState(db.pool, `TRUNCATE ${table} CASCADE`);
      expect(code).not.toBeNull();
      const after = await db.pool.query(`SELECT count(*)::int AS n FROM ${table}`);
      expect(after.rows[0]).toEqual(before.rows[0]);
    });
  }

  it('há trigger BEFORE TRUNCATE em cada tabela de domínio', async () => {
    const { rows } = await db.pool.query<{ rel: string }>(
      `SELECT c.relname AS rel FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE NOT t.tgisinternal AND (t.tgtype & 32) = 32 AND (t.tgtype & 2) = 2`, // 32 = TRUNCATE, 2 = BEFORE
    );
    const covered = new Set(rows.map((r) => r.rel));
    for (const table of DOMAIN_TABLES) expect(covered.has(table), table).toBe(true);
  });

  it('TRUNCATE com linha existente (audit) continua barrado para o owner', async () => {
    const id = randomUUID();
    await db.pool.query(`INSERT INTO risk_audit_events (event_id, event_type, details_json, created_at) VALUES ($1, 'FIXTURE', '{}', now())`, [id]);
    expect(await sqlState(db.pool, `TRUNCATE risk_audit_events`)).not.toBeNull();
    const { rowCount } = await db.pool.query(`SELECT 1 FROM risk_audit_events WHERE event_id = $1`, [id]);
    expect(rowCount).toBe(1);
  });
});

describe('0003: pré-condição da role de runtime', () => {
  it('falha com mensagem clara se a role não existir', async () => {
    // A role é cluster-wide: renomeá-la com COMMIT afetaria arquivos paralelos. O rename abaixo vive
    // numa transação que sempre termina em ROLLBACK, logo é invisível às demais sessões.
    const name = (await readdir(MIGRATIONS_DIR)).find((n) => n.startsWith('0003_'));
    expect(name, 'migração 0003 ausente').toBeDefined();
    const sql = await readFile(join(MIGRATIONS_DIR, name as string), 'utf8');
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL lock_timeout = '5s'`);
      await client.query(`ALTER ROLE ${RUNTIME_GROUP} RENAME TO ${RUNTIME_GROUP}_ausente_tmp`);
      await expect(client.query(sql)).rejects.toThrow(new RegExp(RUNTIME_GROUP));
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
    const { rowCount } = await db.pool.query(`SELECT 1 FROM pg_roles WHERE rolname = '${RUNTIME_GROUP}'`);
    expect(rowCount).toBe(1);
  });
});

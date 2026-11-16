import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPool } from '../../src/infrastructure/postgres/pools.js';
import { PgPrivilegeInspector, type PrivilegeViolation } from '../../src/infrastructure/postgres/PgPrivilegeInspector.js';
import {
  createIsolatedDatabase,
  createRuntimeLogin,
  createTestLogin,
  OWNER_GROUP,
  provisionIsolatedRoles,
  RUNTIME_GROUP,
  type IsolatedDatabase,
  type RuntimeLogin,
  type TestLogin,
} from './support/database.js';

// Inspetor de privilégios (etapa 2.5). Banco descartável *_test; logins e objetos com nomes exclusivos, removidos no teardown.
const TIMEOUT = { statementTimeoutMs: 10_000 } as const;
let db: IsolatedDatabase;
let rt: RuntimeLogin;
const cleanups: (() => Promise<void>)[] = [];
const inspect = (pool: pg.Pool) => new PgPrivilegeInspector(pool, TIMEOUT).inspect();

beforeAll(async () => {
  db = await createIsolatedDatabase();
  rt = await createRuntimeLogin(db); // aplica o equivalente de roles.sql (PUBLIC sem CREATE em public)
});
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});
afterAll(async () => {
  await rt.drop();
  await db.drop();
});

/** Login exclusivo do caso (membro do grupo de runtime) com limpeza registrada. */
async function login(options: Parameters<typeof createTestLogin>[1] = {}): Promise<TestLogin> {
  const l = await createTestLogin(db, options);
  cleanups.push(async () => {
    await l.pool.end().catch(() => undefined);
    await db.pool.query(`REASSIGN OWNED BY ${l.role} TO CURRENT_USER`);
    await db.pool.query(`DROP OWNED BY ${l.role}`);
    await l.drop();
  });
  return l;
}
const ddl = (sql: string, undo: string) => async (): Promise<void> => {
  await db.pool.query(sql);
  cleanups.push(async () => {
    await db.pool.query(undo);
  });
};
const as = async (violations: readonly PrivilegeViolation[], pool: pg.Pool) => {
  const r = await inspect(pool);
  expect(r.ok).toBe(false);
  expect([...r.violations].sort()).toEqual([...violations].sort());
};

describe('login de runtime correto', () => {
  it('aprova: ok=true e nenhuma violação', async () => {
    expect(await inspect(rt.pool)).toEqual({ ok: true, violations: [] });
  });

  it('é idempotente e não deixa transação aberta nem conexão presa', async () => {
    for (let i = 0; i < 5; i++) expect((await inspect(rt.pool)).ok).toBe(true);
    const { rows } = await db.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM pg_stat_activity WHERE usename = $1 AND state LIKE 'idle in transaction%'`, [rt.role]);
    expect(rows[0]?.n).toBe('0');
  });

  it('inspeções concorrentes (pool de 3) completam e devolvem o pool íntegro', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => inspect(rt.pool)));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(rt.pool.idleCount).toBe(rt.pool.totalCount);
  });

  it('só emite leitura: BEGIN READ ONLY, SELECTs e ROLLBACK (nunca COMMIT nem DML/DDL)', async () => {
    const statements: string[] = [];
    const query = vi.fn((sql: string) => {
      statements.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    const fake = { connect: () => Promise.resolve({ query, release: vi.fn(), on: vi.fn(), removeListener: vi.fn() }) } as unknown as pg.Pool;
    await inspect(fake);
    expect(statements[0]).toBe('BEGIN READ ONLY');
    expect(statements.at(-1)).toBe('ROLLBACK');
    for (const st of statements.slice(1, -1)) expect(st).toMatch(/^SELECT /);
    expect(statements.some((st) => /COMMIT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT/.test(st))).toBe(false);
  });
});

describe('atributos e papéis', () => {
  it('superuser reprova com SUPERUSER (e nunca ok)', async () => {
    const r = await inspect(db.pool);
    expect(r.ok).toBe(false);
    expect(r.violations).toContain('SUPERUSER');
  });

  it.each([
    ['CREATEROLE', 'CREATEROLE'],
    ['CREATEDB', 'CREATEDB'],
    ['REPLICATION', 'REPLICATION'],
    ['BYPASSRLS', 'BYPASSRLS'],
  ] as const)('atributo %s → violação %s', async (attribute, code) => {
    const l = await login({ attributes: `NOSUPERUSER ${attribute}` });
    await as([code], l.pool);
  });

  it('membro de openclaw_risk_owner → MEMBER_OF_OWNER', async () => {
    await provisionIsolatedRoles(db);
    const l = await login({ inRoles: [RUNTIME_GROUP, OWNER_GROUP] });
    await as(['MEMBER_OF_OWNER'], l.pool);
  });

  it('membro indireto do owner (via grupo intermediário) também é detectado', async () => {
    await provisionIsolatedRoles(db);
    const mid = `risk_mid_${randomUUID().replaceAll('-', '').slice(0, 10)}_test`;
    await db.pool.query(`CREATE ROLE ${mid} NOLOGIN IN ROLE ${OWNER_GROUP}`);
    cleanups.push(async () => {
      await db.pool.query(`DROP ROLE IF EXISTS ${mid}`);
    });
    const l = await login({ inRoles: [RUNTIME_GROUP, mid] });
    await as(['MEMBER_OF_OWNER'], l.pool);
  });
});

describe('propriedade de objetos e schema', () => {
  it('dono de tabela → OWNS_RELATION', async () => {
    const l = await login();
    const table = `risk_own_${randomUUID().replaceAll('-', '').slice(0, 10)}_test`;
    await ddl(`CREATE TABLE ${table} (x int)`, `DROP TABLE IF EXISTS ${table}`)();
    await db.pool.query(`ALTER TABLE ${table} OWNER TO ${l.role}`);
    // Dono de tabela tem todos os privilégios sobre ela: também é excesso de privilégio de tabela.
    await as(['OWNS_RELATION', 'EXCESS_TABLE_PRIVILEGE'], l.pool);
  });

  it('dono de sequência ou view também é OWNS_RELATION', async () => {
    const l = await login();
    const seq = `risk_seq_${randomUUID().replaceAll('-', '').slice(0, 10)}_test`;
    await ddl(`CREATE SEQUENCE ${seq}`, `DROP SEQUENCE IF EXISTS ${seq}`)();
    await db.pool.query(`ALTER SEQUENCE ${seq} OWNER TO ${l.role}`);
    await as(['OWNS_RELATION'], l.pool);
  });

  it('dono indireto (membro do grupo dono da tabela) → OWNS_RELATION', async () => {
    const group = `risk_ownergrp_${randomUUID().replaceAll('-', '').slice(0, 10)}_test`;
    await db.pool.query(`CREATE ROLE ${group} NOLOGIN`);
    cleanups.push(async () => {
      await db.pool.query(`DROP ROLE IF EXISTS ${group}`);
    });
    const table = `risk_grp_${randomUUID().replaceAll('-', '').slice(0, 10)}_test`;
    await ddl(`CREATE TABLE ${table} (x int)`, `DROP TABLE IF EXISTS ${table}`)();
    await db.pool.query(`ALTER TABLE ${table} OWNER TO ${group}`);
    const l = await login({ inRoles: [RUNTIME_GROUP, group] });
    await as(['OWNS_RELATION', 'EXCESS_TABLE_PRIVILEGE'], l.pool);
  });

  it('CREATE em public concedido ao login → CREATE_ON_PUBLIC', async () => {
    const l = await login();
    await ddl(`GRANT CREATE ON SCHEMA public TO ${l.role}`, `REVOKE CREATE ON SCHEMA public FROM ${l.role}`)();
    await as(['CREATE_ON_PUBLIC'], l.pool);
  });

  it('CREATE em public via PUBLIC (banco sem o REVOKE do roles.sql) → CREATE_ON_PUBLIC', async () => {
    await ddl('GRANT CREATE ON SCHEMA public TO PUBLIC', 'REVOKE CREATE ON SCHEMA public FROM PUBLIC')();
    await as(['CREATE_ON_PUBLIC'], rt.pool);
  });
});

describe('grants de tabela além do mínimo → EXCESS_TABLE_PRIVILEGE', () => {
  const TABLES = ['risk_decisions', 'trade_proposals', 'risk_audit_events', 'risk_outbox', 'risk_reservations', 'risk_accounts', 'risk_policies', 'risk_access_grants', 'schema_migrations'];

  it.each(['DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES'])('%s em qualquer tabela', async (privilege) => {
    for (const table of TABLES) {
      const l = await login();
      await db.pool.query(`GRANT ${privilege} ON ${table} TO ${l.role}`);
      await as(['EXCESS_TABLE_PRIVILEGE'], l.pool);
      await db.pool.query(`REVOKE ${privilege} ON ${table} FROM ${l.role}`);
      expect((await inspect(l.pool)).ok, `${privilege} revogado em ${table}`).toBe(true);
    }
  });

  it('INSERT fora das 5 tabelas permitidas (tabela inteira e só uma coluna)', async () => {
    for (const table of ['risk_accounts', 'risk_policies', 'risk_access_grants', 'schema_migrations']) {
      const whole = await login();
      await db.pool.query(`GRANT INSERT ON ${table} TO ${whole.role}`);
      await as(['EXCESS_TABLE_PRIVILEGE'], whole.pool);
    }
    const col = await login();
    await db.pool.query(`GRANT INSERT (environment) ON risk_accounts TO ${col.role}`);
    await as(['EXCESS_TABLE_PRIVILEGE'], col.pool);
  });

  it('INSERT nas 5 tabelas permitidas é o mínimo (não é violação)', async () => {
    const l = await login();
    for (const table of ['trade_proposals', 'risk_decisions', 'risk_audit_events', 'risk_outbox', 'risk_reservations']) {
      await db.pool.query(`GRANT INSERT ON ${table} TO ${l.role}`);
    }
    expect(await inspect(l.pool)).toEqual({ ok: true, violations: [] });
  });

  it('UPDATE fora das 3 colunas de risk_reservations: tabela inteira, coluna imutável, e coluna permitida em outra tabela', async () => {
    const cases = [
      'GRANT UPDATE ON risk_reservations TO',
      'GRANT UPDATE (expires_at) ON risk_reservations TO',
      'GRANT UPDATE (exposure_base) ON risk_reservations TO',
      'GRANT UPDATE ON risk_decisions TO',
      'GRANT UPDATE (status) ON risk_decisions TO', // mesmo nome de coluna, tabela errada
      'GRANT UPDATE ON risk_accounts TO',
      'GRANT UPDATE (checksum) ON schema_migrations TO',
    ];
    for (const sql of cases) {
      const l = await login();
      await db.pool.query(`${sql} ${l.role}`);
      await as(['EXCESS_TABLE_PRIVILEGE'], l.pool);
    }
  });

  it('UPDATE nas 3 colunas permitidas de risk_reservations é o mínimo; com uma extra deixa de ser', async () => {
    const l = await login();
    await db.pool.query(`GRANT UPDATE (status, closed_at, paper_order_id) ON risk_reservations TO ${l.role}`);
    expect((await inspect(l.pool)).ok).toBe(true);
    await db.pool.query(`GRANT UPDATE (decision_id) ON risk_reservations TO ${l.role}`);
    await as(['EXCESS_TABLE_PRIVILEGE'], l.pool);
  });

  it('grant via PUBLIC é visto por qualquer login (e some quando revogado)', async () => {
    await db.pool.query('GRANT DELETE ON risk_outbox TO PUBLIC');
    try {
      await as(['EXCESS_TABLE_PRIVILEGE'], rt.pool);
    } finally {
      await db.pool.query('REVOKE DELETE ON risk_outbox FROM PUBLIC');
    }
    expect((await inspect(rt.pool)).ok).toBe(true);
  });

  it('grant via grupo adicional (herança) é visto', async () => {
    const group = `risk_extra_${randomUUID().replaceAll('-', '').slice(0, 10)}_test`;
    await db.pool.query(`CREATE ROLE ${group} NOLOGIN`);
    cleanups.push(async () => {
      await db.pool.query(`DROP OWNED BY ${group}`);
      await db.pool.query(`DROP ROLE IF EXISTS ${group}`);
    });
    await db.pool.query(`GRANT TRUNCATE ON risk_decisions TO ${group}`);
    const l = await login({ inRoles: [RUNTIME_GROUP, group] });
    await as(['EXCESS_TABLE_PRIVILEGE'], l.pool);
  });

  it('várias violações acumulam sem repetição', async () => {
    const l = await login({ attributes: 'NOSUPERUSER CREATEDB', inRoles: [RUNTIME_GROUP, OWNER_GROUP] });
    await db.pool.query(`GRANT DELETE ON risk_decisions TO ${l.role}`);
    await as(['CREATEDB', 'MEMBER_OF_OWNER', 'EXCESS_TABLE_PRIVILEGE'], l.pool);
  });
});

describe('privilégios no banco: CREATE e TEMP', () => {
  const dbName = () => new URL(db.url).pathname.slice(1);

  it('TEMP concedido ao login → TEMP_ON_DATABASE', async () => {
    const l = await login();
    await ddl(`GRANT TEMP ON DATABASE ${dbName()} TO ${l.role}`, `REVOKE TEMP ON DATABASE ${dbName()} FROM ${l.role}`)();
    await as(['TEMP_ON_DATABASE'], l.pool);
  });

  it('TEMP via PUBLIC (banco sem o REVOKE do roles.sql) → TEMP_ON_DATABASE, e some ao revogar', async () => {
    await db.pool.query(`GRANT TEMP ON DATABASE ${dbName()} TO PUBLIC`);
    try {
      await as(['TEMP_ON_DATABASE'], rt.pool);
    } finally {
      await db.pool.query(`REVOKE TEMP ON DATABASE ${dbName()} FROM PUBLIC`);
    }
    expect(await inspect(rt.pool)).toEqual({ ok: true, violations: [] });
  });

  it('CREATE no banco concedido ao login → CREATE_ON_DATABASE', async () => {
    const l = await login();
    await ddl(`GRANT CREATE ON DATABASE ${dbName()} TO ${l.role}`, `REVOKE CREATE ON DATABASE ${dbName()} FROM ${l.role}`)();
    await as(['CREATE_ON_DATABASE'], l.pool);
  });

  it('CREATE no banco via PUBLIC e via grupo herdado → CREATE_ON_DATABASE', async () => {
    await db.pool.query(`GRANT CREATE ON DATABASE ${dbName()} TO PUBLIC`);
    try {
      await as(['CREATE_ON_DATABASE'], rt.pool);
    } finally {
      await db.pool.query(`REVOKE CREATE ON DATABASE ${dbName()} FROM PUBLIC`);
    }
    const group = `risk_dbgrp_${randomUUID().replaceAll('-', '').slice(0, 10)}_test`;
    await db.pool.query(`CREATE ROLE ${group} NOLOGIN`);
    await db.pool.query(`GRANT CREATE ON DATABASE ${dbName()} TO ${group}`);
    cleanups.push(async () => {
      await db.pool.query(`REVOKE CREATE ON DATABASE ${dbName()} FROM ${group}`);
      await db.pool.query(`DROP ROLE IF EXISTS ${group}`);
    });
    const l = await login({ inRoles: [RUNTIME_GROUP, group] });
    await as(['CREATE_ON_DATABASE'], l.pool);
  });

  it('TEMP e CREATE juntos acumulam as duas violações, sem repetir', async () => {
    const l = await login();
    await db.pool.query(`GRANT TEMP, CREATE ON DATABASE ${dbName()} TO ${l.role}`);
    cleanups.push(async () => {
      await db.pool.query(`REVOKE TEMP, CREATE ON DATABASE ${dbName()} FROM ${l.role}`);
    });
    await as(['CREATE_ON_DATABASE', 'TEMP_ON_DATABASE'], l.pool);
  });

  it('CONNECT sozinho no banco (o que o runtime precisa) não é violação', async () => {
    expect(await inspect(rt.pool)).toEqual({ ok: true, violations: [] });
  });
});

describe('schemas além de public: OWNS_OR_CREATES_IN_SCHEMA', () => {
  const schemaName = () => `risk_sch_${randomUUID().replaceAll('-', '').slice(0, 10)}_test`;
  const mkSchema = async (name: string, authorization = ''): Promise<void> => {
    await db.pool.query(`CREATE SCHEMA ${name}${authorization}`);
    cleanups.push(async () => {
      await db.pool.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
    });
  };

  it('schema com CREATE para PUBLIC → OWNS_OR_CREATES_IN_SCHEMA (e só ele)', async () => {
    const l = await login();
    const sch = schemaName();
    await mkSchema(sch);
    await db.pool.query(`GRANT CREATE ON SCHEMA ${sch} TO PUBLIC`);
    await as(['OWNS_OR_CREATES_IN_SCHEMA'], l.pool);
  });

  it('schema com CREATE concedido ao próprio login ou a um grupo herdado → OWNS_OR_CREATES_IN_SCHEMA', async () => {
    const l = await login();
    const sch = schemaName();
    await mkSchema(sch);
    await db.pool.query(`GRANT CREATE ON SCHEMA ${sch} TO ${l.role}`);
    await as(['OWNS_OR_CREATES_IN_SCHEMA'], l.pool);
    await db.pool.query(`REVOKE CREATE ON SCHEMA ${sch} FROM ${l.role}`);
    expect((await inspect(l.pool)).ok).toBe(true);
    await db.pool.query(`GRANT CREATE ON SCHEMA ${sch} TO ${RUNTIME_GROUP}`);
    try {
      await as(['OWNS_OR_CREATES_IN_SCHEMA'], l.pool);
    } finally {
      await db.pool.query(`REVOKE CREATE ON SCHEMA ${sch} FROM ${RUNTIME_GROUP}`);
    }
  });

  it('schema PRÓPRIO do login (CREATE SCHEMA ... AUTHORIZATION login) → OWNS_OR_CREATES_IN_SCHEMA', async () => {
    const l = await login();
    await mkSchema(schemaName(), ` AUTHORIZATION ${l.role}`);
    await as(['OWNS_OR_CREATES_IN_SCHEMA'], l.pool);
  });

  it('schema de mesmo nome do login (alvo do "$user" no search_path) → OWNS_OR_CREATES_IN_SCHEMA', async () => {
    const l = await login();
    await mkSchema(`"${l.role}"`, ` AUTHORIZATION ${l.role}`);
    await as(['OWNS_OR_CREATES_IN_SCHEMA'], l.pool);
  });

  it('dono indireto (membro do grupo dono do schema) → OWNS_OR_CREATES_IN_SCHEMA', async () => {
    const group = `risk_schgrp_${randomUUID().replaceAll('-', '').slice(0, 10)}_test`;
    await db.pool.query(`CREATE ROLE ${group} NOLOGIN`);
    cleanups.push(async () => {
      await db.pool.query(`DROP OWNED BY ${group}`);
      await db.pool.query(`DROP ROLE IF EXISTS ${group}`);
    });
    await mkSchema(schemaName(), ` AUTHORIZATION ${group}`);
    const l = await login({ inRoles: [RUNTIME_GROUP, group] });
    await as(['OWNS_OR_CREATES_IN_SCHEMA'], l.pool);
  });

  it('schema alheio só com USAGE para o login NÃO é violação', async () => {
    const l = await login();
    const sch = schemaName();
    await mkSchema(sch);
    await db.pool.query(`GRANT USAGE ON SCHEMA ${sch} TO ${l.role}`);
    expect(await inspect(l.pool)).toEqual({ ok: true, violations: [] });
  });

  it('o inspetor não depende do search_path: um schema de sistema nunca aparece como violação', async () => {
    const pool = createPool({ connectionString: rt.url, connectionTimeoutMs: 5000, max: 1 });
    try {
      expect(await inspect(pool)).toEqual({ ok: true, violations: [] });
    } finally {
      await pool.end();
    }
  });
});

describe('histórico do estado operacional é do operador: SELECT → EXCESS_TABLE_PRIVILEGE', () => {
  it('SELECT na tabela inteira concedido ao login', async () => {
    const l = await login();
    await db.pool.query(`GRANT SELECT ON risk_operational_state_history TO ${l.role}`);
    await as(['EXCESS_TABLE_PRIVILEGE'], l.pool);
    await db.pool.query(`REVOKE SELECT ON risk_operational_state_history FROM ${l.role}`);
    expect((await inspect(l.pool)).ok).toBe(true);
  });

  it('SELECT em apenas UMA coluna também reprova', async () => {
    const l = await login();
    const { rows } = await db.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'risk_operational_state_history' ORDER BY ordinal_position LIMIT 1`,
    );
    const column = rows[0]?.column_name;
    expect(column).toBeDefined();
    await db.pool.query(`GRANT SELECT (${column}) ON risk_operational_state_history TO ${l.role}`);
    await as(['EXCESS_TABLE_PRIVILEGE'], l.pool);
  });

  it('SELECT via PUBLIC ou via grupo herdado reprova', async () => {
    await db.pool.query('GRANT SELECT ON risk_operational_state_history TO PUBLIC');
    try {
      await as(['EXCESS_TABLE_PRIVILEGE'], rt.pool);
    } finally {
      await db.pool.query('REVOKE SELECT ON risk_operational_state_history FROM PUBLIC');
    }
    expect((await inspect(rt.pool)).ok).toBe(true);
    await db.pool.query(`GRANT SELECT ON risk_operational_state_history TO ${RUNTIME_GROUP}`);
    try {
      await as(['EXCESS_TABLE_PRIVILEGE'], rt.pool);
    } finally {
      await db.pool.query(`REVOKE SELECT ON risk_operational_state_history FROM ${RUNTIME_GROUP}`);
    }
  });

  it('o runtime correto não enxerga o histórico (sem SELECT) e SELECT em risk_operational_state continua permitido', async () => {
    await expect(rt.pool.query('SELECT 1 FROM risk_operational_state_history')).rejects.toMatchObject({ code: '42501' });
    await expect(rt.pool.query('SELECT restore_pending FROM risk_operational_state')).resolves.toBeDefined();
    expect((await inspect(rt.pool)).ok).toBe(true);
  });
});

describe('sombreamento por schema (M2): search_path fixo em public', () => {
  it('createPool fixa search_path=public (inclusive com schema "$user" do login); um Pool comum resolve o schema falso', async () => {
    const l = await login();
    const sch = `"${l.role}"`;
    await db.pool.query(`CREATE SCHEMA ${sch} AUTHORIZATION ${l.role}`);
    cleanups.push(async () => {
      await db.pool.query(`DROP SCHEMA IF EXISTS ${sch} CASCADE`);
    });
    // Tabelas FALSAS no schema do login, com o mesmo nome das reais e colunas diferentes.
    for (const t of ['risk_operational_state', 'risk_reservations']) {
      await db.pool.query(`CREATE TABLE ${sch}.${t} (fake_marker text)`);
      await db.pool.query(`INSERT INTO ${sch}.${t} VALUES ('FALSA')`);
      await db.pool.query(`GRANT SELECT ON ${sch}.${t} TO ${l.role}`);
    }
    await db.pool.query(`GRANT USAGE ON SCHEMA ${sch} TO ${l.role}`);

    // Controle: um Pool sem a opção resolve "$user" primeiro e enxerga a tabela FALSA.
    const plain = new pg.Pool({ connectionString: l.url, max: 1 });
    plain.on('error', () => undefined);
    try {
      expect((await plain.query('SHOW search_path')).rows[0]).toEqual({ search_path: '"$user", public' });
      expect((await plain.query('SELECT fake_marker FROM risk_operational_state')).rows).toEqual([{ fake_marker: 'FALSA' }]);
    } finally {
      await plain.end();
    }

    const pool = createPool({ connectionString: l.url, connectionTimeoutMs: 5000, max: 2 });
    try {
      expect((await pool.query('SHOW search_path')).rows[0]).toEqual({ search_path: 'public' });
      // A mesma consulta sem qualificação agora resolve a tabela REAL (coluna restore_pending), nunca a falsa.
      expect((await pool.query('SELECT restore_pending FROM risk_operational_state')).rows).toEqual([{ restore_pending: false }]);
      await expect(pool.query('SELECT fake_marker FROM risk_operational_state')).rejects.toMatchObject({ code: '42703' });
      await expect(pool.query('SELECT fake_marker FROM risk_reservations')).rejects.toMatchObject({ code: '42703' });
      // A opção vale para TODA conexão do pool (não só a primeira).
      const [a, b] = await Promise.all([pool.connect(), pool.connect()]);
      try {
        for (const c of [a, b]) expect((await c.query('SHOW search_path')).rows[0]).toEqual({ search_path: 'public' });
      } finally {
        a.release();
        b.release();
      }
      // O inspetor reprova o login (schema próprio) mesmo com o pool protegido: defesa em profundidade.
      const r = await inspect(pool);
      expect(r.ok).toBe(false);
      expect(r.violations).toContain('OWNS_OR_CREATES_IN_SCHEMA');
    } finally {
      await pool.end();
    }
  });

  it('createPool: erro de pool ocioso não derruba o processo e o limite max é respeitado', async () => {
    const pool = createPool({ connectionString: rt.url, connectionTimeoutMs: 5000, max: 2 });
    try {
      await Promise.all([1, 2, 3, 4].map(() => pool.query('SELECT pg_sleep(0.05)')));
      expect(pool.totalCount).toBeLessThanOrEqual(2);
      expect(pool.listenerCount('error')).toBeGreaterThanOrEqual(1);
    } finally {
      await pool.end();
    }
  });
});

describe('falha da inspeção é fail-closed', () => {
  it('banco inalcançável → INSPECTION_FAILED, sem lançar', async () => {
    const url = new URL(rt.url);
    url.port = '1';
    const dead = new pg.Pool({ connectionString: url.toString(), connectionTimeoutMillis: 2000 });
    dead.on('error', () => undefined);
    try {
      expect(await inspect(dead)).toEqual({ ok: false, violations: ['INSPECTION_FAILED'] });
    } finally {
      await dead.end();
    }
  });

  it('pool já encerrado → INSPECTION_FAILED', async () => {
    const l = await createTestLogin(db);
    await l.pool.end();
    try {
      expect(await inspect(l.pool)).toEqual({ ok: false, violations: ['INSPECTION_FAILED'] });
    } finally {
      await l.drop();
    }
  });

  it('consulta que falha no meio da inspeção → INSPECTION_FAILED, descartando a conexão', async () => {
    const release = vi.fn();
    let n = 0;
    const query = vi.fn((sql: string) => {
      n += 1;
      if (/ROLLBACK/.test(sql)) return Promise.resolve({ rows: [] });
      if (n === 3) return Promise.reject(Object.assign(new Error('relation "risk_secret_table" does not exist'), { code: '42P01' }));
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    const fake = { connect: () => Promise.resolve({ query, release, on: vi.fn(), removeListener: vi.fn() }) } as unknown as pg.Pool;
    const r = await inspect(fake);
    expect(r).toEqual({ ok: false, violations: ['INSPECTION_FAILED'] });
    expect(release).toHaveBeenCalledWith(true);
    expect(JSON.stringify(r)).not.toContain('risk_secret_table');
  });

  it('cliente emite "error" durante a inspeção → listener registrado, release(true), nunca aprova e sem exceção não tratada', async () => {
    const handlers: ((e: Error) => void)[] = [];
    const release = vi.fn();
    const removeListener = vi.fn();
    const on = vi.fn((event: string, h: (e: Error) => void) => {
      if (event === 'error') handlers.push(h);
    });
    let n = 0;
    const query = vi.fn(() => {
      n += 1;
      if (n === 2) for (const h of handlers) h(Object.assign(new Error('terminating connection secret-detail'), { code: '57P01' }));
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    const fake = { connect: () => Promise.resolve({ query, release, on, removeListener }) } as unknown as pg.Pool;
    const r = await inspect(fake);
    expect(handlers.length).toBeGreaterThanOrEqual(1);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('secret-detail');
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(true);
  });

  it('role sem linha em pg_roles (resultado vazio) nunca aprova', async () => {
    const query = vi.fn(() => Promise.resolve({ rows: [], rowCount: 0 }));
    const fake = { connect: () => Promise.resolve({ query, release: vi.fn(), on: vi.fn(), removeListener: vi.fn() }) } as unknown as pg.Pool;
    const r = await inspect(fake);
    expect(r.ok).toBe(false);
    expect(r.violations).toEqual(['INSPECTION_FAILED']);
  });

  it('timeout de statement muito curto não aprova: ou lê tudo ou falha fechado', async () => {
    const slow = new PgPrivilegeInspector(rt.pool, { statementTimeoutMs: 1 });
    const r = await slow.inspect();
    if (r.ok) expect(r.violations).toEqual([]);
    else expect(r.violations).toEqual(['INSPECTION_FAILED']);
  });

  it('as violações são só códigos fixos (sem nomes de roles, tabelas ou mensagens do banco)', async () => {
    const l = await login({ attributes: 'NOSUPERUSER CREATEROLE', inRoles: [RUNTIME_GROUP, OWNER_GROUP] });
    await db.pool.query(`GRANT TRUNCATE ON risk_decisions TO ${l.role}`);
    const r = await inspect(l.pool);
    expect(r.ok).toBe(false);
    for (const v of r.violations) expect(v).toMatch(/^[A-Z_]+$/);
    const text = JSON.stringify(r);
    expect(text).not.toContain(l.role);
    expect(text).not.toContain('risk_decisions');
  });
});

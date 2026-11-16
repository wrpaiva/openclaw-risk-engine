import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ReadinessReport } from '../../src/application/ports/ReadinessProbe.js';
import { readBundledMigrations, type AppliedMigration } from '../../src/infrastructure/postgres/migrate.js';
import { PgPrivilegeInspector, type PrivilegeInspector } from '../../src/infrastructure/postgres/PgPrivilegeInspector.js';
import { PgReadinessProbe } from '../../src/infrastructure/postgres/PgReadinessProbe.js';
import { createIsolatedDatabase, createRuntimeLogin, MIGRATIONS_DIR, type IsolatedDatabase, type RuntimeLogin } from './support/database.js';

// Prontidão (etapa 2.5). Banco descartável *_test; tudo FICTÍCIO.
let db: IsolatedDatabase;
let rt: RuntimeLogin;
let bundled: readonly AppliedMigration[];
const OK: ReadinessReport = { database: 'OK', schema: 'OK', privileges: 'OK', reconciliation: 'OK' };
const ALL_FAIL: ReadinessReport = { database: 'FAIL', schema: 'FAIL', privileges: 'FAIL', reconciliation: 'FAIL' };

beforeAll(async () => {
  db = await createIsolatedDatabase();
  rt = await createRuntimeLogin(db);
  bundled = await readBundledMigrations(MIGRATIONS_DIR);
});
afterAll(async () => {
  await rt.drop();
  await db.drop();
});
afterEach(async () => {
  await db.pool.query(`DELETE FROM schema_migrations WHERE version LIKE '9%'`);
  await db.pool.query(`UPDATE risk_operational_state SET restore_pending = FALSE, restore_marked_at = NULL WHERE singleton`);
});

const probe = (pool: pg.Pool, overrides: Partial<{ bundledMigrations: () => Promise<readonly AppliedMigration[]>; privileges: PrivilegeInspector }> = {}) =>
  new PgReadinessProbe({
    pool,
    bundledMigrations: overrides.bundledMigrations ?? (() => Promise.resolve(bundled)),
    privileges: overrides.privileges ?? new PgPrivilegeInspector(pool, { statementTimeoutMs: 10_000 }),
    statementTimeoutMs: 10_000,
  });

describe('caminho feliz', () => {
  it('login de runtime, schema igual ao empacotado → tudo OK', async () => {
    expect(await probe(rt.pool).check()).toEqual(OK);
  });

  it('as migrações empacotadas são as 4 esperadas, em ordem', () => {
    expect(bundled.map((m) => m.version)).toEqual(['0001_initial.sql', '0002_access_grants.sql', '0003_runtime_privileges.sql', '0004_restore_reconciliation.sql']);
  });

  it('leitura real de migrations/: lê pelo runtime sem precisar do diretório do repositório', async () => {
    const p = new PgReadinessProbe({
      pool: rt.pool,
      bundledMigrations: () => readBundledMigrations(MIGRATIONS_DIR),
      privileges: new PgPrivilegeInspector(rt.pool, { statementTimeoutMs: 10_000 }),
      statementTimeoutMs: 10_000,
    });
    expect(await p.check()).toEqual(OK);
  });
});

describe('schema', () => {
  it('checksum divergente em uma migração → schema FAIL; banco e privilégios seguem OK', async () => {
    const tampered = bundled.map((m, i) => (i === 1 ? { ...m, checksum: 'f'.repeat(64) } : m));
    expect(await probe(rt.pool, { bundledMigrations: () => Promise.resolve(tampered) }).check()).toEqual({ ...OK, schema: 'FAIL' });
  });

  it('checksum diferindo em 1 caractere (limite) → FAIL', async () => {
    const first = bundled[0];
    if (!first) throw new Error('sem migrações');
    const flipped = first.checksum.slice(0, -1) + (first.checksum.endsWith('0') ? '1' : '0');
    const tampered = [{ ...first, checksum: flipped }, ...bundled.slice(1)];
    expect((await probe(rt.pool, { bundledMigrations: () => Promise.resolve(tampered) }).check()).schema).toBe('FAIL');
  });

  it('migração empacotada ainda não aplicada no banco → schema FAIL', async () => {
    const withNew = [...bundled, { version: '0005_nova.sql', checksum: 'a'.repeat(64) }];
    expect(await probe(rt.pool, { bundledMigrations: () => Promise.resolve(withNew) }).check()).toEqual({ ...OK, schema: 'FAIL' });
  });

  it('imagem N-1: banco com migração extra que a imagem desconhece → aceito (rollback de imagem)', async () => {
    await db.pool.query(`INSERT INTO schema_migrations (version, checksum) VALUES ('9999_futura.sql', $1)`, ['c'.repeat(64)]);
    expect(await probe(rt.pool).check()).toEqual(OK);
  });

  it('imagem N-1: empacotadas = só as 3 primeiras, banco tem as 4 → OK', async () => {
    expect(await probe(rt.pool, { bundledMigrations: () => Promise.resolve(bundled.slice(0, 3)) }).check()).toEqual(OK);
  });

  it('imagem N-2: empacotadas = só as 2 primeiras, banco tem as 4 → OK', async () => {
    expect(await probe(rt.pool, { bundledMigrations: () => Promise.resolve(bundled.slice(0, 2)) }).check()).toEqual(OK);
  });

  it('nenhuma migração empacotada (diretório vazio) → FAIL, nunca "tudo ok por vacuidade"', async () => {
    expect((await probe(rt.pool, { bundledMigrations: () => Promise.resolve([]) }).check()).schema).toBe('FAIL');
  });

  it('bundledMigrations que lança (síncrono ou assíncrono) → schema FAIL, sem lançar nem vazar a mensagem', async () => {
    for (const bundledMigrations of [
      () => Promise.reject(new Error('ENOENT: /opt/segredo/migrations')),
      () => {
        throw new Error('ENOENT: /opt/segredo/migrations');
      },
    ]) {
      const report = await probe(rt.pool, { bundledMigrations }).check();
      expect(report).toEqual({ ...OK, schema: 'FAIL' });
      expect(JSON.stringify(report)).not.toContain('segredo');
    }
  });

  it('diretório inexistente de verdade → schema FAIL', async () => {
    const p = probe(rt.pool, { bundledMigrations: () => readBundledMigrations('/nao/existe/migrations-test') });
    expect(await p.check()).toEqual({ ...OK, schema: 'FAIL' });
  });

  it('tabela schema_migrations ausente (banco sem migrar) → schema FAIL; database segue OK', async () => {
    const empty = await createIsolatedDatabase(3, { migrate: false });
    const login = await createRuntimeLogin(empty);
    try {
      expect(await probe(login.pool).check()).toEqual({ database: 'OK', schema: 'FAIL', privileges: 'OK', reconciliation: 'FAIL' });
    } finally {
      await login.drop();
      await empty.drop();
    }
  });
});

describe('privilégios', () => {
  it('superuser: database e schema OK, privileges FAIL', async () => {
    expect(await probe(db.pool).check()).toEqual({ ...OK, privileges: 'FAIL' });
  });

  it('inspetor que rejeita ou devolve ok=false → privileges FAIL', async () => {
    const rejecting: PrivilegeInspector = { inspect: () => Promise.reject(new Error('boom')) };
    const denying: PrivilegeInspector = { inspect: () => Promise.resolve({ ok: false, violations: ['SUPERUSER'] }) };
    expect(await probe(rt.pool, { privileges: rejecting }).check()).toEqual({ ...OK, privileges: 'FAIL' });
    expect(await probe(rt.pool, { privileges: denying }).check()).toEqual({ ...OK, privileges: 'FAIL' });
  });
});

describe('reconciliação pós-restauração', () => {
  it('restore_pending=true → só reconciliation FAIL; database, schema e privileges seguem OK', async () => {
    await db.pool.query(`UPDATE risk_operational_state SET restore_pending = TRUE, restore_marked_at = now() WHERE singleton`);
    expect(await probe(rt.pool).check()).toEqual({ ...OK, reconciliation: 'FAIL' });
  });

  it('volta a OK ao limpar a pendência, sem reiniciar a sonda', async () => {
    const p = probe(rt.pool);
    await db.pool.query(`UPDATE risk_operational_state SET restore_pending = TRUE, restore_marked_at = now() WHERE singleton`);
    expect((await p.check()).reconciliation).toBe('FAIL');
    await db.pool.query(`UPDATE risk_operational_state SET restore_pending = FALSE WHERE singleton`);
    expect(await p.check()).toEqual(OK);
  });

  it('linha de estado ausente (gatilho de DELETE desligado só no teste) → reconciliation FAIL (fail-closed)', async () => {
    const own = await createIsolatedDatabase();
    const login = await createRuntimeLogin(own);
    try {
      await own.pool.query('ALTER TABLE risk_operational_state DISABLE TRIGGER risk_operational_state_no_delete');
      await own.pool.query('DELETE FROM risk_operational_state');
      expect(await probe(login.pool).check()).toEqual({ ...OK, reconciliation: 'FAIL' });
    } finally {
      await login.drop();
      await own.drop();
    }
  });

  it('tabela de estado inexistente (migração 0004 não aplicada) → reconciliation FAIL', async () => {
    const own = await createIsolatedDatabase();
    const login = await createRuntimeLogin(own);
    try {
      await own.pool.query('DROP TABLE risk_operational_state');
      expect(await probe(login.pool).check()).toEqual({ ...OK, reconciliation: 'FAIL' });
    } finally {
      await login.drop();
      await own.drop();
    }
  });
});

describe('banco indisponível', () => {
  it('banco fora → FAIL em tudo, sem lançar e sem vazar host/porta/senha', async () => {
    const url = new URL(rt.url);
    url.port = '1';
    const dead = new pg.Pool({ connectionString: url.toString(), connectionTimeoutMillis: 2000 });
    dead.on('error', () => undefined);
    try {
      const report = await probe(dead).check();
      expect(report).toEqual(ALL_FAIL);
      const text = JSON.stringify(report);
      expect(text).not.toContain(url.password);
      expect(text).not.toMatch(/127\.0\.0\.1|ECONNREFUSED/);
    } finally {
      await dead.end();
    }
  });

  it('pool encerrado → FAIL em tudo', async () => {
    const closed = new pg.Pool({ connectionString: rt.url });
    closed.on('error', () => undefined);
    await closed.end();
    expect(await probe(closed).check()).toEqual(ALL_FAIL);
  });

  it('conexões ociosas derrubadas pelo servidor: o pool descarta as mortas e a checagem seguinte se recupera', async () => {
    const own = new pg.Pool({ connectionString: rt.url, max: 3 });
    own.on('error', () => undefined);
    try {
      expect(await probe(own).check()).toEqual(OK);
      await db.pool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1 AND pid <> pg_backend_pid() AND application_name = ''`, [rt.role]);
      // Dá tempo ao pool para ver o evento de erro das conexões ociosas e descartá-las.
      await new Promise((r) => setTimeout(r, 500));
      expect(await probe(own).check()).toEqual(OK);
    } finally {
      await own.end();
    }
  });

  it('driver que lança de forma síncrona em connect → FAIL, sem lançar', async () => {
    const fake = {
      connect: vi.fn(() => {
        throw new Error('senha=hunter2');
      }),
    } as unknown as pg.Pool;
    const report = await probe(fake, { privileges: { inspect: () => Promise.resolve({ ok: true, violations: [] }) } }).check();
    expect(report.database).toBe('FAIL');
    expect(report.schema).toBe('FAIL');
    expect(JSON.stringify(report)).not.toContain('hunter2');
  });
});

describe('contrato', () => {
  it('só devolve as 4 chaves database/schema/privileges/reconciliation com OK|FAIL', async () => {
    const report = await probe(rt.pool).check();
    expect(Object.keys(report).sort()).toEqual(['database', 'privileges', 'reconciliation', 'schema']);
  });

  it('somente leitura: sem transação aberta nem escritas, e conexões voltam ao pool (inclusive com pool de 1)', async () => {
    const single = new pg.Pool({ connectionString: rt.url, max: 1 });
    single.on('error', () => undefined);
    try {
      for (let i = 0; i < 3; i++) expect(await probe(single).check()).toEqual(OK);
      expect(single.idleCount).toBe(single.totalCount);
      expect(single.waitingCount).toBe(0);
    } finally {
      await single.end();
    }
    const { rows } = await db.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM pg_stat_activity WHERE usename = $1 AND state LIKE 'idle in transaction%'`, [rt.role]);
    expect(rows[0]?.n).toBe('0');
  });

  it('chamadas concorrentes (20) não vazam conexões', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => probe(rt.pool).check()));
    for (const r of results) expect(r).toEqual(OK);
    expect(rt.pool.idleCount).toBe(rt.pool.totalCount);
  });
});

describe('single-flight (sem cache)', () => {
  /** Inspetor FICTÍCIO que conta chamadas e só responde quando liberado. */
  function gatedInspector() {
    let calls = 0;
    let open!: () => void;
    let gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const inspector: PrivilegeInspector = {
      inspect: async () => {
        calls += 1;
        await gate;
        return { ok: true, violations: [] };
      },
    };
    return {
      inspector,
      calls: () => calls,
      release: () => {
        open();
        gate = new Promise<void>((resolve) => {
          open = resolve;
        });
      },
    };
  }

  it('N chamadas concorrentes → um único conjunto de verificações (um inspect), mesma promessa e mesmo relatório', async () => {
    const g = gatedInspector();
    const p = probe(rt.pool, { privileges: g.inspector });
    const calls = Array.from({ length: 30 }, () => p.check());
    expect(calls.every((c) => c === calls[0])).toBe(true);
    await vi.waitFor(() => {
      expect(g.calls()).toBe(1);
    });
    g.release();
    const results = await Promise.all(calls);
    expect(results.every((r) => r === results[0])).toBe(true);
    expect(results[0]).toEqual(OK);
    expect(g.calls()).toBe(1);
  });

  it('chamada após a conclusão refaz a verificação e enxerga o estado novo (sem cache)', async () => {
    const g = gatedInspector();
    const p = probe(rt.pool, { privileges: g.inspector });
    const first = p.check();
    await vi.waitFor(() => {
      expect(g.calls()).toBe(1);
    });
    g.release();
    expect(await first).toEqual(OK);

    await db.pool.query(`UPDATE risk_operational_state SET restore_pending = TRUE, restore_marked_at = now() WHERE singleton`);
    const second = p.check();
    await vi.waitFor(() => {
      expect(g.calls()).toBe(2);
    });
    g.release();
    expect(await second).toEqual({ ...OK, reconciliation: 'FAIL' });
  });

  it('falha no voo (inspetor que lança) não fica presa: a próxima chamada tenta de novo', async () => {
    let attempts = 0;
    const flaky: PrivilegeInspector = {
      inspect: () => {
        attempts += 1;
        return attempts === 1 ? Promise.reject(new Error('boom')) : Promise.resolve({ ok: true, violations: [] });
      },
    };
    const p = probe(rt.pool, { privileges: flaky });
    expect(await p.check()).toEqual({ ...OK, privileges: 'FAIL' });
    expect(await p.check()).toEqual(OK);
    expect(attempts).toBe(2);
  });

  it('rajada concorrente não amplia o uso do pool: conexões do login ficam dentro do máximo e voltam ociosas', async () => {
    const p = probe(rt.pool);
    for (let round = 0; round < 3; round++) {
      const results = await Promise.all(Array.from({ length: 40 }, () => p.check()));
      expect(results.every((r) => r.database === 'OK')).toBe(true);
    }
    expect(rt.pool.waitingCount).toBe(0);
    expect(rt.pool.totalCount).toBeLessThanOrEqual(3);
  });
});

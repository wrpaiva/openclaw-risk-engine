import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NAME_RE, adminPool, bkEnv, docker, labelArgs, makeConfig, outFiles, rand, runBackupProd, sleep, tmpDir, urlFor } from './support.js';

// T7: restauração do backup CIFRADO em banco *_test novo: restore-encrypted-local.sh -> restore_pending=true -> reconcile-after-restore
// -> verify-runtime-privileges -> aplicação pela imagem openclaw-risk-engine com /health/ready 200. E as recusas (sem escrita no banco).
const env = bkEnv();
const VERSION = (JSON.parse(readFileSync(join(env.root, 'package.json'), 'utf8')) as { version: string }).version;
const APP_IMAGE = `openclaw-risk-engine:${VERSION}`;
const DEADLINES = { RISK_DB_CONNECTION_TIMEOUT_MS: '3000', RISK_DB_STATEMENT_TIMEOUT_MS: '10000', RISK_DB_LOCK_TIMEOUT_MS: '5000' };

let admin: pg.Pool;
const dbs: string[] = [];
const roles: string[] = [];
const containers: string[] = [];

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => {
        resolve(port);
      });
    });
  });

async function newDb(label: string): Promise<string> {
  const name = `risk_restore_${label}_${rand(3)}_test`;
  dbs.push(name);
  await admin.query(`CREATE DATABASE ${name}`);
  return name;
}
async function newLogin(prefix: string, group: string): Promise<{ name: string; password: string }> {
  const name = `zz9_${prefix}_${rand(3)}`;
  const password = `pw-${rand(8)}`;
  roles.push(name);
  await admin.query(`CREATE ROLE ${name} LOGIN PASSWORD '${password}' IN ROLE ${group}`);
  return { name, password };
}
const dbUrl = (db: string, login?: { name: string; password: string }): string => {
  if (!login) return urlFor(db);
  return `postgres://${login.name}:${login.password}@127.0.0.1:${env.dbPort}/${db}`;
};
async function inDb<T>(db: string, fn: (c: pg.Pool) => Promise<T>): Promise<T> {
  const p = new pg.Pool({ connectionString: urlFor(db), max: 2 });
  try {
    return await fn(p);
  } finally {
    await p.end();
  }
}
const one = async <T>(p: pg.Pool, sql: string, args: unknown[] = []): Promise<T> => {
  const row = (await p.query(sql, args)).rows[0] as Record<string, unknown>;
  return Object.values(row)[0] as T;
};

function restoreEncrypted(file: string, db: string, identity = env.identityFile): { code: number | null; out: string } {
  const r = spawnSync('bash', [join(env.root, 'scripts/restore-encrypted-local.sh'), file], {
    encoding: 'utf8',
    timeout: 240_000,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/', RISK_RESTORE_URL: urlFor(db), RISK_RESTORE_AGE_IDENTITY_FILE: identity },
  });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

function imageCli(args: readonly string[], envValues: Record<string, string>): { code: number | null; stdout: string; stderr: string } {
  const flags = Object.keys(envValues).flatMap((k) => ['-e', k]);
  const r = spawnSync(
    'docker',
    ['run', '--rm', '--pull', 'never', ...labelArgs(), '--network', 'host', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', ...flags, '--entrypoint', 'node', APP_IMAGE, 'dist/interfaces/cli/main.js', ...args],
    { encoding: 'utf8', timeout: 90_000, env: { ...process.env, ...envValues } },
  );
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Banco intocado: nenhuma tabela em public e datacl nulo (roles.sql altera o ACL do banco; só roda depois das travas). */
async function expectUntouched(db: string): Promise<void> {
  const n = await inDb(db, (p) => one<string>(p, `select count(*)::text from pg_tables where schemaname = 'public'`));
  expect(n).toBe('0');
  const acl = await admin.query('select datacl from pg_database where datname = $1', [db]);
  expect((acl.rows[0] as { datacl: unknown }).datacl).toBeNull();
}

/** Procura arquivos com a assinatura PGDMP (dump em claro) sob o diretório do ciclo. */
function plaintextDumps(dir: string): string[] {
  const hits: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && statSync(p).size >= 5 && readFileSync(p).subarray(0, 5).toString('latin1') === 'PGDMP') hits.push(p);
    }
  };
  walk(dir);
  return hits;
}

let backupDir: string;
let ageFile: string;
let sourceAudit: number;
let sourceMigrations: string;

beforeAll(async () => {
  admin = adminPool();
  expect(docker(['image', 'inspect', APP_IMAGE]).code, `imagem ${APP_IMAGE} ausente: npm run image:build`).toBe(0);
  await admin.query(
    `INSERT INTO risk_audit_events (event_id, correlation_id, account_id, event_type, details_json, created_at)
     SELECT gen_random_uuid(), 'restore-sentinel-zz9', NULL, 'ZZ9_RESTORE_SENTINEL', '{"fixture":true}'::jsonb, now()
      WHERE NOT EXISTS (SELECT 1 FROM risk_audit_events WHERE event_type = 'ZZ9_RESTORE_SENTINEL')`,
  );
  const cfg = makeConfig();
  const r = runBackupProd(cfg.file);
  expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0);
  const name = outFiles(cfg.dir).find((f) => NAME_RE(env.db).test(f)) as string;
  backupDir = cfg.dir;
  ageFile = join(backupDir, name);
  sourceAudit = Number(((await admin.query('select count(*) n from risk_audit_events')).rows[0] as { n: string }).n);
  sourceMigrations = JSON.stringify((await admin.query('select version, checksum from schema_migrations order by version')).rows);
}, 300_000);

afterAll(async () => {
  for (const c of containers) docker(['rm', '-f', '-v', c]);
  for (const d of dbs) await admin.query(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`).catch(() => undefined);
  for (const r of roles) {
    await admin.query(`DROP OWNED BY ${r}`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${r}`).catch(() => undefined);
  }
  await admin.end();
}, 120_000);

describe('restauração cifrada em banco *_test novo, reconciliação, privilégios e app ready', { timeout: 420_000 }, () => {
  let db: string;
  let migrator: { name: string; password: string };
  let runtime: { name: string; password: string };

  it('restore-encrypted-local.sh restaura; dados, esquema, dono e grants de backup preservados; restore_pending=true; nenhum PGDMP em claro no disco', async () => {
    db = await newDb('ok');
    const r = restoreEncrypted(ageFile, db);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`restore concluído em ${db}`);
    expect(r.out).not.toContain(env.adminUrl);
    expect(plaintextDumps(env.workdir)).toEqual([]);

    await inDb(db, async (p) => {
      expect(await one<string>(p, `select count(*)::text from risk_audit_events where event_type = 'ZZ9_RESTORE_SENTINEL'`)).toBe('1');
      expect(Number(await one<string>(p, 'select count(*)::text from risk_audit_events'))).toBe(sourceAudit + 1); // + RESTORE_PENDING_MARKED
      expect(await one<string>(p, `select count(*)::text from risk_audit_events where event_type = 'RESTORE_PENDING_MARKED'`)).toBe('1');
      expect(await one<boolean>(p, 'select restore_pending from risk_operational_state where singleton')).toBe(true);
      expect(JSON.stringify((await p.query('select version, checksum from schema_migrations order by version')).rows)).toBe(sourceMigrations);
      expect(await one<string>(p, `select count(*)::text from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','S','v','m','p') and pg_get_userbyid(c.relowner) <> 'openclaw_risk_owner'`)).toBe('0');
      expect(await one<boolean>(p, `select has_table_privilege('openclaw_risk_backup', 'risk_decisions', 'SELECT')`)).toBe(true);
      expect(await one<boolean>(p, `select has_table_privilege('openclaw_risk_backup', 'risk_decisions', 'INSERT')`)).toBe(false);
    });
    expect((await admin.query('select has_database_privilege($1, $2, $3) ok', ['openclaw_risk_runtime', db, 'CONNECT']).then((q) => q.rows[0] as { ok: boolean })).ok).toBe(true);
  });

  it('verify-runtime-privileges (credencial de runtime) → 0, mesmo com a pendência ligada', async () => {
    runtime = await newLogin('rt', 'openclaw_risk_runtime');
    const r = imageCli(['verify-runtime-privileges'], {
      RISK_ENVIRONMENT: 'PAPER', RISK_DATABASE_URL: dbUrl(db, runtime), RISK_LOG_LEVEL: 'error', RISK_HTTP_ENABLED: 'false', RISK_CLOCK_SKEW_TOLERANCE_MS: '1000', ...DEADLINES,
    });
    expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  it('app pela imagem sobe contra o banco restaurado e responde /health/ready 503 enquanto restore_pending; reconcile-after-restore libera → 200', async () => {
    migrator = await newLogin('mig', 'openclaw_risk_owner');
    const secrets = tmpDir('app-secrets');
    const token = randomBytes(24).toString('base64url');
    writeFileSync(join(secrets, 'runtime_database_url'), `${dbUrl(db, runtime)}\n`);
    writeFileSync(join(secrets, 'principals.json'), JSON.stringify({ version: 1, principals: [{ principalId: 'agent-restore-zz9', kind: 'AGENT', tokenSha256: [createHash('sha256').update(token, 'utf8').digest('hex')] }] }));
    for (const f of ['runtime_database_url', 'principals.json']) chmodSync(join(secrets, f), 0o400);
    const port = await freePort();
    const name = `openclaw-risk-backup-test-app-${rand(3)}`;
    containers.push(name);
    const run = docker([
      'run', '-d', '--pull', 'never', '--name', name, ...labelArgs(), '--user', `${process.getuid?.()}:${process.getgid?.()}`, '--network', 'host', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '-v', `${secrets}:/run/secrets:ro`,
      '-e', 'RISK_ENVIRONMENT=PAPER', '-e', 'RISK_DATABASE_URL_FILE=/run/secrets/runtime_database_url', '-e', 'RISK_LOG_LEVEL=info', '-e', 'RISK_CLOCK_SKEW_TOLERANCE_MS=1000',
      ...Object.entries(DEADLINES).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
      '-e', 'RISK_HTTP_ENABLED=true', '-e', 'RISK_HTTP_HOST=127.0.0.1', '-e', `RISK_HTTP_PORT=${port}`, '-e', 'RISK_HTTP_MAX_BODY_BYTES=65536', '-e', 'RISK_HTTP_REQUEST_TIMEOUT_MS=10000', '-e', 'RISK_HTTP_HEADERS_TIMEOUT_MS=5000',
      '-e', 'RISK_PRINCIPALS_FILE=/run/secrets/principals.json', APP_IMAGE,
    ]);
    expect(run.code, run.stderr).toBe(0);
    const ready = async (): Promise<number> => {
      try {
        return (await fetch(`http://127.0.0.1:${port}/health/ready`, { signal: AbortSignal.timeout(3000) })).status;
      } catch {
        return 0;
      }
    };
    let status = 0;
    for (let i = 0; i < 60 && status === 0; i += 1) {
      status = await ready();
      if (status === 0) await sleep(500);
    }
    expect(status, docker(['logs', '--tail', '20', name]).stdout).toBe(503); // restore_pending: serviço indisponível
    expect(docker(['inspect', '-f', '{{.State.Running}}', name]).stdout.trim()).toBe('true');

    const rec = imageCli(['reconcile-after-restore'], { RISK_ENVIRONMENT: 'PAPER', RISK_MIGRATION_DATABASE_URL: dbUrl(db, migrator), ...DEADLINES });
    expect(rec.code, `${rec.stdout}\n${rec.stderr}`).toBe(0);
    await inDb(db, async (p) => {
      expect(await one<boolean>(p, 'select restore_pending from risk_operational_state where singleton')).toBe(false);
      expect(await one<string>(p, `select count(*)::text from risk_audit_events where event_type = 'RESTORE_RECONCILED'`)).toBe('1');
      expect(await one<string>(p, `select count(*)::text from risk_reservations where status = 'ACTIVE'`)).toBe('0');
    });
    for (let i = 0; i < 60 && status !== 200; i += 1) {
      await sleep(500);
      status = await ready();
    }
    expect(status, docker(['logs', '--tail', '20', name]).stdout).toBe(200);
    // O token nunca aparece nos logs da app.
    expect(docker(['logs', name]).stdout + docker(['logs', name]).stderr).not.toContain(token);
    docker(['rm', '-f', '-v', name]);
  });

  it('verify-runtime-privileges continua 0 depois da reconciliação', () => {
    const r = imageCli(['verify-runtime-privileges'], {
      RISK_ENVIRONMENT: 'PAPER', RISK_DATABASE_URL: dbUrl(db, runtime), RISK_LOG_LEVEL: 'error', RISK_HTTP_ENABLED: 'false', RISK_CLOCK_SKEW_TOLERANCE_MS: '1000', ...DEADLINES,
    });
    expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  it('reaplicar o restore sobre o banco já restaurado (não vazio) é recusado e não altera nada', async () => {
    const before = await inDb(db, async (p) => JSON.stringify((await p.query(`select event_type, count(*) from risk_audit_events group by 1 order by 1`)).rows));
    const r = restoreEncrypted(ageFile, db);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/não está vazio/);
    const after = await inDb(db, async (p) => JSON.stringify((await p.query(`select event_type, count(*) from risk_audit_events group by 1 order by 1`)).rows));
    expect(after).toBe(before);
  });
});

describe('restauração recusada: nenhuma escrita no banco de destino', { timeout: 420_000 }, () => {
  const copyPair = (dir: string, name: string): { age: string; sha: string } => {
    const age = join(dir, name);
    copyFileSync(ageFile, age);
    writeFileSync(`${age}.sha256`, `${createHash('sha256').update(readFileSync(age)).digest('hex')}  ${name}\n`, { mode: 0o600 });
    return { age, sha: `${age}.sha256` };
  };
  const NAME = `${env.db}-20261116T010203Z.dump.age`;

  it('.sha256 divergente (hash de outro conteúdo) → recusa antes de decifrar; banco intocado', async () => {
    const db = await newDb('sha');
    const dir = tmpDir('rst');
    const { age, sha } = copyPair(dir, NAME);
    writeFileSync(sha, `${'ab'.repeat(32)}  ${NAME}\n`);
    const r = restoreEncrypted(age, db);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/checksum diverge/);
    await expectUntouched(db);
  });

  it('arquivo adulterado (um byte trocado) com .sha256 recalculado → age recusa (autenticação); banco intocado', async () => {
    const db = await newDb('flip');
    const dir = tmpDir('rst');
    const { age } = copyPair(dir, NAME);
    const buf = readFileSync(age);
    buf[buf.length - 1] = (buf[buf.length - 1] as number) ^ 0xff;
    writeFileSync(age, buf);
    writeFileSync(`${age}.sha256`, `${createHash('sha256').update(buf).digest('hex')}  ${NAME}\n`);
    const r = restoreEncrypted(age, db);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/não foi possível decifrar/);
    await expectUntouched(db);
  });

  it('arquivo truncado (sha recalculado) → recusa; banco intocado', async () => {
    const db = await newDb('trunc');
    const dir = tmpDir('rst');
    const { age } = copyPair(dir, NAME);
    const buf = readFileSync(age).subarray(0, Math.floor(readFileSync(age).length / 2));
    writeFileSync(age, buf);
    writeFileSync(`${age}.sha256`, `${createHash('sha256').update(buf).digest('hex')}  ${NAME}\n`);
    const r = restoreEncrypted(age, db);
    expect(r.code).toBe(1);
    await expectUntouched(db);
  });

  it('identidade errada (outro par de chaves) → recusa na pré-checagem; banco intocado', async () => {
    const db = await newDb('wrongid');
    const r = restoreEncrypted(ageFile, db, env.identityWrongFile);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/não foi possível decifrar/);
    await expectUntouched(db);
  });

  it('backup cifrado para OUTRO recipient não é restaurável com a identidade esperada; banco intocado', async () => {
    const cfg = makeConfig({}, { age_recipients: `${env.recipientWrong}\n` });
    const run = runBackupProd(cfg.file);
    expect(run.code, run.stdout).toBe(0);
    const name = outFiles(cfg.dir).find((f) => f.endsWith('.dump.age')) as string;
    const db = await newDb('wrongrcp');
    const r = restoreEncrypted(join(cfg.dir, name), db, env.identityFile);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/não foi possível decifrar/);
    await expectUntouched(db);
    // Controle: com a identidade certa daquele recipient, a pré-checagem passa (o arquivo é um dump válido).
    const db2 = await newDb('wrongrcp_ok');
    const ok = restoreEncrypted(join(cfg.dir, name), db2, env.identityWrongFile);
    expect(ok.code, ok.out).toBe(0);
  });

  it('.sha256 ausente → recusa; banco intocado', async () => {
    const db = await newDb('nosha');
    const dir = tmpDir('rst');
    const { age, sha } = copyPair(dir, NAME);
    rmSync(sha);
    const r = restoreEncrypted(age, db);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/\.sha256 ausente/);
    await expectUntouched(db);
  });

  it('destino que não termina em _test, ou host remoto → recusa sem tocar nada', async () => {
    const dir = tmpDir('rst');
    const { age } = copyPair(dir, NAME);
    const notTest = `risk_restore_prod_${rand(3)}`;
    dbs.push(notTest);
    await admin.query(`CREATE DATABASE ${notTest}`);
    const r1 = spawnSync('bash', [join(env.root, 'scripts/restore-encrypted-local.sh'), age], {
      encoding: 'utf8', timeout: 60_000,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/', RISK_RESTORE_URL: urlFor(notTest), RISK_RESTORE_AGE_IDENTITY_FILE: env.identityFile },
    });
    expect(r1.status).toBe(1);
    expect(r1.stderr).toContain('_test');
    await expectUntouched(notTest);
    const remote = urlFor('x_test').replace('127.0.0.1', 'db.example.invalid');
    const r2 = spawnSync('bash', [join(env.root, 'scripts/restore-encrypted-local.sh'), age], {
      encoding: 'utf8', timeout: 60_000,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/', RISK_RESTORE_URL: remote, RISK_RESTORE_AGE_IDENTITY_FILE: env.identityFile },
    });
    expect(r2.status).toBe(1);
    expect(`${r2.stdout}${r2.stderr}`).not.toContain(env.adminUrl);
  });

  it('identidade com modo inseguro (0644) → recusa; o arquivo de identidade não é copiado para o disco', async () => {
    const db = await newDb('idmode');
    const dir = tmpDir('rst');
    const id = join(dir, 'identity.txt');
    copyFileSync(env.identityFile, id);
    chmodSync(id, 0o644);
    const r = restoreEncrypted(ageFile, db, id);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/0400\/0600/);
    await expectUntouched(db);
    expect(readdirSync(dir)).toEqual(['identity.txt']);
  });
});

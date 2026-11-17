import { chmodSync, copyFileSync, existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RCLONE_VARS, adminPool, bkEnv, docker, jobEvents, makeConfig, makeSecrets, makeStubs, mkMarks, outFiles, rand, runBackupProd, runJob, tmpDir, type RcloneVar, type Run } from './support.js';

// T4a: recusas do job (backup-job.sh, imagem real) ANTES de qualquer escrita: configuração/secrets inválidos, banco errado e
// login com escrita ou superuser. Em toda recusa: código 2, nada em /out, pg_dump nunca chamado (stub com marca). Fixtures fictícias.
const env = bkEnv();
let admin: pg.Pool;
const createdRoles: string[] = [];
let lastCreds = { name: '', pw: '' };

const PG_LINE = (login = env.backupLogin, pw = env.backupPassword, db = env.db, host = env.dbAlias, port = '5432'): string => `${host}:${port}:${db}:${login}:${pw}\n`;

beforeAll(() => {
  admin = adminPool();
});
afterAll(async () => {
  for (const r of createdRoles) {
    await admin.query(`DROP OWNED BY ${r}`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${r}`).catch(() => undefined);
  }
  await admin.query('DROP SCHEMA IF EXISTS zz9_sch CASCADE').catch(() => undefined);
  await admin.query('DROP SCHEMA IF EXISTS zz9_sch_own CASCADE').catch(() => undefined);
  await admin.end();
});

interface Refused {
  readonly run: Run;
  readonly out: string;
  readonly marks: string;
}
/** Roda o job com pg_dump stub que marca a chamada; o stub nunca é chamado numa recusa. */
function attempt(secrets: string, env2: Record<string, string> = {}, omit: readonly string[] = []): Refused {
  const out = tmpDir('out');
  const marks = mkMarks();
  const stubs = makeStubs({ pg_dump: 'touch /marks/pg_dump_called; exec /usr/lib/postgresql/14/bin/pg_dump "$@"' });
  const run = runJob({ out, secrets, stubs, marks, env: env2, omit });
  return { run, out, marks };
}
function expectRefused(r: Refused, event: string, ...secretsToHide: string[]): void {
  expect(r.run.code, `${r.run.stdout}\n${r.run.stderr}`).toBe(2);
  const events = jobEvents(r.run.stdout);
  expect(events.at(-1)?.event).toBe(event);
  expect(events.at(-1)?.exitCode).toBe(2);
  expect(events.some((e) => e.event === 'local_backup_ok' || e.event === 'backup_complete')).toBe(false);
  expect(outFiles(r.out)).toEqual([]);
  expect(existsSync(join(r.marks, 'pg_dump_called'))).toBe(false);
  for (const s of [env.backupPassword, env.s3Secret, ...secretsToHide]) {
    expect(r.run.stdout).not.toContain(s);
    expect(r.run.stderr).not.toContain(s);
  }
}

describe('job: secrets e configuração inválidos → 2, nada gravado', { timeout: 300_000 }, () => {
  it('controle: a configuração padrão do ciclo passa na trava (senão as recusas abaixo não provam nada)', () => {
    const out = tmpDir('out');
    const run = runJob({ out, secrets: env.secretsDir });
    expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(outFiles(out)).toHaveLength(2);
  });

  const pgpassCases: readonly (readonly [string, string])[] = [
    ['vazio', ''],
    ['duas linhas', PG_LINE() + PG_LINE()],
    ['curinga * no host', PG_LINE(env.backupLogin, env.backupPassword, env.db, '*')],
    ['curinga * no banco', PG_LINE(env.backupLogin, env.backupPassword, '*')],
    ['barra invertida na senha', PG_LINE(env.backupLogin, 'abc\\:def')],
    ['banco diferente do esperado', PG_LINE(env.backupLogin, env.backupPassword, 'outro_banco_zz9_test')],
    ['porta inválida', PG_LINE(env.backupLogin, env.backupPassword, env.db, env.dbAlias, '54a2')],
    ['porta vazia', PG_LINE(env.backupLogin, env.backupPassword, env.db, env.dbAlias, '')],
    ['host vazio', PG_LINE(env.backupLogin, env.backupPassword, env.db, '')],
    ['host com espaço', PG_LINE(env.backupLogin, env.backupPassword, env.db, 'a b')],
    ['login com caractere inválido', PG_LINE('login;drop', env.backupPassword)],
    ['login vazio', PG_LINE('', env.backupPassword)],
    ['só uma linha sem campos', 'qualquer-coisa\n'],
  ];
  it.each(pgpassCases)('pgpass inválido: %s', (_n, content) => {
    const secrets = makeSecrets({ pgpass: content });
    expectRefused(attempt(secrets), 'config_invalid_pgpass', 'abc\\:def');
  });

  it('pgpass ausente → config_missing_secret', () => {
    expectRefused(attempt(makeSecrets({ pgpass: null })), 'config_missing_secret');
  });

  it('age_recipients ausente → config_missing_secret', () => {
    expectRefused(attempt(makeSecrets({ age_recipients: null })), 'config_missing_secret');
  });

  it('rclone.conf ausente → config_missing_secret', () => {
    expectRefused(attempt(makeSecrets({ rclone: null })), 'config_missing_secret');
  });

  it.each([
    ['vazio', ''],
    ['linha em branco', '\n'],
    ['texto qualquer', 'nao-e-recipient\n'],
    ['comentário', `# ${env.recipient}\n${env.recipient}\n`],
    ['identidade privada no lugar do recipient', 'AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ\n'],
    ['recipient maiúsculo', `${env.recipient.toUpperCase()}\n`],
    ['recipient com espaço no fim', `${env.recipient} \n`],
    ['segunda linha inválida', `${env.recipient}\nlixo\n`],
    ['linha em branco entre recipients', `${env.recipient}\n\n${env.recipient}\n`],
  ])('age_recipients inválido: %s', (_n, content) => {
    expectRefused(attempt(makeSecrets({ age_recipients: content })), 'config_invalid_recipients');
  });

  it('rclone.conf sem a seção [risk-backup] (ou com outro nome) → config_invalid_rclone', () => {
    const base = '[outro-remote]\ntype = s3\n';
    expectRefused(attempt(makeSecrets({ rclone: base })), 'config_invalid_rclone');
    expectRefused(attempt(makeSecrets({ rclone: '[risk-backup-2]\ntype = s3\n' })), 'config_invalid_rclone');
  });

  it.each([
    ['RISK_BACKUP_EXPECTED_DB', '', 'config_invalid_db'],
    ['RISK_BACKUP_EXPECTED_DB', 'banco-com-hifen', 'config_invalid_db'],
    ['RISK_BACKUP_EXPECTED_DB', 'a b', 'config_invalid_db'],
    ['RISK_BACKUP_S3_BUCKET', '', 'config_invalid_bucket'],
    ['RISK_BACKUP_S3_BUCKET', 'a..b', 'config_invalid_bucket'],
    ['RISK_BACKUP_S3_BUCKET', '-x', 'config_invalid_bucket'],
    ['RISK_BACKUP_S3_BUCKET', 'a/b', 'config_invalid_bucket'],
    ['RISK_BACKUP_S3_PREFIX', '', 'config_invalid_prefix'],
    ['RISK_BACKUP_S3_PREFIX', '../x', 'config_invalid_prefix'],
    ['RISK_BACKUP_S3_PREFIX', '/abs', 'config_invalid_prefix'],
    ['RISK_BACKUP_S3_PREFIX', 'a//b', 'config_invalid_prefix'],
    ['RISK_BACKUP_S3_PREFIX', 'a/..', 'config_invalid_prefix'],
    ['RISK_BACKUP_S3_PREFIX', 'a b', 'config_invalid_prefix'],
  ])('variável %s=%j → %s', (k, v, ev) => {
    expectRefused(attempt(env.secretsDir, { [k]: v }), ev);
  });

  it('secrets montados como symlink dentro do diretório → recusa (config_missing_secret)', () => {
    const dir = tmpDir('secrets-link');
    const real = makeSecrets();
    for (const f of ['age_recipients', 'rclone.conf']) {
      copyFileSync(join(real, f), join(dir, f));
      chmodSync(join(dir, f), 0o400);
    }
    symlinkSync(join(real, 'pgpass'), join(dir, 'pgpass')); // alvo está fora do diretório montado: no contêiner o link quebra
    expectRefused(attempt(dir), 'config_missing_secret');
  });
});

describe('job: banco errado e login inadequado → 2 sem arquivo', { timeout: 300_000 }, () => {
  it('esperado ≠ banco do pgpass → config_invalid_pgpass', () => {
    expectRefused(attempt(env.secretsDir, { RISK_BACKUP_EXPECTED_DB: 'outro_banco_zz9_test' }), 'config_invalid_pgpass');
  });

  it('pgpass e esperado apontam para banco inexistente → guard_connect_failed (sem arquivo)', () => {
    const secrets = makeSecrets({ pgpass: PG_LINE(env.backupLogin, env.backupPassword, 'nao_existe_zz9_test') });
    expectRefused(attempt(secrets, { RISK_BACKUP_EXPECTED_DB: 'nao_existe_zz9_test' }), 'guard_connect_failed');
  });

  it('senha errada e login inexistente → guard_connect_failed; a senha usada nunca aparece na saída', () => {
    const wrongPw = `errada-${rand(6)}`;
    expectRefused(attempt(makeSecrets({ pgpass: PG_LINE(env.backupLogin, wrongPw) })), 'guard_connect_failed', wrongPw);
    expectRefused(attempt(makeSecrets({ pgpass: PG_LINE(`inexistente_${rand(3)}`, wrongPw) })), 'guard_connect_failed', wrongPw);
  });

  it('host do pgpass inalcançável (nome inexistente na rede interna) → guard_connect_failed', () => {
    expectRefused(attempt(makeSecrets({ pgpass: PG_LINE(env.backupLogin, env.backupPassword, env.db, 'host-que-nao-existe.invalid') })), 'guard_connect_failed');
  });

  async function login(opts: { name: string; attrs?: string; memberOf?: readonly string[]; grants?: readonly string[] }): Promise<string> {
    const name = `zz9_${opts.name}_${rand(3)}`;
    const pw = `pw-${rand(8)}`;
    createdRoles.push(name, `${name}_mid`);
    await admin.query(`CREATE ROLE ${name} LOGIN ${opts.attrs ?? ''} PASSWORD '${pw}'`);
    lastCreds = { name, pw };
    await admin.query(`GRANT openclaw_risk_backup TO ${name}`);
    for (const m of opts.memberOf ?? []) await admin.query(`GRANT ${m} TO ${name}`);
    for (const g of opts.grants ?? []) await admin.query(g.replaceAll('$R', name).replaceAll('$DB', env.db));
    return makeSecrets({ pgpass: PG_LINE(name, pw) });
  }

  it('controle: login só de backup (membro de openclaw_risk_backup, sem escrita) passa na trava', async () => {
    const secrets = await login({ name: 'ctl' });
    const out = tmpDir('out');
    const run = runJob({ out, secrets });
    expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
  });

  const REFUSED: readonly (readonly [string, { name: string; attrs?: string; memberOf?: readonly string[]; grants?: readonly string[] }])[] = [
    ['superuser', { name: 'su', attrs: 'SUPERUSER' }],
    ['membro de openclaw_risk_runtime (INSERT/UPDATE)', { name: 'rt', memberOf: ['openclaw_risk_runtime'] }],
    ['membro de openclaw_risk_owner', { name: 'ow', memberOf: ['openclaw_risk_owner'] }],
    ['INSERT numa tabela', { name: 'ins', grants: ['GRANT INSERT ON risk_audit_events TO $R'] }],
    ['UPDATE numa tabela', { name: 'upd', grants: ['GRANT UPDATE ON risk_operational_state TO $R'] }],
    ['DELETE numa tabela', { name: 'del', grants: ['GRANT DELETE ON risk_outbox TO $R'] }],
    ['TRUNCATE numa tabela', { name: 'trn', grants: ['GRANT TRUNCATE ON risk_outbox TO $R'] }],
    ['ALL PRIVILEGES numa tabela', { name: 'all', grants: ['GRANT ALL ON risk_outbox TO $R'] }],
  ];
  it.each(REFUSED)('login com %s → guard_target_or_privileges_refused', async (_n, spec) => {
    const secrets = await login(spec);
    expectRefused(attempt(secrets), 'guard_target_or_privileges_refused');
  });

  it('o próprio superuser de teste (admin) → recusado', () => {
    const u = new URL(env.adminUrl);
    const secrets = makeSecrets({ pgpass: PG_LINE(decodeURIComponent(u.username), decodeURIComponent(u.password)) });
    expectRefused(attempt(secrets), 'guard_target_or_privileges_refused', decodeURIComponent(u.password));
  });

  // Privilégio de escrita só em COLUNA ou UPDATE em sequência: has_table_privilege(…, 'UPDATE') é falso nesses casos; a trava usa também
  // has_any_column_privilege e has_sequence_privilege.
  it('login com UPDATE só em uma coluna → recusado', async () => {
    const secrets = await login({ name: 'col', grants: ['GRANT UPDATE (payload_json) ON risk_outbox TO $R'] });
    expectRefused(attempt(secrets), 'guard_target_or_privileges_refused');
  });

  it('login com INSERT só em uma coluna → recusado', async () => {
    const secrets = await login({ name: 'cin', grants: ['GRANT INSERT (payload_json) ON risk_outbox TO $R'] });
    expectRefused(attempt(secrets), 'guard_target_or_privileges_refused');
  });

  it('login com UPDATE em uma sequência de public → recusado (inclui via ALL ON SEQUENCE)', async () => {
    const seq = 'risk_operational_state_history_history_id_seq';
    expectRefused(attempt(await login({ name: 'squ', grants: [`GRANT UPDATE ON SEQUENCE ${seq} TO $R`] })), 'guard_target_or_privileges_refused');
    expectRefused(attempt(await login({ name: 'sqa', grants: [`GRANT ALL ON SEQUENCE ${seq} TO $R`] })), 'guard_target_or_privileges_refused');
  });

  it('login com CREATE no schema public → recusado; revogado ao final', async () => {
    const secrets = await login({ name: 'cre', grants: ['GRANT CREATE ON SCHEMA public TO $R'] });
    expectRefused(attempt(secrets), 'guard_target_or_privileges_refused');
  });

  it('CREATE no schema public concedido a PUBLIC também é percebido', async () => {
    const secrets = await login({ name: 'crp' });
    await admin.query('GRANT CREATE ON SCHEMA public TO PUBLIC');
    try {
      expectRefused(attempt(secrets), 'guard_target_or_privileges_refused');
    } finally {
      await admin.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    }
  });

  // Lacunas da trava apontadas pela revisão (T1), corrigidas pelo backend: cada caso é um login que NÃO é "só leitura".
  const GAPS: readonly (readonly [string, { name: string; attrs?: string; memberOf?: readonly string[]; grants?: readonly string[] }])[] = [
    ['CREATEROLE', { name: 'gcr', attrs: 'CREATEROLE' }],
    ['CREATEDB', { name: 'gdb', attrs: 'CREATEDB' }],
    ['REPLICATION', { name: 'grp', attrs: 'REPLICATION' }],
    ['BYPASSRLS', { name: 'gbr', attrs: 'BYPASSRLS' }],
    ['USAGE em sequência (nextval)', { name: 'gsq', grants: ['GRANT USAGE ON SEQUENCE risk_operational_state_history_history_id_seq TO $R'] }],
    ['membro de pg_write_all_data', { name: 'gwd', memberOf: ['pg_write_all_data'] }],
    ['membro NOINHERIT de role escritora (openclaw_risk_runtime)', { name: 'gni', attrs: 'NOINHERIT', memberOf: ['openclaw_risk_runtime'], grants: ['GRANT CONNECT ON DATABASE $DB TO $R'] }],
    ['membro transitivo (via role intermediária) de openclaw_risk_runtime', { name: 'gtr', grants: ['CREATE ROLE $R_mid NOLOGIN', 'GRANT openclaw_risk_runtime TO $R_mid', 'GRANT $R_mid TO $R'] }],
    ['membro de role sem privilégio algum além de openclaw_risk_backup', { name: 'gmx', grants: ['CREATE ROLE $R_mid NOLOGIN', 'GRANT $R_mid TO $R'] }],
    ['dono de schema não-sistema', { name: 'gso', grants: ['CREATE SCHEMA zz9_sch_own AUTHORIZATION $R'] }],
    ['dono de TABELA em schema não-sistema', { name: 'gt2', grants: ['CREATE SCHEMA IF NOT EXISTS zz9_sch', 'CREATE TABLE zz9_sch.t_$R (x int)', 'ALTER TABLE zz9_sch.t_$R OWNER TO $R'] }],
    ['dono de FUNÇÃO em schema não-sistema (S1)', { name: 'gf2', grants: ['CREATE SCHEMA IF NOT EXISTS zz9_sch', 'CREATE FUNCTION zz9_sch.f_$R() RETURNS int LANGUAGE sql AS $$ select 1 $$', 'ALTER FUNCTION zz9_sch.f_$R() OWNER TO $R'] }],
    ['dono de TIPO em schema não-sistema (S1)', { name: 'gy2', grants: ['CREATE SCHEMA IF NOT EXISTS zz9_sch', "CREATE TYPE zz9_sch.e_$R AS ENUM ('a')", 'ALTER TYPE zz9_sch.e_$R OWNER TO $R'] }],
    ['CREATE no banco', { name: 'gdc', grants: ['GRANT CREATE ON DATABASE $DB TO $R'] }],
    ['CREATE em schema que não é public', { name: 'gsc', grants: ['CREATE SCHEMA IF NOT EXISTS zz9_sch', 'GRANT CREATE ON SCHEMA zz9_sch TO $R'] }],
  ];
  it.each(GAPS)('login com %s → recusado', async (_n, spec) => {
    expectRefused(attempt(await login(spec)), 'guard_target_or_privileges_refused');
  });

  it('login que é DONO do banco → recusado; dono original restaurado no finally', async () => {
    const secrets = await login({ name: 'gdo' });
    const name = createdRoles.at(-2) as string;
    const orig = ((await admin.query('select pg_get_userbyid(datdba) o from pg_database where datname = current_database()')).rows[0] as { o: string }).o;
    await admin.query(`ALTER DATABASE ${env.db} OWNER TO ${name}`);
    try {
      expectRefused(attempt(secrets), 'guard_target_or_privileges_refused');
    } finally {
      await admin.query(`ALTER DATABASE ${env.db} OWNER TO "${orig}"`);
    }
  });

  // M2: motivo da allowlist de roles. Login NOINHERIT membro de uma role com INSERT numa tabela de public: o INSERT não é herdado
  // (has_table_privilege do login é falso), mas SET ROLE o libera. A trava tem de recusar mesmo assim.
  it('login NOINHERIT membro de role com INSERT em tabela de public → recusado; sem a trava, SET ROLE permitiria escrever', async () => {
    const secrets = await login({
      name: 'gw',
      attrs: 'NOINHERIT',
      grants: ['GRANT CONNECT ON DATABASE $DB TO $R', 'CREATE ROLE $R_mid NOLOGIN', 'GRANT INSERT ON risk_outbox TO $R_mid', 'GRANT $R_mid TO $R'],
    });
    const { name, pw } = lastCreds;
    const u = new URL(env.adminUrl);
    u.username = name;
    u.password = pw;
    const c = new pg.Client({ connectionString: u.toString() });
    await c.connect();
    try {
      const before = await c.query("select has_table_privilege('risk_outbox','INSERT') as w");
      expect((before.rows[0] as { w: boolean }).w).toBe(false); // sem herança: a trava baseada só em privilégios efetivos não veria nada
      await c.query(`SET ROLE ${name}_mid`);
      const after = await c.query("select has_table_privilege('risk_outbox','INSERT') as w");
      expect((after.rows[0] as { w: boolean }).w).toBe(true); // com SET ROLE o login escreveria
    } finally {
      await c.end();
    }
    expectRefused(attempt(secrets), 'guard_target_or_privileges_refused');
  });

  // M3 / S1: dono de objeto (tabela, função, tipo). Objetos de outros donos revertidos no finally.
  it('login dono de uma tabela de public (OWNER TO login) → recusado', async () => {
    await admin.query('DROP TABLE IF EXISTS public.zz9_own_t');
    const secrets = await login({ name: 'gto', grants: ['CREATE TABLE public.zz9_own_t (x int)', 'ALTER TABLE public.zz9_own_t OWNER TO $R'] });
    try {
      expectRefused(attempt(secrets), 'guard_target_or_privileges_refused');
    } finally {
      await admin.query('DROP TABLE IF EXISTS public.zz9_own_t');
    }
  });

  it('login dono de um schema não-sistema (zz9_sch) → recusado', async () => {
    await admin.query('DROP SCHEMA IF EXISTS zz9_sch CASCADE');
    const secrets = await login({ name: 'gsd', grants: ['CREATE SCHEMA zz9_sch AUTHORIZATION $R'] });
    try {
      expectRefused(attempt(secrets), 'guard_target_or_privileges_refused');
    } finally {
      await admin.query('DROP SCHEMA IF EXISTS zz9_sch CASCADE');
    }
  });

  it('login dono de uma FUNÇÃO de public → recusado; dono original restaurado no finally (S1)', async () => {
    const fn = 'risk_forbid_mutation()';
    const orig = ((await admin.query(`select pg_get_userbyid(proowner) o from pg_proc where oid = 'public.${fn}'::regprocedure`)).rows[0] as { o: string }).o;
    const secrets = await login({ name: 'gfo' });
    const name = lastCreds.name;
    await admin.query(`ALTER FUNCTION public.${fn} OWNER TO ${name}`);
    try {
      expectRefused(attempt(secrets), 'guard_target_or_privileges_refused');
    } finally {
      await admin.query(`ALTER FUNCTION public.${fn} OWNER TO "${orig}"`);
    }
  });

  it('login dono de um TIPO de public (CREATE TYPE ... AS ENUM, OWNER TO login) → recusado (S1)', async () => {
    await admin.query('DROP TYPE IF EXISTS public.zz9_own_ty');
    const secrets = await login({ name: 'gty', grants: ["CREATE TYPE public.zz9_own_ty AS ENUM ('a')", 'ALTER TYPE public.zz9_own_ty OWNER TO $R'] });
    try {
      expectRefused(attempt(secrets), 'guard_target_or_privileges_refused');
    } finally {
      await admin.query('DROP TYPE IF EXISTS public.zz9_own_ty');
    }
  });

  it('login legítimo (SELECT em tabelas e em sequências, USAGE no schema) continua aceito: exit 0 e backup completo', async () => {
    const secrets = await login({ name: 'ok', grants: ['GRANT SELECT ON ALL TABLES IN SCHEMA public TO $R', 'GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO $R'] });
    const out = tmpDir('out');
    const run = runJob({ out, secrets });
    expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(jobEvents(run.stdout).map((e) => e.event)).toEqual(['guard_ok', 'local_backup_ok', 'upload_ok', 'upload_ok', 'backup_complete']);
  });

  it('privilégio concedido a PUBLIC também é percebido (INSERT em tabela via PUBLIC → recusa) e revogado ao final', async () => {
    const secrets = await login({ name: 'pub' });
    await admin.query('GRANT INSERT ON risk_outbox TO PUBLIC');
    try {
      expectRefused(attempt(secrets), 'guard_target_or_privileges_refused');
    } finally {
      await admin.query('REVOKE INSERT ON risk_outbox FROM PUBLIC');
    }
  });
});

describe('job: variáveis rclone obrigatórias (sem default) → 2 antes de conectar no banco', { timeout: 300_000 }, () => {
  const EVENT: Record<RcloneVar, string> = {
    RISK_BACKUP_RCLONE_CONTIMEOUT: 'config_invalid_rclone_contimeout',
    RISK_BACKUP_RCLONE_TIMEOUT: 'config_invalid_rclone_timeout',
    RISK_BACKUP_RCLONE_RETRIES: 'config_invalid_rclone_retries',
    RISK_BACKUP_RCLONE_LOW_LEVEL_RETRIES: 'config_invalid_rclone_low_level_retries',
  };
  const DURATION_BAD = ['', '1000000s', '99999999999999999999s', '0', '0s', '5', '5h', '-1', ' 5s', '5s ', '1e3s', '5S', '05s', '5.5s', '+5s'];
  const COUNT_BAD = ['', '10000', '99999999999999999999', '0', '00', '-1', '1.5', '1e3', '5s', ' 5', '5 ', '05', '+1'];
  const BAD: Record<RcloneVar, readonly string[]> = {
    RISK_BACKUP_RCLONE_CONTIMEOUT: DURATION_BAD,
    RISK_BACKUP_RCLONE_TIMEOUT: DURATION_BAD,
    RISK_BACKUP_RCLONE_RETRIES: COUNT_BAD,
    RISK_BACKUP_RCLONE_LOW_LEVEL_RETRIES: COUNT_BAD,
  };

  // Prova de que a recusa vem antes do banco: o pgpass aponta para host inexistente; se o job tentasse conectar o evento seria
  // guard_connect_failed, e a ordem da validação exige o evento da variável.
  it.each(RCLONE_VARS)('%s ausente → 2 com o evento da variável; pg_dump nunca chamado; nada em /out', (k) => {
    const secrets = makeSecrets({ pgpass: PG_LINE(env.backupLogin, env.backupPassword, env.db, 'host-que-nao-existe.invalid') });
    expectRefused(attempt(secrets, {}, [k]), EVENT[k]);
  });

  it.each(RCLONE_VARS)('%s inválido (zero, sem unidade, unidade h, negativo, espaço, notação científica, ...) → 2 com o evento da variável', (k) => {
    const secrets = makeSecrets({ pgpass: PG_LINE(env.backupLogin, env.backupPassword, env.db, 'host-que-nao-existe.invalid') });
    for (const v of BAD[k]) {
      const r = attempt(secrets, { [k]: v });
      expectRefused(r, EVENT[k]);
      expect(jobEvents(r.run.stdout).map((e) => e.event), `${k}=${JSON.stringify(v)}`).toEqual([EVENT[k]]);
    }
  });

  it('limites superiores aceitos (999999s, 9999): o job passa a validação das variáveis', () => {
    const out = tmpDir('out');
    // timeouts enormes são aceitos pela regex; o S3 de teste responde de imediato, então o job termina 0.
    const run = runJob({ out, secrets: env.secretsDir, env: { RISK_BACKUP_RCLONE_CONTIMEOUT: '999999s', RISK_BACKUP_RCLONE_TIMEOUT: '999999s', RISK_BACKUP_RCLONE_RETRIES: '9999', RISK_BACKUP_RCLONE_LOW_LEVEL_RETRIES: '9999' } });
    expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
  });

  it('controle: com os valores de teste do ciclo o mesmo job passa a trava', () => {
    const out = tmpDir('out');
    const run = runJob({ out, secrets: env.secretsDir });
    expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
  });

  it('backup-prod.sh: variável rclone ausente/inválida no backup.env → 2 "recusado: <VAR> inválido"/incompleta, nenhum contêiner do job criado', () => {
    for (const k of RCLONE_VARS) {
      const cases: (string | null)[] = [null, ...BAD[k].filter((v) => v !== '' && !/\s/.test(v))];
      for (const v of cases) {
        const cfg = makeConfig();
        const lines = readFileSync(cfg.file, 'utf8').split('\n').filter((l) => l !== '' && !l.startsWith(`${k}=`));
        if (v !== null) lines.push(`${k}=${v}`);
        writeFileSync(cfg.file, lines.join('\n') + '\n');
        const r = runBackupProd(cfg.file);
        const tag = `${k}=${String(v)}`;
        expect(r.code, `${tag}\n${r.stdout}\n${r.stderr}`).toBe(2);
        expect(r.stderr, tag).toContain(v === null ? k : `recusado: ${k} inválido`);
        expect(outFiles(cfg.dir), tag).toEqual([]);
        expect(docker(['ps', '-a', '-q', '--filter', `label=${env.jobLabel}`]).stdout.trim(), tag).toBe('');
      }
    }
  });
});

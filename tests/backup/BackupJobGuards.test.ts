import { chmodSync, copyFileSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminPool, bkEnv, jobEvents, makeSecrets, makeStubs, mkMarks, outFiles, rand, runJob, tmpDir, type Run } from './support.js';

// T4a: recusas do job (backup-job.sh, imagem real) ANTES de qualquer escrita: configuração/secrets inválidos, banco errado e
// login com escrita ou superuser. Em toda recusa: código 2, nada em /out, pg_dump nunca chamado (stub com marca). Fixtures fictícias.
const env = bkEnv();
let admin: pg.Pool;
const createdRoles: string[] = [];

const PG_LINE = (login = env.backupLogin, pw = env.backupPassword, db = env.db, host = env.dbAlias, port = '5432'): string => `${host}:${port}:${db}:${login}:${pw}\n`;

beforeAll(() => {
  admin = adminPool();
});
afterAll(async () => {
  for (const r of createdRoles) {
    await admin.query(`DROP OWNED BY ${r}`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${r}`).catch(() => undefined);
  }
  await admin.end();
});

interface Refused {
  readonly run: Run;
  readonly out: string;
  readonly marks: string;
}
/** Roda o job com pg_dump stub que marca a chamada; o stub nunca é chamado numa recusa. */
function attempt(secrets: string, env2: Record<string, string> = {}): Refused {
  const out = tmpDir('out');
  const marks = mkMarks();
  const stubs = makeStubs({ pg_dump: 'touch /marks/pg_dump_called; exec /usr/lib/postgresql/14/bin/pg_dump "$@"' });
  const run = runJob({ out, secrets, stubs, marks, env: env2 });
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
    createdRoles.push(name);
    await admin.query(`CREATE ROLE ${name} LOGIN ${opts.attrs ?? ''} PASSWORD '${pw}'`);
    await admin.query(`GRANT openclaw_risk_backup TO ${name}`);
    for (const m of opts.memberOf ?? []) await admin.query(`GRANT ${m} TO ${name}`);
    for (const g of opts.grants ?? []) await admin.query(g.replace('$R', name));
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

  // Privilégio de escrita só em COLUNA: has_table_privilege(…, 'UPDATE') é falso, então a trava do job (que só olha privilégio de
  // tabela) pode não enxergar. Registrado como lacuna conhecida: it.fails passa enquanto a lacuna existir e quebra quando for corrigida.
  it.fails('LACUNA (reportada ao backend): login com UPDATE só em uma coluna deveria ser recusado', async () => {
    const secrets = await login({ name: 'col', grants: ['GRANT UPDATE (payload_json) ON risk_outbox TO $R'] });
    const r = attempt(secrets);
    expectRefused(r, 'guard_target_or_privileges_refused');
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

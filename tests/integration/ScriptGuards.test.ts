import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Travas de destino dos scripts de operação (backup-local.sh, restore-local.sh, provision-db.sh), executados como processo filho.
// `docker` e `psql` são STUBS no PATH: registram cada invocação e nunca tocam em Docker nem em banco real. Tudo FICTÍCIO.
const ROOT = join(import.meta.dirname, '../..');
const PASS = 'senha-zz9-eco'; // marcador: nenhuma saída pode conter a senha nem a URL
let work: string;
let bin: string;
let log: string;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'risk-script-guards-'));
  bin = join(work, 'bin');
  log = join(work, 'calls.log');
  mkdirSync(bin);
  // docker stub: registra e "sucede" (nunca executa nada). psql stub: registra; responde à consulta de conexão efetiva
  // com STUB_PSQL_OUT (padrão "<banco>|t") e falha se STUB_PSQL_FAIL=1.
  writeFileSync(join(bin, 'docker'), `#!/bin/sh\necho "docker $*" >> "${log}"\nexit 0\n`);
  writeFileSync(
    join(bin, 'psql'),
    `#!/bin/sh
case "$*" in *" -f "*|*"-f "*) echo "psql WRITE" >> "${log}" ;; *) echo "psql CHECK" >> "${log}" ;; esac
[ "\${STUB_PSQL_FAIL:-}" = 1 ] && exit 2
printf '%s\\n' "\${STUB_PSQL_OUT:-}"
exit 0
`,
  );
  chmodSync(join(bin, 'docker'), 0o755);
  chmodSync(join(bin, 'psql'), 0o755);
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

const calls = (): string => (existsSync(log) ? readFileSync(log, 'utf8') : '');
const reset = (): void => {
  rmSync(log, { force: true });
};

interface Result {
  readonly code: number | null;
  readonly out: string;
}
function sh(args: readonly string[], env: Record<string, string>): Result {
  const r = spawnSync('sh', args, { encoding: 'utf8', timeout: 30_000, cwd: work, env: { PATH: `${bin}:/usr/bin:/bin`, HOME: work, ...env } });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

const base = `127.0.0.1:55432/openclaw_risk_zz9_test`;
const url = (suffix = '', hostpart = base) => `postgres://admin:${PASS}@${hostpart}${suffix}`;

// URLs que o guard recusa na sintaxe (antes de qualquer docker/psql).
const SYNTAX_REFUSED: readonly (readonly [string, string])[] = [
  ['query string', url('?sslmode=disable')],
  ['? vazio', url('?')],
  ['host= por query', url('?host=db.example.invalid')],
  ['hostaddr= por query', url('?hostaddr=10.0.0.9')],
  ['dbname= por query', url('?dbname=producao')],
  ['service=', url('?service=prod')],
  ['host= sem ? (usuário/senha)', `postgres://admin:${PASS}@127.0.0.1:55432/openclaw_risk_zz9_test&host=evil`],
  ['dbname= no meio', `postgres://admin:${PASS}@127.0.0.1:55432/openclaw_risk_zz9_test;dbname=x`],
  ['percent-encoding no host', `postgres://admin:${PASS}@127.0.0.%31:55432/openclaw_risk_zz9_test`],
  ['percent-encoding no banco', `postgres://admin:${PASS}@127.0.0.1:55432/openclaw_risk_zz9%5Ftest`],
  ['host remoto', `postgres://admin:${PASS}@db.example.invalid:5432/openclaw_risk_zz9_test`],
  ['host remoto com arroba extra', `postgres://admin:${PASS}@127.0.0.1@db.example.invalid:5432/openclaw_risk_zz9_test`],
  ['IP privado não-loopback', `postgres://admin:${PASS}@10.0.0.5:5432/openclaw_risk_zz9_test`],
  ['banco com caractere inválido', `postgres://admin:${PASS}@127.0.0.1:55432/open-claw_test`],
  ['banco vazio', `postgres://admin:${PASS}@127.0.0.1:55432/`],
  ['sem banco', `postgres://admin:${PASS}@127.0.0.1:55432`],
];

describe('backup-local.sh recusa a URL antes de qualquer docker', () => {
  it.each(SYNTAX_REFUSED)('%s', (_name, bad) => {
    reset();
    const out = join(work, `backup-${randomUUID()}.dump`);
    const r = sh([join(ROOT, 'scripts/backup-local.sh'), out], { RISK_BACKUP_URL: bad });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/recusado/);
    expect(r.out).not.toContain(PASS);
    expect(r.out).not.toMatch(/postgres(ql)?:\/\//);
    expect(existsSync(out)).toBe(false);
    expect(calls()).toBe('');
  });

  it('banco que não termina em _test é recusado (mesmo local e sem parâmetros)', () => {
    reset();
    const r = sh([join(ROOT, 'scripts/backup-local.sh'), join(work, 'x.dump')], { RISK_BACKUP_URL: url('', '127.0.0.1:55432/producao') });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('_test');
    expect(r.out).not.toContain(PASS);
    expect(calls()).toBe('');
  });

  it('controle: URL válida chega ao docker (o stub registra), então os recusados acima eram mesmo barrados antes', () => {
    reset();
    const r = sh([join(ROOT, 'scripts/backup-local.sh'), join(work, 'ok.dump')], { RISK_BACKUP_URL: url() });
    expect(r.code).toBe(0);
    expect(calls()).toMatch(/^docker run /m);
    expect(calls()).not.toContain(PASS); // a URL vai por variável de ambiente, nunca em argumento
  });
});

describe('restore-local.sh recusa a URL antes de qualquer docker', () => {
  const dump = () => {
    const f = join(work, 'in.dump');
    writeFileSync(f, 'fixture');
    return f;
  };

  it.each(SYNTAX_REFUSED)('%s', (_name, bad) => {
    reset();
    const r = sh([join(ROOT, 'scripts/restore-local.sh'), dump()], { RISK_RESTORE_URL: bad });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/recusado/);
    expect(r.out).not.toContain(PASS);
    expect(r.out).not.toMatch(/postgres(ql)?:\/\//);
    expect(calls()).toBe('');
  });

  it('banco que não termina em _test é recusado', () => {
    reset();
    const r = sh([join(ROOT, 'scripts/restore-local.sh'), dump()], { RISK_RESTORE_URL: url('', '127.0.0.1:55432/producao') });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('_test');
    expect(calls()).toBe('');
  });

  it('controle: URL válida chega ao docker', () => {
    reset();
    const r = sh([join(ROOT, 'scripts/restore-local.sh'), dump()], { RISK_RESTORE_URL: url() });
    expect(r.code).toBe(0);
    expect(calls()).toMatch(/^docker run /m);
  });
});

describe('provision-db.sh recusa a URL antes de qualquer psql', () => {
  it.each(SYNTAX_REFUSED)('%s', (_name, bad) => {
    reset();
    const r = sh([join(ROOT, 'scripts/provision-db.sh')], { RISK_PROVISION_URL: bad });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/recusado/);
    expect(r.out).not.toContain(PASS);
    expect(r.out).not.toMatch(/postgres(ql)?:\/\//);
    expect(calls()).toBe('');
  });

  it('RISK_PROVISION_ALLOW_NON_TEST=1 NÃO afrouxa a sintaxe (? / host= / host remoto continuam recusados)', () => {
    for (const [, bad] of SYNTAX_REFUSED) {
      reset();
      const r = sh([join(ROOT, 'scripts/provision-db.sh')], { RISK_PROVISION_URL: bad, RISK_PROVISION_ALLOW_NON_TEST: '1' });
      expect(r.code, bad.replace(PASS, '***')).not.toBe(0);
      expect(calls()).toBe('');
    }
  });

  it('banco não *_test sem a flag explícita é recusado sem psql', () => {
    reset();
    const r = sh([join(ROOT, 'scripts/provision-db.sh')], { RISK_PROVISION_URL: url('', '127.0.0.1:55432/producao') });
    expect(r.code).not.toBe(0);
    expect(calls()).toBe('');
  });

  it('sem RISK_PROVISION_URL → recusa', () => {
    reset();
    const r = sh([join(ROOT, 'scripts/provision-db.sh')], {});
    expect(r.code).not.toBe(0);
    expect(calls()).toBe('');
  });

  it('conexão efetiva ANTES da escrita: banco efetivo diferente, não *_test, servidor não local ou psql falhando → recusa e nenhum psql -f (WRITE)', () => {
    const cases: readonly (readonly [string, Record<string, string>])[] = [
      ['banco efetivo difere', { STUB_PSQL_OUT: 'outro_banco_test|t' }],
      ['banco efetivo sem _test', { STUB_PSQL_OUT: 'openclaw_risk_zz9|t' }],
      ['servidor não local', { STUB_PSQL_OUT: 'openclaw_risk_zz9_test|f' }],
      ['saída vazia', { STUB_PSQL_OUT: '' }],
      ['psql falha', { STUB_PSQL_FAIL: '1' }],
    ];
    for (const [name, extra] of cases) {
      reset();
      const r = sh([join(ROOT, 'scripts/provision-db.sh')], { RISK_PROVISION_URL: url(), ...extra });
      expect(r.code, name).not.toBe(0);
      expect(r.out, name).toMatch(/recusado/);
      expect(r.out).not.toContain(PASS);
      expect(calls(), name).not.toContain('WRITE');
    }
  });

  it('controle: conexão efetiva coerente → psql CHECK e depois WRITE (roles.sql)', () => {
    reset();
    const r = sh([join(ROOT, 'scripts/provision-db.sh')], { RISK_PROVISION_URL: url(), STUB_PSQL_OUT: 'openclaw_risk_zz9_test|t' });
    expect(r.code).toBe(0);
    expect(calls().trim().split('\n')).toEqual(['psql CHECK', 'psql WRITE']);
  });
});

describe('guard-url.sh (biblioteca): effective_conn_check', () => {
  const lib = join(ROOT, 'scripts/lib/guard-url.sh');
  const run = (target: string, extra: Record<string, string>, skipTest = '') =>
    sh(['-c', `. "${lib}"; guard_url_syntax "$U" && effective_conn_check "$U" ${skipTest}`], { U: target, ...extra });

  it('recusa quando o banco efetivo difere do da URL (ex.: pgbouncer/service redirecionando)', () => {
    reset();
    expect(run(url(), { STUB_PSQL_OUT: 'producao_test|t' }).code).not.toBe(0);
  });

  it('com flag de não exigir *_test (só provision), aceita banco efetivo igual ao da URL e ainda exige servidor local', () => {
    reset();
    const prod = `postgres://a:${PASS}@127.0.0.1:55432/producao`;
    expect(run(prod, { STUB_PSQL_OUT: 'producao|t' }, '1').code).toBe(0);
    expect(run(prod, { STUB_PSQL_OUT: 'producao|f' }, '1').code).not.toBe(0);
    expect(run(prod, { STUB_PSQL_OUT: 'producao|t' }).code).not.toBe(0); // sem a flag, banco não *_test é recusado
  });

  it('nenhuma mensagem de recusa contém a URL ou a senha', () => {
    for (const bad of [url('?host=x'), url('', '127.0.0.1:55432/producao')]) {
      const r = run(bad, { STUB_PSQL_OUT: 'producao|t' });
      expect(r.out).not.toContain(PASS);
      expect(r.out).not.toMatch(/postgres(ql)?:\/\//);
    }
  });
});

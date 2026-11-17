import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Travas de scripts/backup-prod.sh e scripts/restore-encrypted-local.sh (ADR-0012), executados como processo filho.
// `docker` é um STUB no PATH: registra cada chamada e nunca toca em Docker real nem em banco. Tudo FICTÍCIO.
// Padrão de tests/integration/ScriptGuards.test.ts. As recusas devem ocorrer ANTES de qualquer `docker run`.
const ROOT = join(import.meta.dirname, '../..');
const DB_PASS = 'senha-bk-zz9-eco'; // marcadores: nenhuma saída nem argumento do docker pode conter estes valores
const S3_SECRET = 'segredo-s3-zz9-eco';
const AGE_RECIPIENT = 'age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';

let work: string;
let bin: string;
let log: string;
let envLog: string;
const holders: ChildProcess[] = [];

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'risk-backup-guards-'));
  bin = join(work, 'bin');
  log = join(work, 'calls.log');
  envLog = join(work, 'run-env.log');
  mkdirSync(bin);
  // docker stub: registra; `image inspect`/`network inspect` obedecem STUB_IMAGE_RC/STUB_NET_RC; `ps` devolve STUB_PS_PRE_OUT
  // (sem filtro de label) ou STUB_PS_LABEL_OUT (com filtro de label); `run` registra variáveis RISK_BACKUP_* e se o fd 9 (lock) vazou,
  // e sai com STUB_RUN_RC. Execução com 'age' (--entrypoint age) imprime STUB_AGE_OUT; com postgres:14-alpine grava o stdin em STUB_STDIN_FILE.
  writeFileSync(
    join(bin, 'docker'),
    `#!/bin/bash
echo "docker $*" >> "${log}"
case "$1 $2" in
  "image inspect") exit "\${STUB_IMAGE_RC:-0}" ;;
  "network inspect") exit "\${STUB_NET_RC:-0}" ;;
esac
case "$1" in
  ps) case "$*" in *label=*) printf '%s' "\${STUB_PS_LABEL_OUT:-}" ;; *) printf '%s' "\${STUB_PS_PRE_OUT:-}" ;; esac; exit 0 ;;
  rm) exit 0 ;;
  run)
    { env | grep '^RISK_BACKUP_' | sort; if [ -e /proc/$$/fd/9 ]; then echo FD9=open; else echo FD9=closed; fi; } >> "${envLog}"
    case "$*" in
      *"--entrypoint age"*) printf '%s' "\${STUB_AGE_OUT:-}"; exit "\${STUB_AGE_RC:-0}" ;;
      *postgres:14-alpine*) cat > "\${STUB_STDIN_FILE:-/dev/null}"; exit "\${STUB_RESTORE_RC:-0}" ;;
    esac
    exit "\${STUB_RUN_RC:-0}" ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
});
afterAll(() => {
  for (const h of holders) if (h.pid !== undefined) try { process.kill(-h.pid, 'SIGKILL'); } catch { /* já terminou */ }
  rmSync(work, { recursive: true, force: true });
});

const calls = (): string => (existsSync(log) ? readFileSync(log, 'utf8') : '');
const runCalls = (): string[] => calls().split('\n').filter((l) => l.startsWith('docker run '));
const reset = (): void => {
  rmSync(log, { force: true });
  rmSync(envLog, { force: true });
};

interface Result {
  readonly code: number | null;
  readonly out: string;
}
function bash(args: readonly string[], env: Record<string, string> = {}, cwd = work): Result {
  const r = spawnSync('bash', args, {
    encoding: 'utf8',
    timeout: 30_000,
    cwd,
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: work, ...env },
  });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

interface Fixture {
  readonly dir: string;
  readonly backups: string;
  readonly secrets: string;
  readonly conf: string;
  readonly values: Record<string, string>;
}
let seq = 0;
// Valores FICTÍCIOS de teste (não são os de produção, que são decisão do deploy U5).
const RCLONE_VALUES: Record<string, string> = {
  RISK_BACKUP_RCLONE_CONTIMEOUT: '3s',
  RISK_BACKUP_RCLONE_TIMEOUT: '10s',
  RISK_BACKUP_RCLONE_RETRIES: '2',
  RISK_BACKUP_RCLONE_LOW_LEVEL_RETRIES: '3',
};
const RCLONE_KEYS = Object.keys(RCLONE_VALUES);
const FILES: Record<string, string> = {
  pgpass: `db.internal:5432:openclaw_risk_zz9:risk_backup_login:${DB_PASS}\n`,
  age_recipients: `${AGE_RECIPIENT}\n`,
  'rclone.conf': `[risk-backup]\ntype = s3\naccess_key_id = AKIDZZ9\nsecret_access_key = ${S3_SECRET}\n`,
};
function fixture(overrides: Record<string, string | null> = {}): Fixture {
  const dir = join(work, `fx-${++seq}`);
  const backups = join(dir, 'backups');
  const secrets = join(dir, 'secrets');
  mkdirSync(backups, { recursive: true, mode: 0o700 });
  mkdirSync(secrets, { mode: 0o700 });
  chmodSync(backups, 0o700);
  chmodSync(secrets, 0o700);
  for (const [n, c] of Object.entries(FILES)) {
    writeFileSync(join(secrets, n), c, { mode: 0o400 });
    chmodSync(join(secrets, n), 0o400);
  }
  const values: Record<string, string> = {
    RISK_BACKUP_EXPECTED_DB: 'openclaw_risk_zz9',
    RISK_BACKUP_DIR: backups,
    RISK_BACKUP_SECRETS_DIR: secrets,
    RISK_BACKUP_S3_BUCKET: 'bucket-zz9',
    RISK_BACKUP_S3_PREFIX: 'prefix-zz9/sub',
    RISK_BACKUP_IMAGE: 'openclaw-risk-backup:zz9',
    RISK_BACKUP_DOCKER_NETWORK: 'net-zz9',
    ...RCLONE_VALUES,
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === null) Reflect.deleteProperty(values, k);
    else values[k] = v;
  }
  const conf = join(dir, 'backup.env');
  writeFileSync(conf, Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
  return { dir, backups, secrets, conf, values };
}
const backupProd = (conf: string, env: Record<string, string> = {}): Result => bash([join(ROOT, 'scripts/backup-prod.sh'), conf], env);
const leftovers = (f: Fixture): string[] => readdirSync(f.backups).filter((n) => n !== '.lock');

describe('backup-prod.sh: recusas de configuração (código 2, nenhuma chamada docker, nada gravado)', () => {
  beforeEach(reset);

  it('sem argumento, com argumento extra, arquivo ausente, diretório no lugar do arquivo → 2', () => {
    const f = fixture();
    for (const args of [[], [f.conf, 'extra'], [join(f.dir, 'nao-existe.env')], [f.dir]]) {
      const r = bash([join(ROOT, 'scripts/backup-prod.sh'), ...args]);
      expect(r.code, args.join(' ')).toBe(2);
    }
    expect(calls()).toBe('');
  });

  it('arquivo de configuração symlink → 2', () => {
    const f = fixture();
    const link = join(f.dir, 'link.env');
    symlinkSync(f.conf, link);
    const r = backupProd(link);
    expect(r.code).toBe(2);
    expect(r.out).toContain('symlink');
    expect(calls()).toBe('');
  });

  it('chave obrigatória ausente (cada uma das 11) → 2', () => {
    for (const k of ['RISK_BACKUP_EXPECTED_DB', 'RISK_BACKUP_DIR', 'RISK_BACKUP_SECRETS_DIR', 'RISK_BACKUP_S3_BUCKET', 'RISK_BACKUP_S3_PREFIX', 'RISK_BACKUP_IMAGE', 'RISK_BACKUP_DOCKER_NETWORK', ...RCLONE_KEYS]) {
      const f = fixture({ [k]: null });
      const r = backupProd(f.conf);
      expect(r.code, k).toBe(2);
      expect(r.out, k).toMatch(/incompleta/);
    }
    expect(calls()).toBe('');
  });

  // Cada uma das 4 variáveis do rclone: ausente (já coberto acima) e inválida → 2, mensagem nomeando a variável, nenhuma chamada docker.
  const RCLONE_BAD: readonly (readonly [string, readonly string[]])[] = [
    ['RISK_BACKUP_RCLONE_CONTIMEOUT', ['1000000s', '99999999999999999999s', '0', '0s', '5', '5h', '-1', ' 5s', '5 s', '1e3s', '5S', '05s', 'abc', '5s5s', '5.5s', '+5s', '5s;id']],
    ['RISK_BACKUP_RCLONE_TIMEOUT', ['1000000s', '99999999999999999999s', '0', '0m', '5', '5h', '-1', ' 5s', '5 s', '1e3s', '5S', '05s', 'abc', '5s5s', '5.5s', '+5s', '5s;id']],
    ['RISK_BACKUP_RCLONE_RETRIES', ['10000', '99999999999999999999', '0', '00', '-1', '1.5', '1e3', '5s', ' 5', '5 ', '05', 'abc', '+1', '0x5']],
    ['RISK_BACKUP_RCLONE_LOW_LEVEL_RETRIES', ['10000', '99999999999999999999', '0', '00', '-1', '1.5', '1e3', '5s', ' 5', '5 ', '05', 'abc', '+1', '0x5']],
  ];
  it.each(RCLONE_BAD)('%s inválido → 2 "recusado: <VAR> inválido", sem docker run', (k, bads) => {
    for (const v of bads) {
      reset();
      // Linha com espaço/aspas é recusada antes por outra regra (também 2); o essencial é nunca chegar ao docker run.
      const f = fixture({ [k]: v });
      const r = backupProd(f.conf);
      expect(r.code, `${k}=${JSON.stringify(v)}`).toBe(2);
      expect(runCalls(), `${k}=${JSON.stringify(v)}`).toEqual([]);
      expect(leftovers(f)).toEqual([]);
    }
  });
  it.each(RCLONE_BAD)('%s com valor sem espaço e sintaticamente inválido cita a variável na recusa', (k, bads) => {
    for (const v of bads.filter((x) => !/\s|;/.test(x))) {
      const f = fixture({ [k]: v });
      const r = backupProd(f.conf);
      expect(r.code, v).toBe(2);
      expect(r.out, v).toContain(`recusado: ${k} inválido`);
    }
  });

  it('valores válidos limítrofes (1ms, 1s, 1m, 999999s; retries 1, 100 e 9999) são aceitos e repassados', () => {
    for (const [ct, t, rt, ll] of [['1ms', '1s', '1', '1'], ['1m', '999999s', '100', '100'], ['1s', '1s', '9999', '9999']] as const) {
      reset();
      const f = fixture({ RISK_BACKUP_RCLONE_CONTIMEOUT: ct, RISK_BACKUP_RCLONE_TIMEOUT: t, RISK_BACKUP_RCLONE_RETRIES: rt, RISK_BACKUP_RCLONE_LOW_LEVEL_RETRIES: ll });
      expect(backupProd(f.conf).code).toBe(0);
      const env = readFileSync(envLog, 'utf8');
      expect(env).toContain(`RISK_BACKUP_RCLONE_CONTIMEOUT=${ct}`);
      expect(env).toContain(`RISK_BACKUP_RCLONE_LOW_LEVEL_RETRIES=${ll}`);
    }
  });

  it('chave presente com valor vazio → 2', () => {
    const f = fixture({ RISK_BACKUP_S3_BUCKET: '' });
    expect(backupProd(f.conf).code).toBe(2);
    expect(calls()).toBe('');
  });

  it('linhas inválidas: espaço, aspas, $, crase, barra invertida, sem "=", minúscula, chave desconhecida → 2 e nada é executado', () => {
    const marker = join(work, 'executado');
    const bad = [
      'RISK_BACKUP_S3_BUCKET=a b',
      `RISK_BACKUP_S3_BUCKET="bucket-zz9"`,
      `RISK_BACKUP_S3_BUCKET='bucket-zz9'`,
      'RISK_BACKUP_S3_BUCKET=$HOME',
      `RISK_BACKUP_S3_BUCKET=$(touch ${marker})`,
      `RISK_BACKUP_S3_BUCKET=\`touch ${marker}\``,
      'RISK_BACKUP_S3_BUCKET=a\\b',
      'RISK_BACKUP_S3_BUCKET',
      'risk_backup_s3_bucket=x',
      'RISK_BACKUP_AWS_SECRET=x',
      'PATH=/tmp',
      ' RISK_BACKUP_S3_BUCKET=x',
      `touch ${marker}`,
    ];
    for (const line of bad) {
      const f = fixture();
      writeFileSync(f.conf, `${readFileSync(f.conf, 'utf8')}${line}\n`);
      const r = backupProd(f.conf);
      expect(r.code, line).toBe(2);
      expect(r.out).toMatch(/recusado/);
    }
    expect(existsSync(marker)).toBe(false);
    expect(calls()).toBe('');
  });

  it('valores adversariais (banco, bucket, prefixo, imagem, rede) → 2', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['RISK_BACKUP_EXPECTED_DB', 'banco-com-hifen'],
      ['RISK_BACKUP_EXPECTED_DB', 'a;b'],
      ['RISK_BACKUP_EXPECTED_DB', 'a/b'],
      ['RISK_BACKUP_EXPECTED_DB', '../x'],
      ['RISK_BACKUP_S3_BUCKET', '-inicia-com-hifen'],
      ['RISK_BACKUP_S3_BUCKET', 'a..b'],
      ['RISK_BACKUP_S3_BUCKET', 'a/b'],
      ['RISK_BACKUP_S3_BUCKET', 'risk-backup:outro'],
      ['RISK_BACKUP_S3_PREFIX', '/absoluto'],
      ['RISK_BACKUP_S3_PREFIX', 'a/../b'],
      ['RISK_BACKUP_S3_PREFIX', '..'],
      ['RISK_BACKUP_S3_PREFIX', 'a//b'],
      ['RISK_BACKUP_S3_PREFIX', 'a/'],
      ['RISK_BACKUP_S3_PREFIX', 'a:b'],
      ['RISK_BACKUP_IMAGE', '--privileged'],
      ['RISK_BACKUP_IMAGE', '-v/:/host'],
      ['RISK_BACKUP_DOCKER_NETWORK', 'host/x'],
      ['RISK_BACKUP_DOCKER_NETWORK', '--network=host'],
      ['RISK_BACKUP_DOCKER_NETWORK', '-x'],
    ];
    for (const [k, v] of cases) {
      const f = fixture({ [k]: v });
      const r = backupProd(f.conf);
      expect(r.code, `${k}=${v}`).toBe(2);
    }
    expect(calls()).toBe('');
  });

  it('diretórios: relativo, ausente, symlink, com .., modo 0750/0755/0701/0777/0500, igual ao de secrets → 2', () => {
    const mk = (mutate: (f: Fixture) => Record<string, string>): Result => {
      const f = fixture();
      const o = mutate(f);
      const g = fixture(o);
      return backupProd(g.conf);
    };
    expect(mk(() => ({ RISK_BACKUP_DIR: 'relativo/dir' })).code).toBe(2);
    expect(mk(() => ({ RISK_BACKUP_DIR: join(work, 'nao-existe-zz9') })).code).toBe(2);
    expect(mk(() => ({ RISK_BACKUP_SECRETS_DIR: join(work, 'nao-existe-zz9') })).code).toBe(2);
    expect(mk((f) => ({ RISK_BACKUP_DIR: `${f.backups}/../backups` })).code).toBe(2);
    expect(mk((f) => ({ RISK_BACKUP_SECRETS_DIR: `${f.secrets}/../secrets` })).code).toBe(2);
    expect(mk((f) => ({ RISK_BACKUP_DIR: f.secrets, RISK_BACKUP_SECRETS_DIR: f.secrets })).code).toBe(2);
    const f1 = fixture();
    const link = join(f1.dir, 'dir-link');
    symlinkSync(f1.backups, link);
    expect(backupProd(fixture({ RISK_BACKUP_DIR: link }).conf).code).toBe(2);
    const slink = join(f1.dir, 'sec-link');
    symlinkSync(f1.secrets, slink);
    expect(backupProd(fixture({ RISK_BACKUP_SECRETS_DIR: slink }).conf).code).toBe(2);
    for (const mode of [0o750, 0o755, 0o701, 0o777, 0o500, 0o600]) {
      const fb = fixture();
      chmodSync(fb.backups, mode);
      expect(backupProd(fb.conf).code, `backup ${mode.toString(8)}`).toBe(2);
      chmodSync(fb.backups, 0o700);
      const fs = fixture();
      chmodSync(fs.secrets, mode);
      expect(backupProd(fs.conf).code, `secrets ${mode.toString(8)}`).toBe(2);
      chmodSync(fs.secrets, 0o700);
    }
    expect(calls()).toBe('');
  });

  it('secrets: ausente, symlink, modo 0440/0444/0600/0644/0000/0700 → 2 (cada um dos 3 arquivos)', () => {
    for (const name of Object.keys(FILES)) {
      const fAbsent = fixture();
      rmSync(join(fAbsent.secrets, name));
      expect(backupProd(fAbsent.conf).code, `${name} ausente`).toBe(2);

      const fLink = fixture();
      const real = join(fLink.dir, 'real-secret');
      writeFileSync(real, FILES[name] as string, { mode: 0o400 });
      chmodSync(real, 0o400);
      rmSync(join(fLink.secrets, name));
      symlinkSync(real, join(fLink.secrets, name));
      expect(backupProd(fLink.conf).code, `${name} symlink`).toBe(2);

      for (const mode of [0o440, 0o444, 0o600, 0o644, 0o000, 0o700, 0o404]) {
        const f = fixture();
        chmodSync(join(f.secrets, name), mode);
        const r = backupProd(f.conf);
        expect(r.code, `${name} ${mode.toString(8)}`).toBe(2);
        expect(r.out).not.toContain(DB_PASS);
        expect(r.out).not.toContain(S3_SECRET);
      }
    }
    expect(calls()).toBe('');
  });

  it('imagem inexistente ou rede inexistente → 2, só `inspect` foi chamado (nunca run/pull)', () => {
    const f = fixture();
    expect(backupProd(f.conf, { STUB_IMAGE_RC: '1' }).code).toBe(2);
    expect(backupProd(f.conf, { STUB_NET_RC: '1' }).code).toBe(2);
    for (const l of calls().split('\n').filter(Boolean)) expect(l).toMatch(/^docker (image|network) inspect /);
    expect(runCalls()).toHaveLength(0);
    expect(leftovers(f)).toEqual([]);
  });

  it('contêiner de mesmo nome já existe → 2 sem docker run', () => {
    const f = fixture();
    const r = backupProd(f.conf, { STUB_PS_PRE_OUT: 'abc123\n' });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/já existe/);
    expect(runCalls()).toHaveLength(0);
  });

  it('nenhuma gravação no diretório de backup nas recusas (só o .lock quando a trava foi tomada)', () => {
    const f = fixture({ RISK_BACKUP_S3_PREFIX: '..' });
    expect(backupProd(f.conf).code).toBe(2);
    expect(leftovers(f)).toEqual([]);
    expect(existsSync(join(f.backups, '.lock'))).toBe(false);
  });
});

describe('backup-prod.sh: lock ocupado → 3', () => {
  beforeEach(reset);
  afterEach(() => {
    for (const h of holders.splice(0)) if (h.pid !== undefined) try { process.kill(-h.pid, 'SIGKILL'); } catch { /* já terminou */ }
  });

  it('com o flock em uso por outro processo: sai 3, não chama docker run; liberado o lock, a execução seguinte vai', async () => {
    const f = fixture();
    const lock = join(f.backups, '.lock');
    const holder = spawn('flock', ['-n', lock, 'sleep', '60'], { stdio: 'ignore', detached: true });
    holders.push(holder);
    // Espera o holder segurar o lock (tentativa não bloqueante que falha).
    let held = false;
    for (let i = 0; i < 50 && !held; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      held = existsSync(lock) && spawnSync('flock', ['-n', lock, 'true']).status !== 0;
    }
    expect(held).toBe(true);
    const r = backupProd(f.conf);
    expect(r.code).toBe(3);
    expect(r.out).toMatch(/em andamento/);
    expect(runCalls()).toHaveLength(0);
    expect(leftovers(f)).toEqual([]);
    process.kill(-(holder.pid as number), 'SIGKILL'); // grupo inteiro: o `sleep` filho também segura o fd do lock
    await new Promise((res) => holder.once('exit', res));
    await new Promise((res) => setTimeout(res, 200));
    reset();
    const again = backupProd(f.conf);
    expect(again.code).toBe(0);
    expect(runCalls()).toHaveLength(1);
  });
});

describe('backup-prod.sh: docker run (stub)', () => {
  beforeEach(reset);

  it('argumentos: endurecidos e sem nenhum segredo; só nomes de variáveis, valores só no ambiente do processo', () => {
    const f = fixture();
    const r = backupProd(f.conf);
    expect(r.code).toBe(0);
    const runs = runCalls();
    expect(runs).toHaveLength(1);
    const line = runs[0] as string;
    for (const flag of ['--rm', '--pull never', '--name openclaw-risk-backup-openclaw_risk_zz9', '--label com.openclaw-risk-engine.backup=openclaw_risk_zz9', '--read-only', '--cap-drop ALL', '--security-opt no-new-privileges', '--network net-zz9', `-v ${f.backups}:/out`, `-v ${f.secrets}:/run/secrets:ro`, '--entrypoint /usr/local/bin/backup-job.sh openclaw-risk-backup:zz9']) {
      expect(line, flag).toContain(flag);
    }
    expect(line).toMatch(new RegExp(`--user ${process.getuid?.()}:${process.getgid?.()} `));
    expect(line).not.toMatch(/--privileged|--network host|docker\.sock|--tmpfs|--cap-add|--env-file/);
    // `-e NOME` sem "=valor".
    expect([...line.matchAll(/ -e (\S+)/g)].map((m) => m[1]).sort()).toEqual(['RISK_BACKUP_EXPECTED_DB', ...RCLONE_KEYS, 'RISK_BACKUP_S3_BUCKET', 'RISK_BACKUP_S3_PREFIX'].sort());
    // Nenhum segredo (senha do banco, secret do S3, recipient, conteúdo de arquivos) em argumentos nem na saída do script.
    for (const secret of [DB_PASS, S3_SECRET, 'AKIDZZ9', AGE_RECIPIENT, 'risk_backup_login', 'db.internal']) {
      expect(calls(), secret).not.toContain(secret);
      expect(r.out, secret).not.toContain(secret);
    }
    // O ambiente do `docker run` tem só as variáveis não secretas (3 + 4 do rclone) e o fd do lock não vaza.
    const env = readFileSync(envLog, 'utf8');
    expect(env).toContain('RISK_BACKUP_EXPECTED_DB=openclaw_risk_zz9');
    expect(env).toContain('RISK_BACKUP_S3_BUCKET=bucket-zz9');
    expect(env).toContain('RISK_BACKUP_S3_PREFIX=prefix-zz9/sub');
    expect(env.split('\n').filter((l) => l.startsWith('RISK_BACKUP_')).map((l) => l.split('=')[0]).sort()).toEqual(['RISK_BACKUP_EXPECTED_DB', ...RCLONE_KEYS, 'RISK_BACKUP_S3_BUCKET', 'RISK_BACKUP_S3_PREFIX'].sort());
    for (const [k, v] of Object.entries(RCLONE_VALUES)) expect(env).toContain(`${k}=${v}`);
    expect(env).toContain('FD9=closed');
    expect(env).not.toContain(DB_PASS);
  });

  it('variáveis RISK_BACKUP_* do ambiente do operador não vazam para o contêiner nem alteram a configuração', () => {
    const f = fixture();
    const r = backupProd(f.conf, { RISK_BACKUP_S3_BUCKET: 'bucket-do-ambiente', RISK_BACKUP_EXPECTED_DB: 'outro_banco', RISK_BACKUP_EXTRA: 'x' });
    expect(r.code).toBe(0);
    const env = readFileSync(envLog, 'utf8');
    expect(env).toContain('RISK_BACKUP_S3_BUCKET=bucket-zz9');
    expect(env).toContain('RISK_BACKUP_EXPECTED_DB=openclaw_risk_zz9');
    expect(runCalls()[0]).not.toContain('RISK_BACKUP_EXTRA'); // o docker só repassa por `-e NOME` explícito
  });

  it.each([
    [0, 0],
    [2, 2],
    [4, 4],
    [5, 5],
    [6, 6],
    [1, 4],
    [3, 4], // 3 é exclusivo do flock do backup-prod.sh: vindo do contêiner é código inesperado
    [7, 4],
    [125, 4],
    [126, 4],
    [127, 4],
    [137, 4],
  ])('código %i do contêiner → %i do script (nunca sucesso espúrio)', (docker, expected) => {
    const f = fixture();
    const r = backupProd(f.conf, { STUB_RUN_RC: String(docker) });
    expect(r.code).toBe(expected);
    expect(runCalls()).toHaveLength(1);
  });

  it('o trap remove só o contêiner deste job (nome fixo e label) e nada mais', () => {
    const f = fixture();
    backupProd(f.conf, { STUB_RUN_RC: '4', STUB_PS_LABEL_OUT: 'deadbeef01\ndeadbeef02\n' });
    const l = calls().split('\n').filter(Boolean);
    const ps = l.filter((x) => x.startsWith('docker ps ') && x.includes('label='));
    expect(ps).toHaveLength(1);
    expect(ps[0]).toContain('--filter name=^openclaw-risk-backup-openclaw_risk_zz9$');
    expect(ps[0]).toContain('--filter label=com.openclaw-risk-engine.backup=openclaw_risk_zz9');
    expect(l.filter((x) => x.startsWith('docker rm '))).toEqual(['docker rm -f -v deadbeef01 deadbeef02']);
    for (const x of l) expect(x).not.toMatch(/prune|volume rm|network rm|image rm|system /);
  });

  it('sem contêiner remanescente, o trap não chama docker rm', () => {
    const f = fixture();
    backupProd(f.conf);
    expect(calls()).not.toMatch(/^docker rm /m);
  });
});

describe('restore-encrypted-local.sh: recusas antes de qualquer docker run (stub)', () => {
  let r: string; // diretório de trabalho do caso
  const URL = (db = 'openclaw_risk_restore_zz9_test', host = '127.0.0.1:55999') => `postgres://admin:${DB_PASS}@${host}/${db}`;
  const sha = (file: string) => spawnSync('sha256sum', [file], { encoding: 'utf8' }).stdout.split(' ')[0] as string;
  let age: string;
  let id: string;
  const base = 'openclaw_risk_zz9-20261116T010203Z.dump.age';

  beforeEach(() => {
    reset();
    r = join(work, `re-${++seq}`);
    mkdirSync(r, { mode: 0o700 });
    age = join(r, base);
    writeFileSync(age, 'age-encryption.org/v1\nconteudo-ficticio');
    writeFileSync(`${age}.sha256`, `${sha(age)}  ${base}\n`);
    id = join(r, 'identity.txt');
    writeFileSync(id, 'AGE-SECRET-KEY-FICTICIA-ZZ9\n', { mode: 0o400 });
    chmodSync(id, 0o400);
  });
  const restore = (file: string, env: Record<string, string | undefined>): Result => {
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v;
    return bash([join(ROOT, 'scripts/restore-encrypted-local.sh'), file], { PATH: `${bin}:/usr/bin:/bin:${join(process.execPath, '..')}`, ...clean });
  };
  const okEnv = (): Record<string, string> => ({ RISK_RESTORE_URL: URL(), RISK_RESTORE_AGE_IDENTITY_FILE: id });
  const noRun = (res: Result): void => {
    expect(res.code).toBe(1);
    expect(res.out).toMatch(/recusado|defina|uso/);
    expect(res.out).not.toContain(DB_PASS);
    expect(res.out).not.toMatch(/postgres(ql)?:\/\//);
    expect(runCalls()).toHaveLength(0);
  };

  it('sem URL, sem identidade, sem argumento → falha sem docker', () => {
    expect(restore(age, { RISK_RESTORE_AGE_IDENTITY_FILE: id }).code).not.toBe(0);
    expect(restore(age, { RISK_RESTORE_URL: URL() }).code).not.toBe(0);
    expect(bash([join(ROOT, 'scripts/restore-encrypted-local.sh')], okEnv()).code).not.toBe(0);
    expect(calls()).toBe('');
  });

  it.each([
    ['banco sem _test', URL('openclaw_risk_zz9')],
    ['host remoto', URL('x_test', 'db.example.invalid:5432')],
    ['query string', `${URL()}?sslmode=disable`],
    ['host= na URL', `${URL()}&host=evil`],
    ['dbname=', `${URL()}?dbname=producao`],
    ['percent-encoding', URL('openclaw_risk_zz9%5Ftest')],
  ])('URL recusada: %s', (_n, url) => {
    noRun(restore(age, { RISK_RESTORE_URL: url, RISK_RESTORE_AGE_IDENTITY_FILE: id }));
  });

  it('identidade: relativa, ausente, symlink, modos 0444/0640/0644/0200 → recusa', () => {
    noRun(restore(age, { ...okEnv(), RISK_RESTORE_AGE_IDENTITY_FILE: 'identity.txt' }));
    noRun(restore(age, { ...okEnv(), RISK_RESTORE_AGE_IDENTITY_FILE: join(r, 'nao-existe') }));
    const link = join(r, 'id-link');
    symlinkSync(id, link);
    noRun(restore(age, { ...okEnv(), RISK_RESTORE_AGE_IDENTITY_FILE: link }));
    for (const mode of [0o444, 0o640, 0o644, 0o200, 0o700]) {
      chmodSync(id, mode);
      noRun(restore(age, okEnv()));
    }
    chmodSync(id, 0o400);
  });

  it('arquivo: ausente, symlink, extensão errada, diretório → recusa', () => {
    noRun(restore(join(r, 'nao.dump.age'), okEnv()));
    const link = join(r, 'link.dump.age');
    symlinkSync(age, link);
    noRun(restore(link, okEnv()));
    const wrong = join(r, 'x.dump');
    writeFileSync(wrong, 'x');
    writeFileSync(`${wrong}.sha256`, `${sha(wrong)}  x.dump\n`);
    noRun(restore(wrong, okEnv()));
    noRun(restore(r, okEnv()));
  });

  it('.sha256: ausente, symlink, vazio, 2 linhas, hash curto/maiúsculo, nome divergente, conteúdo adulterado → recusa', () => {
    const shaFile = `${age}.sha256`;
    const good = readFileSync(shaFile, 'utf8');
    const h = sha(age);
    rmSync(shaFile);
    noRun(restore(age, okEnv()));
    const real = join(r, 'real.sha256');
    writeFileSync(real, good);
    symlinkSync(real, shaFile);
    noRun(restore(age, okEnv()));
    rmSync(shaFile);
    const variants = ['', `${good}${good}`, `${h.slice(0, 63)}  ${base}\n`, `${h.toUpperCase()}  ${base}\n`, `${h}  outro.dump.age\n`, `${'0'.repeat(64)}  ${base}\n`, h];
    for (const v of variants) {
      writeFileSync(shaFile, v);
      noRun(restore(age, okEnv()));
    }
    // Arquivo adulterado depois do .sha256 correto.
    writeFileSync(shaFile, good);
    writeFileSync(age, 'age-encryption.org/v1\nconteudo-ADULTERADO');
    const r2 = restore(age, okEnv());
    noRun(r2);
    expect(r2.out).toMatch(/checksum diverge/);
  });

  it('imagem de decifragem ausente → recusa; só `image inspect` é chamado', () => {
    const res = restore(age, { ...okEnv(), STUB_IMAGE_RC: '1' });
    expect(res.code).toBe(1);
    expect(runCalls()).toHaveLength(0);
    for (const l of calls().split('\n').filter(Boolean)) expect(l).toMatch(/^docker image inspect /);
  });

  it('não decifra (saída sem PGDMP) → recusa ANTES do restore-local.sh: nenhum docker run com postgres, nada restaurado', () => {
    for (const out of ['', 'PGDM', 'texto qualquer', 'age-encryption.org/v1', ' PGDMP']) {
      reset();
      const res = restore(age, { ...okEnv(), STUB_AGE_OUT: out, STUB_AGE_RC: out === '' ? '1' : '0' });
      expect(res.code, out).toBe(1);
      expect(res.out).toMatch(/não foi possível decifrar/);
      const runs = runCalls();
      expect(runs.length).toBeGreaterThanOrEqual(1);
      for (const l of runs) {
        expect(l).toContain('--entrypoint age');
        expect(l).not.toContain('postgres:14-alpine');
      }
    }
  });

  it('decifragem: contêiner sem rede, somente leitura, sem capabilities, identidade e arquivo :ro; nenhum segredo em argumentos', () => {
    const stdin = join(r, 'stdin.bin');
    const res = restore(age, { ...okEnv(), STUB_AGE_OUT: 'PGDMPzz9conteudo', STUB_STDIN_FILE: stdin });
    expect(res.code).toBe(0);
    const age1 = runCalls().find((l) => l.includes('--entrypoint age')) as string;
    for (const flag of ['--network none', '--read-only', '--cap-drop ALL', '--security-opt no-new-privileges', `-v ${age}:/in/dump.age:ro`, `-v ${id}:/run/identity/key:ro`, '--pull never']) {
      expect(age1, flag).toContain(flag);
    }
    expect(age1).not.toMatch(/--privileged|--network host|-e /);
    for (const l of calls().split('\n')) {
      expect(l).not.toContain(DB_PASS);
      expect(l).not.toContain('AGE-SECRET-KEY');
    }
    // O restore recebe o dump pelo stdin (modo '-'), sem arquivo em /in: o contêiner postgres recebe só provisionamento.
    expect(readFileSync(stdin, 'utf8')).toBe('PGDMPzz9conteudo');
    const pg = runCalls().find((l) => l.includes('postgres:14-alpine')) as string;
    expect(pg).toMatch(/docker run --rm -i /);
    expect(pg).not.toContain(age);
    expect(calls()).toMatch(/roles\.sql -\s*$/m); // argumento posicional "-" (stdin) do sh -c
    // A identidade privada só foi montada no contêiner de decifragem.
    expect(pg).not.toContain(id);
  });

  it('falha do restore (pg_restore) propaga código diferente de zero (pipefail)', () => {
    const res = restore(age, { ...okEnv(), STUB_AGE_OUT: 'PGDMPzz9', STUB_RESTORE_RC: '3' });
    expect(res.code).not.toBe(0);
  });
});

describe('restore-local.sh modo "-" (stub)', () => {
  beforeEach(reset);
  it('recusa URL não *_test sem docker, mesmo lendo do stdin', () => {
    const res = spawnSync('sh', [join(ROOT, 'scripts/restore-local.sh'), '-'], {
      input: 'PGDMPzz9',
      encoding: 'utf8',
      env: { PATH: `${bin}:/usr/bin:/bin`, RISK_RESTORE_URL: `postgres://admin:${DB_PASS}@127.0.0.1:55999/producao` },
    });
    expect(res.status).not.toBe(0);
    expect(`${res.stdout}${res.stderr}`).toContain('_test');
    expect(`${res.stdout}${res.stderr}`).not.toContain(DB_PASS);
    expect(calls()).toBe('');
  });
});

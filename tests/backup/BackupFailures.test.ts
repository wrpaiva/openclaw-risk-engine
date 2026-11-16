import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NAME_RE, adminPool, bkEnv, docker, jobEvents, makeConfig, makeSecrets, makeStubs, mkMarks, outFiles, rand, rcloneRoot, readSecret, runBackupProd, runJob, s3Get, s3List, sleep, startBackupProd, tmpDir } from './support.js';

// T4b: falhas do job com a imagem real (stubs de pg_dump/age/date por PATH). Em toda falha: código esperado, nenhum arquivo final
// parcial, nenhum .partial remanescente e NENHUM objeto novo no S3 quando o código é 4. Fixtures fictícias.
const env = bkEnv();
const FIXED_TS = '20261116T120000Z';
const FIXED_NAME = `${env.db}-${FIXED_TS}.dump.age`;
const DATE_STUB = `if [ "$1 $2" = "-u +%Y%m%dT%H%M%SZ" ]; then echo ${FIXED_TS}; else exec /usr/bin/date "$@"; fi`;
const AGE_PARSE_OUT = 'out=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; *) shift ;; esac; done';
const REAL_PG_DUMP = 'exec /usr/lib/postgresql/14/bin/pg_dump "$@"';

const prefixOf = (): string => `${env.prefix}/${rand(4)}`;
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

interface Case {
  readonly out: string;
  readonly prefix: string;
  readonly marks: string;
}
function newCase(): Case {
  return { out: tmpDir('out'), prefix: prefixOf(), marks: mkMarks() };
}
const job = (c: Case, stubs: Record<string, string> | undefined, extra: { secrets?: string; env?: Record<string, string> } = {}) =>
  runJob({ out: c.out, secrets: extra.secrets ?? env.secretsDir, stubs: stubs === undefined ? undefined : makeStubs(stubs), marks: c.marks, env: { RISK_BACKUP_S3_PREFIX: c.prefix, ...extra.env } });
const events = (stdout: string): string[] => jobEvents(stdout).map((e) => e.event);
const OLD = `${env.db}-20200101T000000Z.dump.age`; // muito antigo: seria removido pela retenção SE ela rodasse

function expectNoBackup(c: Case, keep: readonly string[] = []): void {
  expect(outFiles(c.out)).toEqual([...keep].sort());
  expect(s3List(c.prefix)).toEqual([]);
}

describe('pg_dump e age falham: código 4, nenhum arquivo final/parcial, nada enviado, retenção não roda', { timeout: 300_000 }, () => {
  function seedOld(c: Case): void {
    writeFileSync(join(c.out, OLD), 'ANTIGO');
    writeFileSync(join(c.out, `${OLD}.sha256`), 'x');
  }
  const keepOld = [OLD, `${OLD}.sha256`];

  it('pg_dump sai com erro depois de emitir bytes parciais → 4; arquivo parcial não vira final; antigos intactos', () => {
    const c = newCase();
    seedOld(c);
    const r = job(c, { pg_dump: `printf 'PGDMPparcial-zz9'; touch /marks/pg_dump_called; exit 1` });
    expect(r.code, r.stdout).toBe(4);
    expect(events(r.stdout)).toEqual(['guard_ok', 'dump_failed']);
    expect(existsSync(join(c.marks, 'pg_dump_called'))).toBe(true);
    expectNoBackup(c, keepOld);
    expect(readFileSync(join(c.out, OLD), 'utf8')).toBe('ANTIGO');
  });

  it('pg_dump emite vários MB e depois morre (código 137 / SIGPIPE 141) → 4 sem final nem .partial', () => {
    for (const code of ['137', '141', '2']) {
      const c = newCase();
      const r = job(c, { pg_dump: `head -c 3000000 /dev/urandom; exit ${code}` });
      expect(r.code, code).toBe(4);
      expectNoBackup(c);
    }
  });

  it('age falha (sai 1) deixando bytes parciais no destino → 4; parcial removido; nada enviado', () => {
    const c = newCase();
    const r = job(c, { age: `${AGE_PARSE_OUT}\ncat >/dev/null\nprintf 'age-encryption.org/v1\\nparcial' > "$out"\nexit 1` });
    expect(r.code, r.stdout).toBe(4);
    expect(events(r.stdout)).toEqual(['guard_ok', 'dump_failed']);
    expectNoBackup(c);
  });

  it('age sai 0 mas escreve sem o cabeçalho age → 4 (dump_invalid_output); nada publicado', () => {
    const c = newCase();
    const r = job(c, { age: `${AGE_PARSE_OUT}\ncat >/dev/null\nprintf 'PGDMP-EM-CLARO-zz9' > "$out"\nexit 0` });
    expect(r.code, r.stdout).toBe(4);
    expect(events(r.stdout)).toEqual(['guard_ok', 'dump_invalid_output']);
    expectNoBackup(c);
  });

  it('age sai 0 e deixa arquivo vazio → 4', () => {
    const c = newCase();
    const r = job(c, { age: `${AGE_PARSE_OUT}\ncat >/dev/null\n: > "$out"\nexit 0` });
    expect(r.code).toBe(4);
    expectNoBackup(c);
  });

  it('age ausente do PATH da execução (stub que não existe → "command not found") não gera arquivo', () => {
    const c = newCase();
    const r = job(c, { age: 'exit 127' });
    expect(r.code).toBe(4);
    expectNoBackup(c);
  });

  it('recipient aceito pela regex mas inválido para o age real → 4 sem arquivo (nunca grava em claro)', () => {
    const c = newCase();
    const secrets = makeSecrets({ age_recipients: 'age1qqqqqqqqqqqqqqqq\n' });
    const r = job(c, undefined, { secrets });
    expect(r.code, r.stdout).toBe(4);
    expectNoBackup(c);
  });

  it('o stub de pg_dump que ignora o banco e imprime texto SQL em claro não vaza para o disco (age cifra tudo)', () => {
    const c = newCase();
    const r = job(c, { pg_dump: `printf 'CREATE TABLE segredo_zz9 (x int);\\n'` });
    expect(r.code, r.stdout).toBe(0);
    expect(outFiles(c.out)).toHaveLength(2); // o que importa: o arquivo final não contém o texto em claro (abaixo)
    for (const f of outFiles(c.out)) {
      expect(readFileSync(join(c.out, f)).includes('segredo_zz9')).toBe(false);
    }
  });
});

describe('nome final já existe: 4 antes do pg_dump, sem sobrescrever', { timeout: 300_000 }, () => {
  const stubs = { date: DATE_STUB, pg_dump: `touch /marks/pg_dump_called\n${REAL_PG_DUMP}` };

  it('.age pré-existente (conteúdo ORIGINAL) → 4; conteúdo e mtime preservados; pg_dump nunca chamado; nada enviado', () => {
    const c = newCase();
    const target = join(c.out, FIXED_NAME);
    writeFileSync(target, 'ORIGINAL', { mode: 0o600 });
    const before = statSync(target);
    const r = job(c, stubs);
    expect(r.code, r.stdout).toBe(4);
    expect(events(r.stdout)).toEqual(['guard_ok', 'final_exists']);
    expect(readFileSync(target, 'utf8')).toBe('ORIGINAL');
    expect(statSync(target).mtimeMs).toBe(before.mtimeMs);
    expect(existsSync(join(c.marks, 'pg_dump_called'))).toBe(false);
    expect(outFiles(c.out)).toEqual([FIXED_NAME]);
    expect(s3List(c.prefix)).toEqual([]);
  });

  it('só o .sha256 pré-existente → 4 sem tocar nele', () => {
    const c = newCase();
    writeFileSync(join(c.out, `${FIXED_NAME}.sha256`), 'ORIGINAL-SHA');
    const r = job(c, stubs);
    expect(r.code).toBe(4);
    expect(readFileSync(join(c.out, `${FIXED_NAME}.sha256`), 'utf8')).toBe('ORIGINAL-SHA');
    expect(outFiles(c.out)).toEqual([`${FIXED_NAME}.sha256`]);
    expect(existsSync(join(c.marks, 'pg_dump_called'))).toBe(false);
  });

  it('nome final é um diretório → 4 antes do pg_dump; symlink pendente → 4 sem seguir o link (ln não sobrescreve nem cria o alvo)', () => {
    const c = newCase();
    symlinkSync('/out/alvo-inexistente', join(c.out, FIXED_NAME));
    const r = job(c, stubs);
    expect(r.code, r.stdout).toBe(4);
    // `[[ -e ]]` segue o link pendente (falso), então o pg_dump chega a rodar; o `ln` falha e nada é publicado nem criado no alvo do link.
    expect(existsSync(join(c.out, 'alvo-inexistente'))).toBe(false);
    expect(lstatSync(join(c.out, FIXED_NAME)).isSymbolicLink()).toBe(true);
    expect(outFiles(c.out)).toEqual([FIXED_NAME]);
    expect(s3List(c.prefix)).toEqual([]);
    const c2 = newCase();
    mkdirSync(join(c2.out, FIXED_NAME));
    const r2 = job(c2, stubs);
    expect(r2.code).toBe(4);
    expect(existsSync(join(c2.marks, 'pg_dump_called'))).toBe(false);
  });

  it('controle: sem pré-existente, o mesmo stub de date produz exatamente o nome fixo e sai 0', () => {
    const c = newCase();
    const r = job(c, stubs);
    expect(r.code, r.stdout).toBe(0);
    expect(outFiles(c.out)).toEqual([FIXED_NAME, `${FIXED_NAME}.sha256`]);
    expect(existsSync(join(c.marks, 'pg_dump_called'))).toBe(true);
  });

  it('data do contêiner inválida (saída fora do formato) → 2 sem gravar nada', () => {
    const c = newCase();
    const r = job(c, { date: `if [ "$1" = "-u" ]; then echo 'lixo'; else exec /usr/bin/date "$@"; fi` });
    expect(r.code).toBe(2);
    expect(outFiles(c.out)).toEqual([]);
  });
});

describe('S3 indisponível ou recusando: 5 com a cópia local mantida', { timeout: 600_000 }, () => {
  function secretsWithRclone(conf: string): string {
    return makeSecrets({ rclone: conf });
  }
  const rcloneConf = (over: Record<string, string> = {}): string => {
    const base = readSecret('rclone.conf');
    return Object.entries(over).reduce((t, [k, v]) => t.replace(new RegExp(`^${k} = .*$`, 'm'), `${k} = ${v}`), base);
  };

  function expectLocalKept(c: Case, r: { code: number | null; stdout: string }): string {
    expect(r.code, r.stdout).toBe(5);
    const files = outFiles(c.out);
    expect(files).toHaveLength(2);
    const name = files.find((f) => f.endsWith('.dump.age')) as string;
    expect(name).toMatch(NAME_RE(env.db));
    expect(files.some((f) => f.includes('.partial'))).toBe(false);
    const body = readFileSync(join(c.out, name));
    expect(readFileSync(join(c.out, `${name}.sha256`), 'utf8')).toBe(`${sha(body)}  ${name}\n`);
    expect(body.subarray(0, 21).toString('latin1')).toBe('age-encryption.org/v1');
    expect(events(r.stdout)).toContain('local_backup_ok');
    expect(events(r.stdout)).not.toContain('backup_complete');
    return name;
  }

  it('credencial do S3 errada (secret inválido) → 5, cópia local íntegra, nada no bucket', () => {
    const c = newCase();
    const secrets = secretsWithRclone(rcloneConf({ secret_access_key: `errado-${rand(8)}` }));
    const r = job(c, undefined, { secrets });
    expectLocalKept(c, r);
    expect(events(r.stdout)).toContain('upload_failed');
    expect(s3List(c.prefix)).toEqual([]);
    expect(r.stdout + r.stderr).not.toContain(env.s3Secret);
  });

  it('chave de acesso inexistente → 5', () => {
    const c = newCase();
    const r = job(c, undefined, { secrets: secretsWithRclone(rcloneConf({ access_key_id: `naoexiste${rand(4)}` })) });
    expectLocalKept(c, r);
  });

  it('bucket inexistente → 5 e o job NÃO cria o bucket', () => {
    const c = newCase();
    const bucket = `bucket-ausente-${rand(4)}`;
    const r = job(c, undefined, { env: { RISK_BACKUP_S3_BUCKET: bucket } });
    expectLocalKept(c, r);
    const ls = rcloneRoot(['lsd', 'risk-backup:']);
    expect(ls.code).toBe(0);
    expect(ls.stdout).not.toContain(bucket);
    expect(ls.stdout).toContain(env.bucket);
  });

  // MEDIDO: com o endpoint recusando conexão o job leva ~9 min até sair 5 (sem --retries/--low-level-retries/--timeout no rclone; achado
  // reportado ao backend). Por isso o cenário "S3 parado" só roda com RISK_BACKUP_TEST_SLOW=1. DNS que não resolve é ainda mais lento.
  it.skipIf(process.env.RISK_BACKUP_TEST_SLOW !== '1')('LENTO: endpoint sem ninguém escutando (porta recusada) → 5 com cópia local, em tempo limitado', { timeout: 1_500_000 }, () => {
    const c = newCase();
    const t0 = Date.now();
    const r = runJob({ out: c.out, secrets: secretsWithRclone(rcloneConf({ endpoint: `http://${env.dbAlias}:7070` })), env: { RISK_BACKUP_S3_PREFIX: c.prefix } }, 1_400_000);
    expectLocalKept(c, r);
    expect(s3List(c.prefix)).toEqual([]);
    expect((Date.now() - t0) / 1000).toBeLessThan(120); // limite razoável de tempo de falha; hoje estoura (~540 s)
  });

  it('retenção local roda mesmo com falha de upload (U11): antigo removido e código segue 5', () => {
    const c = newCase();
    writeFileSync(join(c.out, OLD), 'ANTIGO');
    writeFileSync(join(c.out, `${OLD}.sha256`), 'x');
    const r = job(c, undefined, { secrets: secretsWithRclone(rcloneConf({ secret_access_key: 'errado-zz9-xyz' })) });
    expect(r.code).toBe(5);
    expect(outFiles(c.out)).toHaveLength(2);
    expect(existsSync(join(c.out, OLD))).toBe(false);
    expect(events(r.stdout)).toContain('retention_removed');
  });

  // BUG (reportado ao backend): `rclone copyto --immutable` NÃO impede a sobrescrita no rclone 1.60.1 (nem com nem sem --no-traverse): o objeto
  // remoto é substituído e o job sai 0. `--ignore-existing` preserva o original (a verificação de tamanho então daria 5). it.fails: quebra quando corrigido.
  it.fails('LACUNA: objeto remoto de mesmo nome NÃO é sobrescrito (5) e o conteúdo remoto original permanece', () => {
    const c = newCase();
    const stubs = { date: DATE_STUB };
    const key = `${c.prefix}/${FIXED_NAME}`;
    const put = rcloneRoot(['rcat', `risk-backup:${env.bucket}/${key}`], { input: Buffer.from('REMOTO-ORIGINAL') });
    expect(put.code, put.stderr).toBe(0);
    const r = job(c, stubs);
    expect(r.code, r.stdout).toBe(5);
    expect(s3Get(key)?.toString()).toBe('REMOTO-ORIGINAL');
    expect(outFiles(c.out)).toContain(FIXED_NAME); // local mantido
  });
});

describe('backup-prod.sh repassa os códigos do job', { timeout: 600_000 }, () => {
  it('banco esperado diferente do pgpass → 2; arquivo nenhum', () => {
    const cfg = makeConfig({ RISK_BACKUP_EXPECTED_DB: 'outro_banco_zz9_test' });
    const r = runBackupProd(cfg.file);
    expect(r.code, r.stdout).toBe(2);
    expect(outFiles(cfg.dir)).toEqual([]);
  });

  it('S3 com credencial errada → 5, cópia local mantida', () => {
    const conf = readSecret('rclone.conf').replace(/^secret_access_key = .*$/m, 'secret_access_key = errado-zz9-xyz');
    const cfg = makeConfig({}, { rclone: conf });
    const r = runBackupProd(cfg.file);
    expect(r.code, r.stdout).toBe(5);
    expect(outFiles(cfg.dir)).toHaveLength(2);
  });

  it('contêiner do job remanescente com o mesmo nome → 2 sem executar', () => {
    const name = `openclaw-risk-backup-${env.db}`;
    const created = docker(['create', '--name', name, '--label', env.jobLabel, '--label', env.label, '--label', env.genericLabel, '--entrypoint', '/bin/true', env.image]);
    expect(created.code, created.stderr).toBe(0);
    try {
      const cfg = makeConfig();
      const r = runBackupProd(cfg.file);
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/já existe/);
      expect(outFiles(cfg.dir)).toEqual([]);
    } finally {
      docker(['rm', '-f', '-v', name]);
    }
  });

  it('duas execuções simultâneas: a segunda sai 3 (flock) sem tocar o diretório; a primeira termina 0', async () => {
    const cfg = makeConfig();
    // Segura a primeira execução trancando uma tabela (pg_dump bloqueia no ACCESS SHARE).
    const admin = adminPool();
    const client = await admin.connect();
    await client.query('BEGIN');
    await client.query('LOCK TABLE risk_outbox IN ACCESS EXCLUSIVE MODE');
    const first = startBackupProd(cfg.file);
    try {
      let running = false;
      for (let i = 0; i < 100 && !running; i += 1) {
        await sleep(200);
        running = docker(['ps', '-q', '--filter', `label=${env.jobLabel}`]).stdout.trim() !== '';
      }
      expect(running).toBe(true);
      await sleep(1500); // o job já passou da trava e está bloqueado no pg_dump
      const second = runBackupProd(cfg.file);
      expect(second.code).toBe(3);
      expect(second.stderr).toMatch(/em andamento/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
      await admin.end();
    }
    const done = await first.done;
    expect(done.code, done.stdout).toBe(0);
    expect(outFiles(cfg.dir)).toHaveLength(2);
  });
});

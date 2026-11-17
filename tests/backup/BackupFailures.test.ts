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
    // o HEAD prévio já falha com a credencial inválida (fail-closed: sem HEAD não envia)
    expect(events(r.stdout)).toContain('upload_head_failed');
    expect(events(r.stdout)).not.toContain('upload_ok');
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

  // Com --contimeout/--timeout/--retries/--low-level-retries obrigatórios (valores de teste exportados por scripts/test-backup.sh) o job sai 5
  // em tempo limitado mesmo com o endpoint recusando conexão (antes, sem limites, levava ~9 min).
  it('endpoint sem ninguém escutando (porta recusada) → 5 com cópia local, em tempo limitado pelos timeouts de teste', { timeout: 300_000 }, () => {
    const c = newCase();
    const t0 = Date.now();
    const r = runJob({ out: c.out, secrets: secretsWithRclone(rcloneConf({ endpoint: `http://${env.dbAlias}:7070` })), env: { RISK_BACKUP_S3_PREFIX: c.prefix } }, 280_000);
    expectLocalKept(c, r);
    expect(s3List(c.prefix)).toEqual([]);
    expect((Date.now() - t0) / 1000).toBeLessThan(120);
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

  // Sobrescrita remota: HEAD prévio (copyto --dry-run --ignore-existing --error-on-no-transfer) + --ignore-existing no envio real.
  describe('objeto remoto pré-existente nunca é sobrescrito (5, upload_target_exists, local mantido)', () => {
    const DUMP_BYTES = 'head -c 20000 /dev/zero'; // saída determinística: o tamanho do .age cifrado é estável entre execuções
    const stubs = { date: DATE_STUB, pg_dump: DUMP_BYTES };
    const put = (key: string, body: string): void => {
      const r = rcloneRoot(['rcat', `risk-backup:${env.bucket}/${key}`], { input: Buffer.from(body) });
      expect(r.code, r.stderr).toBe(0);
    };
    /** Tamanho local do .age (e do .sha256) que este stub produz: roda o job num prefixo descartável. */
    function sizes(): { age: number; sha: number } {
      const c = newCase();
      const r = job(c, stubs);
      expect(r.code, r.stdout).toBe(0);
      return { age: statSync(join(c.out, FIXED_NAME)).size, sha: statSync(join(c.out, `${FIXED_NAME}.sha256`)).size };
    }
    const fileEvents = (stdout: string) => jobEvents(stdout).map((e) => `${e.event}:${e.file}`);

    it('.age remoto de tamanho DIFERENTE → 5; conteúdo remoto original preservado; cópia local mantida; .sha256 enviado', () => {
      const c = newCase();
      const key = `${c.prefix}/${FIXED_NAME}`;
      put(key, 'REMOTO-ORIGINAL');
      const r = job(c, { date: DATE_STUB });
      expect(r.code, r.stdout).toBe(5);
      expect(fileEvents(r.stdout)).toContain(`upload_target_exists:${FIXED_NAME}`);
      expect(events(r.stdout)).not.toContain('backup_complete');
      expect(s3Get(key)?.toString()).toBe('REMOTO-ORIGINAL');
      expect(outFiles(c.out)).toEqual([FIXED_NAME, `${FIXED_NAME}.sha256`]); // local mantido
      expect(s3List(c.prefix).map((o) => o.Path).sort()).toEqual([FIXED_NAME, `${FIXED_NAME}.sha256`]);
    });

    it('.age remoto com o MESMO tamanho do local → ainda 5/upload_target_exists e conteúdo remoto preservado (não depende da checagem de tamanho)', () => {
      const { age } = sizes();
      const c = newCase();
      const key = `${c.prefix}/${FIXED_NAME}`;
      const original = 'R'.repeat(age);
      put(key, original);
      const r = job(c, stubs);
      expect(r.code, r.stdout).toBe(5);
      expect(fileEvents(r.stdout)).toContain(`upload_target_exists:${FIXED_NAME}`);
      expect(events(r.stdout)).not.toContain('upload_verify_failed');
      expect(s3Get(key)?.toString()).toBe(original);
      expect(statSync(join(c.out, FIXED_NAME)).size).toBe(age);
      expect(readFileSync(join(c.out, FIXED_NAME)).subarray(0, 21).toString('latin1')).toBe('age-encryption.org/v1');
    });

    it('.sha256 remoto pré-existente também é protegido (mesmo tamanho): 5, conteúdo preservado, .age (inexistente) é enviado', () => {
      const { sha } = sizes();
      const c = newCase();
      const key = `${c.prefix}/${FIXED_NAME}.sha256`;
      const original = 'S'.repeat(sha);
      put(key, original);
      const r = job(c, stubs);
      expect(r.code, r.stdout).toBe(5);
      expect(fileEvents(r.stdout)).toContain(`upload_target_exists:${FIXED_NAME}.sha256`);
      expect(fileEvents(r.stdout)).toContain(`upload_ok:${FIXED_NAME}`);
      expect(s3Get(key)?.toString()).toBe(original);
      expect(outFiles(c.out)).toEqual([FIXED_NAME, `${FIXED_NAME}.sha256`]);
    });

    it('.sha256 remoto de tamanho diferente também é preservado', () => {
      const c = newCase();
      const key = `${c.prefix}/${FIXED_NAME}.sha256`;
      put(key, 'x');
      const r = job(c, stubs);
      expect(r.code, r.stdout).toBe(5);
      expect(s3Get(key)?.toString()).toBe('x');
    });

    it('ambos pré-existentes → 5, dois eventos upload_target_exists, nenhum upload_ok, nada alterado', () => {
      const c = newCase();
      put(`${c.prefix}/${FIXED_NAME}`, 'A1');
      put(`${c.prefix}/${FIXED_NAME}.sha256`, 'B1');
      const r = job(c, stubs);
      expect(r.code, r.stdout).toBe(5);
      expect(events(r.stdout).filter((e) => e === 'upload_target_exists')).toHaveLength(2);
      expect(events(r.stdout)).not.toContain('upload_ok');
      expect(s3Get(`${c.prefix}/${FIXED_NAME}`)?.toString()).toBe('A1');
      expect(s3Get(`${c.prefix}/${FIXED_NAME}.sha256`)?.toString()).toBe('B1');
      expect(outFiles(c.out)).toHaveLength(2);
    });

    // Segunda barreira (T2): o objeto surge DEPOIS do probe. O stub faz o probe (--dry-run) responder "não existe" (0) e delega o resto ao
    // rclone real; o envio real usa --ignore-existing + --error-on-no-transfer, então o objeto pré-existente não é sobrescrito nem conta como upload_ok.
    it('objeto criado após o probe (mesmo tamanho) não é sobrescrito e NÃO conta como upload_ok', () => {
      const { age } = sizes();
      const c = newCase();
      const key = `${c.prefix}/${FIXED_NAME}`;
      const original = 'R'.repeat(age);
      put(key, original);
      const r = job(c, { ...stubs, rclone: 'for a in "$@"; do [ "$a" = "--dry-run" ] && exit 0; done\nexec /usr/bin/rclone "$@"' });
      expect(s3Get(key)?.toString()).toBe(original);
      expect(fileEvents(r.stdout)).not.toContain(`upload_ok:${FIXED_NAME}`);
      expect(r.code, r.stdout).toBe(5);
    });

    it('controle: sem objeto remoto o mesmo cenário sai 0 e envia os dois', () => {
      const c = newCase();
      const r = job(c, stubs);
      expect(r.code, r.stdout).toBe(0);
      expect(s3List(c.prefix).map((o) => o.Path).sort()).toEqual([FIXED_NAME, `${FIXED_NAME}.sha256`]);
    });
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

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { NAME_RE, ageDecrypt, bkEnv, docker, jobEvents, makeConfig, outFiles, pgRestoreList, runBackupProd, s3Get, s3List, type Cfg, type Run } from './support.js';

// T3: backup REAL (scripts/backup-prod.sh -> contêiner da imagem -> pg_dump | age -> /out + S3 de teste). Fixtures fictícias.
const env = bkEnv();

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

describe('backup real ponta a ponta', { timeout: 300_000 }, () => {
  let cfg: Cfg;
  let result: Run;
  let name: string;
  beforeAll(() => {
    cfg = makeConfig();
    result = runBackupProd(cfg.file);
  }, 300_000);

  it('sai 0 e o diretório de saída contém só <banco>-<UTC>.dump.age, .sha256 (e .lock); nenhum .partial', () => {
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    const files = outFiles(cfg.dir);
    expect(files).toHaveLength(2);
    name = files.find((f) => f.endsWith('.dump.age')) as string;
    expect(name).toMatch(NAME_RE(env.db));
    expect(files).toContain(`${name}.sha256`);
    expect(files.some((f) => f.includes('.partial'))).toBe(false);
    expect(files.every((f) => !f.startsWith('.') || f === '.lock')).toBe(true);
    // O diretório contém exatamente: .lock + os dois arquivos finais.
    expect(new Set(['.lock', ...files]).size).toBe(3);
  });

  it('arquivos 0600 (umask 077), do uid do operador; diretório segue 0700', () => {
    for (const f of [name, `${name}.sha256`]) {
      const st = statSync(join(cfg.dir, f));
      expect(st.mode & 0o777).toBe(0o600);
      expect(st.uid).toBe(process.getuid?.());
      expect(st.size).toBeGreaterThan(0);
    }
    expect(statSync(cfg.dir).mode & 0o777).toBe(0o700);
  });

  it('.sha256 = "<hash>  <nome>\\n" e confere com o arquivo cifrado', () => {
    const body = readFileSync(join(cfg.dir, name));
    const sha = readFileSync(join(cfg.dir, `${name}.sha256`), 'utf8');
    expect(sha).toBe(`${sha256(body)}  ${name}\n`);
  });

  it('cabeçalho age; o arquivo é decifrável com a identidade de teste e NÃO com a errada', () => {
    const body = readFileSync(join(cfg.dir, name));
    expect(body.subarray(0, 21).toString('latin1')).toBe('age-encryption.org/v1');
    const plain = ageDecrypt(join(cfg.dir, name), env.identityFile);
    expect(plain).not.toBeNull();
    expect((plain as Buffer).subarray(0, 5).toString('latin1')).toBe('PGDMP');
    expect(ageDecrypt(join(cfg.dir, name), env.identityWrongFile)).toBeNull();
  });

  it('o dump decifrado é um custom válido (pg_restore -l) com as tabelas, e o conteúdo de auditoria', () => {
    const plain = ageDecrypt(join(cfg.dir, name), env.identityFile) as Buffer;
    const list = pgRestoreList(plain);
    expect(list.code, list.stderr).toBe(0);
    for (const t of ['risk_decisions', 'risk_reservations', 'risk_audit_events', 'risk_operational_state', 'schema_migrations']) {
      expect(list.stdout, t).toContain(t);
    }
    expect(list.stdout).toMatch(/TABLE DATA public risk_audit_events/);
  });

  it('o arquivo cifrado em disco não deixa nenhum rastro em claro (sem PGDMP, sem nomes de tabela nem SQL)', () => {
    const body = readFileSync(join(cfg.dir, name));
    expect(body.includes('PGDMP')).toBe(false);
    expect(body.includes('risk_decisions')).toBe(false);
    expect(body.includes('CREATE TABLE')).toBe(false);
  });

  it('S3: .age e .sha256 enviados com o mesmo nome e tamanho; conteúdo idêntico ao local; sem PGDMP em claro', () => {
    const objs = s3List(cfg.prefix);
    const byPath = new Map(objs.map((o) => [o.Path, o.Size]));
    expect([...byPath.keys()].sort()).toEqual([name, `${name}.sha256`].sort());
    for (const f of [name, `${name}.sha256`]) {
      const local = readFileSync(join(cfg.dir, f));
      expect(byPath.get(f)).toBe(local.length);
      const remote = s3Get(`${cfg.prefix}/${f}`);
      expect(remote).not.toBeNull();
      expect(sha256(remote as Buffer)).toBe(sha256(local));
    }
    const remoteAge = s3Get(`${cfg.prefix}/${name}`) as Buffer;
    expect(remoteAge.includes('PGDMP')).toBe(false);
  });

  it('logs do job: uma linha JSON por etapa, na ordem, sem segredo; backup-prod.sh repassa o código 0', () => {
    const ev = jobEvents(result.stdout);
    expect(ev.map((e) => e.event)).toEqual(['guard_ok', 'local_backup_ok', 'upload_ok', 'upload_ok', 'backup_complete']);
    for (const e of ev) {
      expect(Object.keys(e).sort()).toEqual(['bytes', 'event', 'exitCode', 'file']);
      expect(e.exitCode).toBe(0);
    }
    const ok = ev.find((e) => e.event === 'local_backup_ok');
    expect(ok?.file).toBe(name);
    expect(ok?.bytes).toBe(statSync(join(cfg.dir, name)).size);
    for (const s of [env.backupPassword, env.s3Secret, env.s3Access, env.recipient]) {
      expect(result.stdout).not.toContain(s);
      expect(result.stderr).not.toContain(s);
    }
  });

  it('nenhum contêiner do job sobrou (trap + --rm)', () => {
    const r = docker(['ps', '-a', '-q', '--filter', `label=${env.jobLabel}`]);
    expect(r.stdout.trim()).toBe('');
  });
});

import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bkEnv, jobEvents, makeStubs, mkMarks, outFiles, rand, rcloneRoot, runJob, s3List, tmpDir } from './support.js';

// T5: retenção local de 7 dias (ADR-0012), com o relógio do contêiner CONGELADO por um stub de `date` (fronteiras exatas, sem flakiness).
// A retenção só apaga <banco>-<UTC>.dump.age (+ .sha256) mais antigos que agora − 7×24 h, só em /out, só arquivos regulares.
const env = bkEnv();
const NOW_MS = Date.UTC(2026, 10, 16, 12, 0, 0); // 2026-11-16T12:00:00Z (fictício)
const NOW_TS = '20261116T120000Z';
const CUTOFF_MS = NOW_MS - 7 * 86_400_000;

const ts = (ms: number): string => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const age = (ms: number, db = env.db): string => `${db}-${ts(ms)}.dump.age`;

const dateStub = (nowMs = NOW_MS, tsNow = NOW_TS): string =>
  `case "$*" in
  "-u +%Y%m%dT%H%M%SZ") echo ${tsNow} ;;
  "-u +%s") echo ${Math.floor(nowMs / 1000)} ;;
  *) exec /usr/bin/date "$@" ;;
esac`;

function seed(out: string, name: string, withSha = true): void {
  writeFileSync(join(out, name), `FICTICIO ${name}`);
  if (withSha) writeFileSync(join(out, `${name}.sha256`), `0  ${name}\n`);
}

describe('retenção local', { timeout: 300_000 }, () => {
  it('apaga só os antigos do padrão e do banco; fronteira exata (== corte) é preservada; arquivos de fora do padrão ficam', () => {
    const out = tmpDir('out');
    const marks = mkMarks();
    const prefix = `${env.prefix}/${rand(4)}`;
    const removed = [age(Date.UTC(2026, 10, 1)), age(CUTOFF_MS - 1000), age(Date.UTC(2020, 0, 1))];
    const kept = [age(CUTOFF_MS), age(CUTOFF_MS + 1000), age(Date.UTC(2026, 10, 15)), age(Date.UTC(2027, 0, 1)), age(NOW_MS - 1000), age(Date.UTC(2020, 0, 1), 'outro_banco'), age(Date.UTC(2020, 0, 1), `${env.db}x`)];
    for (const n of [...removed, ...kept]) seed(out, n);
    // Antigo sem .sha256: o .age sai do mesmo jeito (rm -f dos dois nomes).
    const noSha = age(Date.UTC(2019, 5, 5));
    seed(out, noSha, false);
    removed.push(noSha);
    // Fora do padrão: nunca removidos.
    const others = [
      `${age(Date.UTC(2020, 0, 1))}.bak`,
      `${env.db}-20200101T000000Z.dump`,
      `${env.db}-2020010T000000Z.dump.age`, // dígitos a menos
      `${env.db}-20200101t000000z.dump.age`, // minúsculas
      `${env.db}-20200101T000000Z.DUMP.AGE`,
      `${age(Date.UTC(2020, 0, 2))}.sha256`, // .sha256 órfão (sem .age)
      'notas.txt',
      `.${age(Date.UTC(2020, 0, 1))}.partial.99999`, // parcial órfão: só aviso
      `x${age(Date.UTC(2020, 0, 1))}`,
    ];
    for (const n of others) writeFileSync(join(out, n), 'x');
    // Symlink para fora de /out e para dentro; diretório com o nome do padrão.
    writeFileSync(join(marks, 'vitima'), 'ALVO-FORA-DE-OUT');
    symlinkSync('/marks/vitima', join(out, age(Date.UTC(2020, 0, 3))));
    symlinkSync('notas.txt', join(out, age(Date.UTC(2020, 0, 4))));
    mkdirSync(join(out, age(Date.UTC(2020, 0, 5))));
    writeFileSync(join(out, age(Date.UTC(2020, 0, 5)), 'dentro.txt'), 'DENTRO-DE-DIR');

    const r = runJob({ out, secrets: env.secretsDir, stubs: makeStubs({ date: dateStub() }), marks, env: { RISK_BACKUP_S3_PREFIX: prefix } });
    expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0);

    const ev = jobEvents(r.stdout);
    expect(ev.filter((e) => e.event === 'retention_removed').map((e) => e.file).sort()).toEqual([...removed].sort());
    expect(ev.some((e) => e.event === 'retention_failed')).toBe(false);
    expect(ev.find((e) => e.event === 'partial_orphans_found')?.bytes).toBe(1);

    const left = new Set(readdirSync(out));
    for (const n of removed) {
      expect(left.has(n), `${n} deveria ter sido removido`).toBe(false);
      expect(left.has(`${n}.sha256`), `${n}.sha256`).toBe(false);
    }
    for (const n of kept) {
      expect(left.has(n), `${n} deveria ter sido preservado`).toBe(true);
      expect(left.has(`${n}.sha256`), `${n}.sha256`).toBe(true);
    }
    for (const n of others) expect(left.has(n), n).toBe(true);
    expect(left.has(age(Date.UTC(2020, 0, 3)))).toBe(true);
    expect(left.has(age(Date.UTC(2020, 0, 4)))).toBe(true);
    expect(readFileSync(join(marks, 'vitima'), 'utf8')).toBe('ALVO-FORA-DE-OUT');
    expect(readFileSync(join(out, age(Date.UTC(2020, 0, 5)), 'dentro.txt'), 'utf8')).toBe('DENTRO-DE-DIR');
    // O backup novo existe e está íntegro.
    const fresh = `${env.db}-${NOW_TS}.dump.age`;
    expect(left.has(fresh) && left.has(`${fresh}.sha256`)).toBe(true);
  });

  it('o arquivo recém-criado nunca é removido, mesmo com relógio inconsistente (nome "velho" frente ao epoch)', () => {
    const out = tmpDir('out');
    // `date +%s` 30 dias à frente do timestamp do nome: o novo arquivo parece mais antigo que o corte.
    const r = runJob({ out, secrets: env.secretsDir, stubs: makeStubs({ date: dateStub(NOW_MS + 30 * 86_400_000) }) });
    expect(r.code, r.stdout).toBe(0);
    expect(outFiles(out)).toEqual([`${env.db}-${NOW_TS}.dump.age`, `${env.db}-${NOW_TS}.dump.age.sha256`]);
    expect(jobEvents(r.stdout).some((e) => e.event === 'retention_removed')).toBe(false);
  });

  it('nome com data impossível dentro do padrão (mês 13) → 6, arquivo preservado, backup e upload concluídos', () => {
    const out = tmpDir('out');
    const prefix = `${env.prefix}/${rand(4)}`;
    const bad = `${env.db}-20261399T250000Z.dump.age`;
    seed(out, bad);
    const r = runJob({ out, secrets: env.secretsDir, stubs: makeStubs({ date: dateStub() }), env: { RISK_BACKUP_S3_PREFIX: prefix } });
    expect(r.code, r.stdout).toBe(6);
    expect(existsSync(join(out, bad))).toBe(true);
    expect(existsSync(join(out, `${env.db}-${NOW_TS}.dump.age`))).toBe(true);
    expect(s3List(prefix)).toHaveLength(2); // upload feito apesar da falha na retenção
    expect(jobEvents(r.stdout).some((e) => e.event === 'backup_complete')).toBe(false);
  });

  it('falha ao remover (rm falha para um alvo) → 6; backup novo íntegro e enviado; os demais antigos removidos', () => {
    const out = tmpDir('out');
    const prefix = `${env.prefix}/${rand(4)}`;
    const stuck = age(Date.UTC(2020, 1, 1));
    const gone = age(Date.UTC(2020, 1, 2));
    seed(out, stuck);
    seed(out, gone);
    const rmStub = `for a in "$@"; do case "$a" in *${ts(Date.UTC(2020, 1, 1))}*) exit 1 ;; esac; done\nexec /usr/bin/rm "$@"`;
    const r = runJob({ out, secrets: env.secretsDir, stubs: makeStubs({ date: dateStub(), rm: rmStub }), env: { RISK_BACKUP_S3_PREFIX: prefix } });
    expect(r.code, r.stdout).toBe(6);
    const ev = jobEvents(r.stdout);
    expect(ev.find((e) => e.event === 'retention_failed')?.file).toBe(stuck);
    expect(existsSync(join(out, stuck))).toBe(true);
    expect(existsSync(join(out, gone))).toBe(false);
    expect(s3List(prefix)).toHaveLength(2);
  });

  it('retenção local não toca o bucket: objeto antigo no S3 continua lá (retenção remota é ciclo de vida do provedor)', () => {
    const out = tmpDir('out');
    const prefix = `${env.prefix}/${rand(4)}`;
    const oldName = age(Date.UTC(2020, 0, 1));
    const put = rcloneRoot(['rcat', `risk-backup:${env.bucket}/${prefix}/${oldName}`], { input: Buffer.from('REMOTO-ANTIGO') });
    expect(put.code, put.stderr).toBe(0);
    seed(out, oldName);
    const r = runJob({ out, secrets: env.secretsDir, stubs: makeStubs({ date: dateStub() }), env: { RISK_BACKUP_S3_PREFIX: prefix } });
    expect(r.code, r.stdout).toBe(0);
    expect(existsSync(join(out, oldName))).toBe(false); // local removido
    const remote = s3List(prefix).map((o) => o.Path).sort();
    expect(remote).toEqual([oldName, `${env.db}-${NOW_TS}.dump.age`, `${env.db}-${NOW_TS}.dump.age.sha256`].sort());
  });

  it('com backup falho (4) a retenção não roda: nada é apagado', () => {
    const out = tmpDir('out');
    const old = age(Date.UTC(2020, 0, 1));
    seed(out, old);
    const r = runJob({ out, secrets: env.secretsDir, stubs: makeStubs({ date: dateStub(), pg_dump: 'exit 1' }) });
    expect(r.code).toBe(4);
    expect(outFiles(out).sort()).toEqual([old, `${old}.sha256`].sort());
  });
});

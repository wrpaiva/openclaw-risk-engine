import { execFile } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { adminPool, bkEnv, docker, makeConfig, makeSecrets, makeStubs, mkMarks, outFiles, readSecret, runJob, sleep, startBackupProd, tmpDir, type Run } from './support.js';

// T6: os segredos (senha do banco, secret do S3, chave de acesso do S3) nunca aparecem em ps do host, docker inspect/top/exec do job,
// argv/env das ferramentas, stdout/stderr nem arquivos de saída. A janela de observação é determinística: uma tabela é trancada
// (ACCESS EXCLUSIVE) para o pg_dump ficar bloqueado enquanto o contêiner do job vive. Fixtures fictícias.
const env = bkEnv();
const S3_SECRET = env.s3Secret;
const S3_ACCESS = env.s3Access;
const DB_PASSWORD = env.backupPassword;
const SECRET_VALUES = [DB_PASSWORD, S3_SECRET, S3_ACCESS];

let admin: pg.Pool;
beforeAll(() => {
  admin = adminPool();
});
afterAll(async () => {
  await admin.end();
});

const execAsync = (cmd: string, args: readonly string[]): Promise<string> =>
  new Promise((resolve) => {
    execFile(cmd, [...args], { maxBuffer: 32 * 1024 * 1024, timeout: 15_000 }, (_e, stdout) => {
      resolve(stdout);
    });
  });

function expectNoSecrets(text: string, where: string): void {
  for (const s of SECRET_VALUES) expect(text.includes(s), `${where} vaza um segredo`).toBe(false);
}

describe('segredos fora de ps, docker inspect/top/exec e logs (backup-prod.sh real)', { timeout: 300_000 }, () => {
  it('durante o job: ps do host, /proc/<pid>/environ do backup-prod.sh, docker inspect, docker top e o ambiente dos processos do contêiner', async () => {
    const cfg = makeConfig();
    const name = `openclaw-risk-backup-${env.db}`;
    const snapshots: { ps: string[]; inspect: string[]; top: string[]; environ: string[]; hostEnviron: string[] } = { ps: [], inspect: [], top: [], environ: [], hostEnviron: [] };
    const client = await admin.connect();
    await client.query('BEGIN');
    await client.query('LOCK TABLE risk_outbox IN ACCESS EXCLUSIVE MODE');
    const job = startBackupProd(cfg.file);
    const state = { finished: false };
    let result: Run | undefined;
    void job.done.then((r) => {
      state.finished = true;
      result = r;
    });
    // Polling contínuo do host durante toda a execução.
    const poller = (async () => {
      while (!state.finished) {
        snapshots.ps.push(await execAsync('ps', ['-eo', 'args']));
        const pids = (await execAsync('pgrep', ['-f', 'scripts/backup-prod.sh'])).split('\n').filter(Boolean);
        for (const pid of pids) {
          try {
            snapshots.hostEnviron.push(readFileSync(`/proc/${pid}/environ`).toString('latin1'));
          } catch {
            /* processo terminou */
          }
        }
        await sleep(25);
      }
    })();
    try {
      // Espera o pg_dump bloqueado pelo lock (login de backup esperando).
      let blocked = false;
      for (let i = 0; i < 150 && !blocked; i += 1) {
        await sleep(200);
        const q = await admin.query(`SELECT count(*)::int n FROM pg_stat_activity WHERE usename = $1 AND wait_event_type = 'Lock'`, [env.backupLogin]);
        blocked = (q.rows[0] as { n: number }).n > 0;
      }
      expect(blocked, 'pg_dump deveria estar bloqueado esperando o lock').toBe(true);
      for (let i = 0; i < 4; i += 1) {
        snapshots.inspect.push(docker(['inspect', name]).stdout);
        snapshots.top.push(docker(['top', name, '-eo', 'pid,args']).stdout);
        snapshots.environ.push(docker(['exec', name, 'bash', '-c', 'for p in /proc/[0-9]*; do tr "\\0" "\\n" < $p/environ 2>/dev/null; echo "--cmdline:"; tr "\\0" " " < $p/cmdline 2>/dev/null; echo; done']).stdout);
        await sleep(150);
      }
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    await job.done;
    await poller;
    expect(result?.code, `${result?.stdout}\n${result?.stderr}`).toBe(0);

    // Observou de fato o job (não é um teste vazio).
    expect(snapshots.inspect[0]).toContain(name);
    expect(snapshots.top.join('\n')).toMatch(/pg_dump/);
    expect(snapshots.top.join('\n')).toMatch(/age -R \/run\/secrets\/age_recipients -o \/out\/\./);
    expect(snapshots.ps.join('\n')).toContain('backup-prod.sh');
    expect(snapshots.environ.join('\n')).toContain('PGPASSFILE=/run/secrets/pgpass');

    expectNoSecrets(snapshots.ps.join('\n'), 'ps do host');
    expectNoSecrets(snapshots.hostEnviron.join('\n'), '/proc/<pid>/environ do backup-prod.sh');
    expectNoSecrets(snapshots.inspect.join('\n'), 'docker inspect');
    expectNoSecrets(snapshots.top.join('\n'), 'docker top');
    expectNoSecrets(snapshots.environ.join('\n'), 'env/cmdline dos processos do contêiner');
    expectNoSecrets(`${result?.stdout}\n${result?.stderr}`, 'stdout/stderr de backup-prod.sh');

    // docker inspect: ambiente só com as 3 variáveis não secretas; sem segredo em Cmd/Args; endurecimento efetivo.
    interface Inspect {
      Config: { Env: string[]; Cmd: string[] | null; Labels: Record<string, string>; User: string };
      Path: string;
      Args: string[] | null;
      HostConfig: { ReadonlyRootfs: boolean; Privileged: boolean; CapDrop: string[]; CapAdd: string[] | null; SecurityOpt: string[]; Tmpfs: unknown; NetworkMode: string };
      Mounts: { Destination: string; RW: boolean; Type: string }[];
    }
    const info = (JSON.parse(snapshots.inspect[0] as string) as Inspect[])[0] as Inspect;
    const vars = info.Config.Env;
    expect(vars.filter((v) => v.startsWith('RISK_BACKUP_')).map((v) => v.split('=')[0]).sort()).toEqual(['RISK_BACKUP_EXPECTED_DB', 'RISK_BACKUP_S3_BUCKET', 'RISK_BACKUP_S3_PREFIX']);
    for (const v of vars) expect(v).not.toMatch(/PASS|SECRET|TOKEN|AWS_|PGPASSWORD|RCLONE_/i);
    expect(info.Config.Cmd ?? []).toEqual([]);
    expect(info.Path).toBe('/usr/local/bin/backup-job.sh');
    expect(info.Args ?? []).toEqual([]);
    expect(info.HostConfig.ReadonlyRootfs).toBe(true);
    expect(info.HostConfig.Privileged).toBe(false);
    expect(info.HostConfig.CapDrop).toEqual(['ALL']);
    expect(info.HostConfig.CapAdd ?? null).toBeNull();
    expect(info.HostConfig.SecurityOpt).toContain('no-new-privileges');
    expect(info.HostConfig.Tmpfs ?? null).toBeNull();
    expect(info.HostConfig.NetworkMode).toBe(env.network);
    expect(info.Config.Labels['com.openclaw-risk-engine.backup']).toBe(env.db);
    const mounts = info.Mounts.filter((m) => m.Type === 'bind');
    expect(mounts.map((m) => `${m.Destination}:${m.RW}`).sort()).toEqual(['/out:true', '/run/secrets:false']);
    expect(info.Config.User).toMatch(/^\d+:\d+$/);
    expect(info.Config.User).not.toBe('0:0');
    // Nenhum socket do Docker nem diretório sensível montado.
    expect(JSON.stringify(info.Mounts)).not.toMatch(/docker\.sock|\/etc|\/root|\/home/);
    expect(outFiles(cfg.dir)).toHaveLength(2);
  });

  it('argv e ambiente de CADA ferramenta (psql, pg_dump, age, rclone) registrados por stubs: sem senha, sem secret/chave do S3', () => {
    const marks = mkMarks();
    const rec = (tool: string, real: string): string =>
      `{ echo "ARGV: $*"; env | sort | sed 's/^/ENV: /'; } >> /marks/${tool}.log\nexec ${real} "$@"`;
    const stubs = makeStubs({
      psql: rec('psql', '/usr/lib/postgresql/14/bin/psql'),
      pg_dump: rec('pg_dump', '/usr/lib/postgresql/14/bin/pg_dump'),
      age: rec('age', '/usr/bin/age'),
      rclone: rec('rclone', '/usr/bin/rclone'),
    });
    const out = tmpDir('out');
    const r = runJob({ out, secrets: env.secretsDir, stubs, marks });
    expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0);
    const logs = readdirSync(marks).filter((f) => f.endsWith('.log'));
    expect(logs.sort()).toEqual(['age.log', 'pg_dump.log', 'psql.log', 'rclone.log']);
    for (const f of logs) {
      const text = readFileSync(join(marks, f), 'utf8');
      expect(text).toContain('ARGV:');
      expectNoSecrets(text, f);
      // A senha viaja só pelo arquivo PGPASSFILE; o ambiente nunca tem PGPASSWORD nem variáveis de credencial do rclone/AWS.
      expect(text).not.toMatch(/ENV: (PGPASSWORD|AWS_[A-Z_]*|RCLONE_[A-Z_]*|PGSERVICE|DATABASE_URL)=/);
      expect(text).not.toMatch(/postgres(ql)?:\/\/[^\s]*@/);
      expect(text).not.toMatch(/AGE-SECRET-KEY-/);
    }
    const psql = readFileSync(join(marks, 'psql.log'), 'utf8');
    expect(psql).toMatch(/ARGV: .*-w .*-h \S+ -p 5432 -U /);
    expect(psql).toContain('ENV: PGPASSFILE=/run/secrets/pgpass');
    const dump = readFileSync(join(marks, 'pg_dump.log'), 'utf8');
    expect(dump).toMatch(/ARGV: --format=custom --no-owner --no-password /);
    expect(dump).not.toMatch(/ARGV:.*(--file|-f |--dbname=)/);
    const rclone = readFileSync(join(marks, 'rclone.log'), 'utf8');
    expect(rclone).toMatch(/ARGV: copyto --config \/run\/secrets\/rclone\.conf /);
    expect(rclone).not.toContain(readSecret('rclone.conf').split('\n').find((l) => l.startsWith('secret_access_key'))?.split(' = ')[1] ?? 'x-nunca');
    // pg_dump e age rodaram como UM pipe: o stdout do job e os arquivos finais não contêm segredos.
    expectNoSecrets(`${r.stdout}\n${r.stderr}`, 'stdout/stderr do job');
    for (const f of outFiles(out)) expectNoSecrets(readFileSync(join(out, f)).toString('latin1'), `/out/${f}`);
  });

  it('falhas também não vazam: senha do banco errada, S3 com credencial errada, pg_dump falhando — stdout/stderr sem os valores usados', () => {
    const wrongPw = 'senha-errada-zz9-visivel-se-vazar';
    const wrongKey = 'chave-s3-errada-zz9-visivel-se-vazar';
    const pgpass = readSecret('pgpass').trim().split(':');
    pgpass[4] = wrongPw;
    const rclone = readSecret('rclone.conf').replace(/^secret_access_key = .*$/m, `secret_access_key = ${wrongKey}`);
    const a = runJob({ out: tmpDir('out'), secrets: makeSecrets({ pgpass: `${pgpass.join(':')}\n` }) });
    const b = runJob({ out: tmpDir('out'), secrets: makeSecrets({ rclone }) });
    const c = runJob({ out: tmpDir('out'), secrets: env.secretsDir, stubs: makeStubs({ pg_dump: `echo "falha com ${DB_PASSWORD}" >&2; exit 1` }) });
    for (const [r, extra] of [[a, [wrongPw]], [b, [wrongKey]], [c, []]] as const) {
      expect(r.code).not.toBe(0);
      expectNoSecrets(`${r.stdout}\n${r.stderr}`, 'saída de falha');
      for (const s of extra) expect(`${r.stdout}\n${r.stderr}`).not.toContain(s);
    }
  });
});

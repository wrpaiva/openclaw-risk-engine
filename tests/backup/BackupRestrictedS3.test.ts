import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NAME_RE, bkEnv, docker, jobEvents, labelArgs, makeSecrets, makeStubs, mkMarks, outFiles, rand, runJob, sleep, tmpDir, type Run } from './support.js';

// T8: credencial S3 RESTRITA. Um segundo gateway versitygw (mesma imagem por digest, IAM interno + sidecar para guardar políticas) é criado só
// para este arquivo. O usuário de envio só tem s3:PutObject e s3:GetObject (HEAD) no prefixo: SEM ListBucket e SEM DeleteObject.
// Prova se o job (copyto --no-traverse --immutable + `rclone lsjson <objeto>` de verificação) funciona sem permissão de listar/apagar
// e quais operações S3 ele realmente emite. Chaves e bucket FICTÍCIOS, só desta execução.
const env = bkEnv();
const ROOT_AK = `root${rand(6)}`;
const ROOT_SK = `rootsecret${rand(10)}`;
const USER_AK = `limited${rand(6)}`;
const USER_SK = `limitedsecret${rand(10)}`;
const GW = `openclaw-risk-backup-test-s3r-${rand(3)}`;
const ALIAS = `${env.s3Alias}-r`;
const BUCKET = `restricted-${rand(4)}`;
const KEY_PREFIX = 'restrito';

let port = 0;
let rootSecrets: string; // diretório com rclone.conf raiz do gateway restrito
let userConf: string;

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => {
        resolve(p);
      });
    });
  });

const conf = (ak: string, sk: string): string =>
  `[risk-backup]\ntype = s3\nprovider = Other\nenv_auth = false\naccess_key_id = ${ak}\nsecret_access_key = ${sk}\nendpoint = http://${ALIAS}:7070\nregion = us-east-1\n`;

function rclone(secrets: string, args: readonly string[], input?: Buffer): Run {
  const r = spawnSync(
    'docker',
    ['run', '--rm', '-i', '--pull', 'never', ...labelArgs(), '--user', `${process.getuid?.()}:${process.getgid?.()}`, '--network', env.network, '--read-only', '--cap-drop', 'ALL', '-v', `${secrets}:/run/secrets:ro`,
      '--entrypoint', 'rclone', env.image, '--config', '/run/secrets/rclone.conf', '--retries', '1', '--low-level-retries', '1', ...args],
    { input, encoding: 'utf8', timeout: 120_000 },
  );
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function putPolicy(actions: readonly string[] | null): void {
  const body = JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { AWS: [USER_AK] }, Action: [...(actions ?? [])], Resource: [`arn:aws:s3:::${BUCKET}/${KEY_PREFIX}/*`] }] });
  const dir = tmpDir('policy');
  const file = join(dir, 'policy.json');
  writeFileSync(file, body);
  const sha = createHash('sha256').update(body).digest('hex');
  const r = spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--aws-sigv4', 'aws:amz:us-east-1:s3', '--user', `${ROOT_AK}:${ROOT_SK}`, '-H', `x-amz-content-sha256: ${sha}`, '-X', 'PUT', '--data-binary', `@${file}`, `http://127.0.0.1:${port}/${BUCKET}?policy`], { encoding: 'utf8' });
  expect(r.stdout, r.stderr).toBe('204');
}

beforeAll(async () => {
  port = await freePort();
  const run = docker([
    'run', '-d', '--pull', 'never', '--name', GW, ...labelArgs(), '-p', `127.0.0.1:${port}:7070`, '--tmpfs', '/data', '--tmpfs', '/iam', '--tmpfs', '/meta',
    '-e', `ROOT_ACCESS_KEY=${ROOT_AK}`, '-e', `ROOT_SECRET_KEY=${ROOT_SK}`, env.s3Image, '--port', ':7070', '--iam-dir', '/iam', 'posix', '--sidecar', '/meta', '/data',
  ]);
  expect(run.code, run.stderr).toBe(0);
  expect(docker(['network', 'connect', '--alias', ALIAS, env.network, GW]).code).toBe(0);
  let up = false;
  for (let i = 0; i < 60 && !up; i += 1) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
      up = true;
    } catch {
      await sleep(500);
    }
  }
  expect(up, 'gateway restrito não subiu').toBe(true);
  const mk = docker([
    'run', '--rm', '--pull', 'never', ...labelArgs(), '--network', env.network, env.s3Image, 'admin', '--access', ROOT_AK, '--secret', ROOT_SK, '--endpoint-url', `http://${ALIAS}:7070`,
    'create-user', '--access', USER_AK, '--secret', USER_SK, '--role', 'user',
  ]);
  expect(mk.code, mk.stderr).toBe(0);
  rootSecrets = tmpDir('s3r-root');
  writeFileSync(join(rootSecrets, 'rclone.conf'), conf(ROOT_AK, ROOT_SK));
  chmodSync(join(rootSecrets, 'rclone.conf'), 0o400);
  userConf = conf(USER_AK, USER_SK);
  const b = rclone(rootSecrets, ['mkdir', `risk-backup:${BUCKET}`]);
  expect(b.code, b.stderr).toBe(0);
}, 180_000);

afterAll(() => {
  docker(['rm', '-f', '-v', GW]);
});

const prefixFor = (): string => `${KEY_PREFIX}/${rand(4)}`;
const rootList = (prefix: string): string[] => {
  const r = rclone(rootSecrets, ['lsjson', '--files-only', '-R', '--no-modtime', '--no-mimetype', `risk-backup:${BUCKET}/${prefix}`]);
  return r.code === 0 ? (JSON.parse(r.stdout) as { Path: string }[]).map((o) => o.Path).sort() : [];
};

/** Wrapper do rclone que registra as operações HTTP emitidas (método + caminho) sem alterar stdout nem o código de saída. */
const OPS_STUB = `args=(); skip=0
for a in "$@"; do
  if [ "$skip" = 1 ]; then skip=0; continue; fi
  if [ "$a" = "--log-level" ]; then skip=1; continue; fi
  args+=("$a")
done
/usr/bin/rclone "\${args[@]}" -vv --dump headers 2>/marks/rclone.err.$$
rc=$?
grep -E '(PUT|HEAD|GET|DELETE|POST) /' /marks/rclone.err.$$ | sed -E 's/^.*(PUT|HEAD|GET|DELETE|POST) (\\/[^ ]*) HTTP.*$/\\1 \\2/' >> /marks/rclone-ops.log || true
rm -f /marks/rclone.err.$$
exit $rc`;

function runRestricted(prefix: string, secrets: string, marks: string): { run: Run; out: string } {
  const out = tmpDir('out');
  const run = runJob({ out, secrets, stubs: makeStubs({ rclone: OPS_STUB }), marks, env: { RISK_BACKUP_S3_BUCKET: BUCKET, RISK_BACKUP_S3_PREFIX: prefix } });
  return { run, out };
}

describe('credencial S3 só de envio (sem ListBucket e sem Delete)', { timeout: 420_000 }, () => {
  it('controle: sem política alguma o usuário é negado em tudo (a restrição é real) → job sai 5 com cópia local', () => {
    const userSecrets = makeSecrets({ rclone: userConf });
    const prefix = prefixFor();
    const { run, out } = runRestricted(prefix, userSecrets, mkMarks());
    expect(run.code, run.stdout).toBe(5);
    expect(outFiles(out)).toHaveLength(2);
    expect(rootList(prefix)).toEqual([]);
  });

  it('PutObject + GetObject (HEAD), sem list/delete: o job completa (0), envia .age e .sha256 e só emite HEAD/PUT', () => {
    putPolicy(['s3:PutObject', 's3:GetObject']);
    const userSecrets = makeSecrets({ rclone: userConf });
    const prefix = prefixFor();
    const marks = mkMarks();
    const { run, out } = runRestricted(prefix, userSecrets, marks);
    expect(run.code, `${run.stdout}\n${run.stderr}\nops:\n${existsSync(join(marks, 'rclone-ops.log')) ? readFileSync(join(marks, 'rclone-ops.log'), 'utf8') : '(nenhuma)'}`).toBe(0);
    const files = outFiles(out);
    const name = files.find((f) => NAME_RE(env.db).test(f)) as string;
    expect(rootList(prefix)).toEqual([name, `${name}.sha256`].sort());
    expect(jobEvents(run.stdout).map((e) => e.event)).toEqual(['guard_ok', 'local_backup_ok', 'upload_ok', 'upload_ok', 'backup_complete']);

    // Evidência das operações S3 emitidas: só HEAD e PUT em chaves do prefixo; nenhum list (GET no bucket), nenhum DELETE/POST (multipart).
    const ops = readFileSync(join(marks, 'rclone-ops.log'), 'utf8').split('\n').filter(Boolean);
    expect(ops.length).toBeGreaterThan(0);
    for (const op of ops) {
      expect(op, op).toMatch(new RegExp(`^(HEAD|PUT) /${BUCKET}/${prefix}/${name.replace(/\./g, '\\.')}(\\.sha256)?$`));
    }
    expect(ops.some((o) => o.startsWith('PUT '))).toBe(true);
    expect(ops.some((o) => o.startsWith('HEAD '))).toBe(true);
    expect(ops.some((o) => /^(GET|DELETE|POST)/.test(o))).toBe(false);
  });

  it('a mesma credencial NÃO consegue listar nem apagar nem sobrescrever fora do prefixo (política efetiva)', () => {
    const userSecrets = makeSecrets({ rclone: userConf });
    const prefix = prefixFor();
    const probe = `${prefix}/probe.txt`;
    writeFileSync(join(userSecrets, 'probe.txt'), 'x');
    const put = rclone(userSecrets, ['copyto', '--s3-no-check-bucket', '--no-traverse', '/run/secrets/probe.txt', `risk-backup:${BUCKET}/${probe}`]);
    expect(put.code, put.stderr).toBe(0);
    expect(rclone(userSecrets, ['lsf', `risk-backup:${BUCKET}/${prefix}`]).code).not.toBe(0);
    expect(rclone(userSecrets, ['lsf', `risk-backup:${BUCKET}`]).code).not.toBe(0);
    expect(rclone(userSecrets, ['deletefile', `risk-backup:${BUCKET}/${probe}`]).code).not.toBe(0);
    expect(rclone(userSecrets, ['copyto', '--s3-no-check-bucket', '--no-traverse', '/run/secrets/probe.txt', `risk-backup:${BUCKET}/fora-do-prefixo/x.txt`]).code).not.toBe(0);
    expect(rootList(prefix)).toEqual(['probe.txt']); // o objeto continua lá (delete negado)
  });

  // Mesma lacuna do --immutable (ver BackupFailures.test.ts): com a credencial restrita o objeto remoto de mesmo nome também é sobrescrito.
  it.fails('LACUNA: com a credencial restrita, objeto remoto pré-existente com o mesmo nome não é sobrescrito', () => {
    putPolicy(['s3:PutObject', 's3:GetObject']);
    const userSecrets = makeSecrets({ rclone: userConf });
    const prefix = prefixFor();
    const name = `${env.db}-20261116T120000Z.dump.age`;
    const put = rclone(rootSecrets, ['rcat', `risk-backup:${BUCKET}/${prefix}/${name}`], Buffer.from('REMOTO-ORIGINAL'));
    expect(put.code, put.stderr).toBe(0);
    const out = tmpDir('out');
    const stubs = makeStubs({ date: `if [ "$1 $2" = "-u +%Y%m%dT%H%M%SZ" ]; then echo 20261116T120000Z; else exec /usr/bin/date "$@"; fi` });
    const run = runJob({ out, secrets: userSecrets, stubs, env: { RISK_BACKUP_S3_BUCKET: BUCKET, RISK_BACKUP_S3_PREFIX: prefix } });
    const get = rclone(rootSecrets, ['cat', `risk-backup:${BUCKET}/${prefix}/${name}`]);
    expect(get.stdout, run.stdout).toBe('REMOTO-ORIGINAL');
    expect(run.code).toBe(5);
  });

  it('só PutObject (sem GetObject/HEAD): comportamento registrado — o job precisa de HEAD para o copyto e para a verificação', () => {
    putPolicy(['s3:PutObject']);
    const userSecrets = makeSecrets({ rclone: userConf });
    const prefix = prefixFor();
    const marks = mkMarks();
    const { run, out } = runRestricted(prefix, userSecrets, marks);
    const ops = existsSync(join(marks, 'rclone-ops.log')) ? readFileSync(join(marks, 'rclone-ops.log'), 'utf8') : '';
    // Hoje o job exige GetObject/HEAD: sem ele sai 5 mantendo a cópia local. (docs/operacao deve dizer que a credencial de envio precisa de HEAD.)
    expect(run.code, `${run.stdout}\nops:\n${ops}`).toBe(5);
    expect(outFiles(out)).toHaveLength(2);
    expect(jobEvents(run.stdout).some((e) => e.event === 'backup_complete')).toBe(false);
    putPolicy(['s3:PutObject', 's3:GetObject']);
  });
});

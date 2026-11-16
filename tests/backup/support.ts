import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

// Suporte dos testes de backup (ADR-0012). Tudo FICTÍCIO e descartável: a infra (postgres:14, S3 versitygw, rede interna, chaves age
// de teste, bucket) é montada por scripts/test-backup.sh; aqui só se usa o que ele exporta. Recursos Docker criados aqui levam as DUAS
// labels do ciclo (o teardown do script remove só por elas). Nunca prune, nunca recurso sem label.

export interface BackupEnv {
  readonly root: string;
  readonly label: string;
  readonly genericLabel: string;
  readonly jobLabel: string;
  readonly db: string;
  readonly adminUrl: string;
  readonly adminUrlBase: string;
  readonly dbPort: string;
  readonly dbContainer: string;
  readonly s3Container: string;
  readonly network: string;
  readonly dbAlias: string;
  readonly s3Alias: string;
  readonly s3Access: string;
  readonly s3Secret: string;
  readonly bucket: string;
  readonly prefix: string;
  readonly backupLogin: string;
  readonly backupPassword: string;
  readonly image: string;
  readonly s3Image: string;
  readonly workdir: string;
  readonly backupDir: string;
  readonly secretsDir: string;
  readonly configFile: string;
  readonly identityFile: string;
  readonly identityWrongFile: string;
  readonly recipient: string;
  readonly recipientWrong: string;
}

function required(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') throw new Error(`${name} ausente: use \`npm run test:backup\``);
  return v;
}

let cached: BackupEnv | undefined;
/** Lê as variáveis do script. Recusa banco que não seja local e `*_test`. */
export function bkEnv(): BackupEnv {
  if (cached) return cached;
  const e: BackupEnv = {
    root: required('RISK_BACKUP_TEST_REPO_ROOT'),
    label: required('RISK_BACKUP_TEST_LABEL'),
    genericLabel: required('RISK_BACKUP_TEST_GENERIC_LABEL'),
    jobLabel: required('RISK_BACKUP_TEST_JOB_LABEL'),
    db: required('RISK_BACKUP_TEST_DB'),
    adminUrl: required('RISK_BACKUP_TEST_ADMIN_URL'),
    adminUrlBase: required('RISK_BACKUP_TEST_ADMIN_URL_BASE'),
    dbPort: required('RISK_BACKUP_TEST_DB_PORT'),
    dbContainer: required('RISK_BACKUP_TEST_DB_CONTAINER'),
    s3Container: required('RISK_BACKUP_TEST_S3_CONTAINER'),
    network: required('RISK_BACKUP_TEST_NETWORK'),
    dbAlias: required('RISK_BACKUP_TEST_DB_ALIAS'),
    s3Alias: required('RISK_BACKUP_TEST_S3_ALIAS'),
    s3Access: required('RISK_BACKUP_TEST_S3_ACCESS_KEY'),
    s3Secret: required('RISK_BACKUP_TEST_S3_SECRET_KEY'),
    bucket: required('RISK_BACKUP_TEST_S3_BUCKET'),
    prefix: required('RISK_BACKUP_TEST_S3_PREFIX'),
    backupLogin: required('RISK_BACKUP_TEST_BACKUP_LOGIN'),
    backupPassword: required('RISK_BACKUP_TEST_BACKUP_PASSWORD'),
    image: required('RISK_BACKUP_TEST_IMAGE'),
    s3Image: required('RISK_BACKUP_TEST_S3_IMAGE'),
    workdir: required('RISK_BACKUP_TEST_WORKDIR'),
    backupDir: required('RISK_BACKUP_TEST_BACKUP_DIR'),
    secretsDir: required('RISK_BACKUP_TEST_SECRETS_DIR'),
    configFile: required('RISK_BACKUP_TEST_CONFIG_FILE'),
    identityFile: required('RISK_BACKUP_TEST_AGE_IDENTITY_FILE'),
    identityWrongFile: required('RISK_BACKUP_TEST_AGE_IDENTITY_WRONG_FILE'),
    recipient: required('RISK_BACKUP_TEST_AGE_RECIPIENT'),
    recipientWrong: required('RISK_BACKUP_TEST_AGE_RECIPIENT_WRONG'),
  };
  const u = new URL(e.adminUrl);
  if (u.hostname !== '127.0.0.1' || !u.pathname.endsWith('_test') || !e.db.endsWith('_test')) {
    throw new Error('banco de backup deve ser local e terminar em _test; recusando executar');
  }
  if (!e.label.startsWith('com.openclaw-risk-engine.backup-test-run=')) throw new Error('label do ciclo inesperada; recusando');
  cached = e;
  return e;
}

export interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function labelArgs(): string[] {
  const e = bkEnv();
  return ['--label', e.label, '--label', e.genericLabel];
}

export function docker(args: readonly string[], options: { readonly input?: string | Buffer; readonly timeoutMs?: number } = {}): Run {
  const r = spawnSync('docker', [...args], { encoding: 'utf8', input: options.input, timeout: options.timeoutMs ?? 120_000, maxBuffer: 256 * 1024 * 1024 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Diretório temporário 0700 dentro do diretório do ciclo (apagado no teardown do script). */
export function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(bkEnv().workdir, `${prefix}-`));
  chmodSync(d, 0o700);
  return d;
}

export const rand = (n = 12): string => randomBytes(n).toString('hex');

// ---------------------------------------------------------------- configuração / secrets

export interface SecretOverrides {
  readonly pgpass?: string | null;
  readonly age_recipients?: string | null;
  readonly rclone?: string | null;
}

/** Cópia do diretório de secrets do ciclo (0700; arquivos 0400) com conteúdo alterável; `null` remove o arquivo. */
export function makeSecrets(overrides: SecretOverrides = {}): string {
  const e = bkEnv();
  const dir = tmpDir('secrets');
  const files: readonly (readonly [string, string | null | undefined])[] = [
    ['pgpass', overrides.pgpass],
    ['age_recipients', overrides.age_recipients],
    ['rclone.conf', overrides.rclone],
  ];
  for (const [name, value] of files) {
    if (value === null) continue;
    const dest = join(dir, name);
    if (value === undefined) copyFileSync(join(e.secretsDir, name), dest);
    else writeFileSync(dest, value);
    chmodSync(dest, 0o400);
  }
  return dir;
}

export const readSecret = (name: string): string => readFileSync(join(bkEnv().secretsDir, name), 'utf8');

export interface Cfg {
  readonly file: string;
  readonly dir: string;
  readonly secrets: string;
  readonly prefix: string;
}
/** backup.env novo: diretório de saída próprio (vazio, 0700), prefixo S3 próprio e, se não informado, os secrets do ciclo. */
export function makeConfig(over: Record<string, string> = {}, secretsOverrides?: SecretOverrides): Cfg {
  const e = bkEnv();
  const dir = tmpDir('out');
  const secrets = over.RISK_BACKUP_SECRETS_DIR ?? (secretsOverrides ? makeSecrets(secretsOverrides) : e.secretsDir);
  const prefix = over.RISK_BACKUP_S3_PREFIX ?? `${e.prefix}/${rand(4)}`;
  const values: Record<string, string> = {
    RISK_BACKUP_EXPECTED_DB: e.db,
    RISK_BACKUP_DIR: dir,
    RISK_BACKUP_SECRETS_DIR: secrets,
    RISK_BACKUP_S3_BUCKET: e.bucket,
    RISK_BACKUP_S3_PREFIX: prefix,
    RISK_BACKUP_IMAGE: e.image,
    RISK_BACKUP_DOCKER_NETWORK: e.network,
    ...over,
  };
  const file = join(tmpDir('cfg'), 'backup.env');
  writeFileSync(file, Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
  return { file, dir: values.RISK_BACKUP_DIR as string, secrets: values.RISK_BACKUP_SECRETS_DIR as string, prefix: values.RISK_BACKUP_S3_PREFIX as string };
}

export function runBackupProd(configFile: string, timeoutMs = 240_000): Run {
  const e = bkEnv();
  const r = spawnSync('bash', [join(e.root, 'scripts/backup-prod.sh'), configFile], { encoding: 'utf8', timeout: timeoutMs, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/' } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Versão assíncrona (permite observar o host e o Docker enquanto o job roda). */
export function startBackupProd(configFile: string): { readonly done: Promise<Run>; readonly kill: () => void } {
  const e = bkEnv();
  const child = spawn('bash', [join(e.root, 'scripts/backup-prod.sh'), configFile], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/' } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
  const done = new Promise<Run>((resolve) => child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    }));
  return { done, kill: () => child.kill('SIGKILL') };
}

// ---------------------------------------------------------------- job direto (stubs de ferramentas)

export const STUB_PATH = '/stubs:/usr/lib/postgresql/14/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const PG14 = '/usr/lib/postgresql/14/bin';

/** Grava stubs executáveis (bash) num diretório novo; o texto é o corpo depois do shebang. */
export function makeStubs(bodies: Record<string, string>): string {
  const dir = tmpDir('stubs');
  for (const [name, body] of Object.entries(bodies)) {
    const p = join(dir, name);
    writeFileSync(p, `#!/bin/bash\n${body}\n`);
    chmodSync(p, 0o755);
  }
  return dir;
}
export const passthrough = {
  pg_dump: `exec ${PG14}/pg_dump "$@"`,
};

export interface JobOptions {
  readonly out: string;
  readonly secrets: string;
  readonly stubs?: string;
  /** Diretório extra montado em /marks (leitura/escrita) para os stubs registrarem chamadas. */
  readonly marks?: string;
  readonly env?: Record<string, string>;
  readonly network?: string;
}
/** Executa backup-job.sh direto na imagem (sem backup-prod.sh), com as labels do ciclo para o teardown. */
export function runJob(o: JobOptions, timeoutMs = 240_000): Run {
  const e = bkEnv();
  const env: Record<string, string> = { RISK_BACKUP_EXPECTED_DB: e.db, RISK_BACKUP_S3_BUCKET: e.bucket, RISK_BACKUP_S3_PREFIX: `${e.prefix}/${rand(4)}`, ...o.env };
  const args = [
    'run', '--rm', '--pull', 'never', ...labelArgs(), '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    '--network', o.network ?? e.network, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '-v', `${o.out}:/out`, '-v', `${o.secrets}:/run/secrets:ro`,
  ];
  if (o.stubs !== undefined) args.push('-v', `${o.stubs}:/stubs:ro`, '-e', `PATH=${STUB_PATH}`);
  if (o.marks !== undefined) args.push('-v', `${o.marks}:/marks`);
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  args.push('--entrypoint', '/usr/local/bin/backup-job.sh', e.image);
  return docker(args, { timeoutMs });
}

export function jobEvents(stdout: string): { event: string; file: string; bytes: number; exitCode: number }[] {
  return stdout
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as { event: string; file: string; bytes: number; exitCode: number });
}

// ---------------------------------------------------------------- S3 de teste (credencial raiz) e age

/** rclone com a configuração raiz do ciclo, dentro de contêiner descartável na rede do ciclo (o host não alcança a rede interna). */
export function rcloneRoot(args: readonly string[], options: { readonly secrets?: string; readonly input?: Buffer; readonly timeoutMs?: number } = {}): Run {
  const e = bkEnv();
  return docker(
    ['run', '--rm', '-i', '--pull', 'never', ...labelArgs(), '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, '--network', e.network,
      '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '-v', `${options.secrets ?? e.secretsDir}:/run/secrets:ro`,
      '--entrypoint', 'rclone', e.image, '--config', '/run/secrets/rclone.conf', ...args],
    { timeoutMs: options.timeoutMs ?? 120_000, input: options.input },
  );
}
export interface S3Object {
  readonly Path: string;
  readonly Size: number;
}
export function s3List(prefix: string): S3Object[] {
  const e = bkEnv();
  const r = rcloneRoot(['lsjson', '--files-only', '-R', '--no-modtime', '--no-mimetype', `risk-backup:${e.bucket}/${prefix}`]);
  if (r.code !== 0) return [];
  return JSON.parse(r.stdout) as S3Object[];
}
/** Baixa um objeto (bytes) pelo contêiner rclone; devolve null se ausente. */
export function s3Get(key: string): Buffer | null {
  const e = bkEnv();
  const r = spawnSync(
    'docker',
    ['run', '--rm', '--pull', 'never', ...labelArgs(), '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, '--network', e.network, '--read-only', '--cap-drop', 'ALL',
      '-v', `${e.secretsDir}:/run/secrets:ro`, '--entrypoint', 'rclone', e.image, '--config', '/run/secrets/rclone.conf', 'cat', `risk-backup:${e.bucket}/${key}`],
    { timeout: 120_000, maxBuffer: 256 * 1024 * 1024 },
  );
  return r.status === 0 ? r.stdout : null;
}

/** Decifra com `age -d` em contêiner sem rede; devolve os bytes (ou null se falhar). */
export function ageDecrypt(file: string, identity: string): Buffer | null {
  const e = bkEnv();
  const r = spawnSync(
    'docker',
    ['run', '--rm', '--pull', 'never', ...labelArgs(), '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, '--network', 'none', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '-v', `${file}:/in/dump.age:ro`, '-v', `${identity}:/run/identity/key:ro`, '--entrypoint', 'age', e.image, '-d', '-i', '/run/identity/key', '/in/dump.age'],
    { timeout: 120_000, maxBuffer: 256 * 1024 * 1024 },
  );
  return r.status === 0 ? r.stdout : null;
}

/** `pg_restore -l` (só lista o sumário; não restaura) sobre bytes em claro vindos do pipe. */
export function pgRestoreList(dump: Buffer): Run {
  const e = bkEnv();
  const r = spawnSync(
    'docker',
    ['run', '--rm', '-i', '--pull', 'never', ...labelArgs(), '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--entrypoint', 'pg_restore', e.image, '-l'],
    { input: dump, encoding: 'utf8', timeout: 120_000, maxBuffer: 256 * 1024 * 1024 },
  );
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

// ---------------------------------------------------------------- banco

export function adminPool(): pg.Pool {
  return new pg.Pool({ connectionString: bkEnv().adminUrl, max: 3 });
}
export const urlFor = (database: string): string => `${bkEnv().adminUrlBase}/${database}`;

// ---------------------------------------------------------------- arquivos

export function entries(dir: string): string[] {
  return readdirSync(dir).sort();
}
/** Entradas do diretório de saída sem o .lock do flock. */
export const outFiles = (dir: string): string[] => entries(dir).filter((n) => n !== '.lock');
export const NAME_RE = (db: string): RegExp => new RegExp(`^${db}-\\d{8}T\\d{6}Z\\.dump\\.age$`);

/** Garante o diretório; útil para marcas dos stubs. */
export function mkMarks(): string {
  const d = tmpDir('marks');
  mkdirSync(join(d, 'x'), { recursive: true });
  return d;
}

import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

// Suporte E2E (SPEC §9.4). Tudo FICTÍCIO e descartável: o ciclo (banco + app pela imagem) é montado por scripts/test-e2e.sh
// e só recursos com a label exclusiva são manipulados aqui.

export interface E2eEnv {
  readonly baseUrl: string;
  readonly databaseUrl: string;
  readonly runtimeDatabaseUrl: string;
  readonly appContainer: string;
  readonly dbContainer: string;
  readonly image: string;
  readonly label: string;
  readonly agentId: string;
  readonly agentToken: string;
  readonly executorId: string;
  readonly executorToken: string;
}

function required(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') throw new Error(`${name} ausente: use \`npm run test:e2e\``);
  return v;
}

let cached: E2eEnv | undefined;
/** Lê as variáveis do script. Recusa banco que não seja local e `*_test`, e recursos fora da convenção openclaw-risk-e2e-*. */
export function e2eEnv(): E2eEnv {
  if (cached) return cached;
  const env: E2eEnv = {
    baseUrl: required('RISK_E2E_BASE_URL'),
    databaseUrl: required('RISK_E2E_DATABASE_URL'),
    runtimeDatabaseUrl: required('RISK_E2E_RUNTIME_DATABASE_URL'),
    appContainer: required('RISK_E2E_APP_CONTAINER'),
    dbContainer: required('RISK_E2E_DB_CONTAINER'),
    image: required('RISK_E2E_IMAGE'),
    label: required('RISK_E2E_LABEL'),
    agentId: required('RISK_E2E_AGENT_ID'),
    agentToken: required('RISK_E2E_AGENT_TOKEN'),
    executorId: required('RISK_E2E_EXECUTOR_ID'),
    executorToken: required('RISK_E2E_EXECUTOR_TOKEN'),
  };
  for (const raw of [env.databaseUrl, env.runtimeDatabaseUrl]) {
    const url = new URL(raw);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !url.pathname.endsWith('_test')) {
      throw new Error('banco E2E deve ser local e terminar em _test; recusando executar');
    }
  }
  if (!new URL(env.baseUrl).hostname.startsWith('127.')) throw new Error('app E2E deve estar em loopback');
  for (const name of [env.appContainer, env.dbContainer]) {
    if (!name.startsWith('openclaw-risk-e2e-')) throw new Error('contêiner fora da convenção openclaw-risk-e2e-*; recusando');
  }
  cached = env;
  return env;
}

// ---------------------------------------------------------------- docker (somente recursos com a label exclusiva)

export function docker(args: readonly string[], options: { readonly input?: string; readonly timeoutMs?: number; readonly env?: NodeJS.ProcessEnv } = {}): string {
  return execFileSync('docker', [...args], {
    encoding: 'utf8',
    input: options.input,
    timeout: options.timeoutMs ?? 120_000,
    env: options.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Execução tolerante a falha: devolve código e saídas em vez de lançar. */
export function dockerRun(args: readonly string[], options: { readonly timeoutMs?: number; readonly env?: NodeJS.ProcessEnv } = {}): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync('docker', [...args], { encoding: 'utf8', timeout: options.timeoutMs ?? 120_000, env: options.env ?? process.env, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Trava: só age em contêiner existente, openclaw-risk-e2e-* e com a label exclusiva do script. */
export function assertOwnedContainer(name: string): void {
  const e = e2eEnv();
  if (!name.startsWith('openclaw-risk-e2e-')) throw new Error('recusado: contêiner fora da convenção');
  const [key, value] = e.label.split('=') as [string, string];
  const out = docker(['inspect', '--format', `{{index .Config.Labels "${key}"}}`, name]).trim();
  if (out !== value) throw new Error('recusado: contêiner sem a label exclusiva do ciclo E2E');
}

export function containerRunning(name: string): boolean {
  assertOwnedContainer(name);
  return docker(['inspect', '--format', '{{.State.Running}}', name]).trim() === 'true';
}

/**
 * Timeouts de banco da APP sob teste, lidos de scripts/test-e2e.sh (fonte única; nada duplicado aqui).
 * O prazo do cliente por comando é CONNECTION + STATEMENT (clientLease.ts): é o teto de uma resposta com o banco congelado.
 */
export function appDbDeadlines(): { readonly connectionMs: number; readonly statementMs: number; readonly lockMs: number; readonly commandMs: number } {
  const script = readFileSync(join(import.meta.dirname, '../../../scripts/test-e2e.sh'), 'utf8');
  const pick = (name: string): number => {
    const m = new RegExp(`-e ${name}=([0-9]+)`).exec(script);
    if (m === null) throw new Error(`${name} não encontrado em scripts/test-e2e.sh`);
    return Number(m[1]);
  };
  const connectionMs = pick('RISK_DB_CONNECTION_TIMEOUT_MS');
  const statementMs = pick('RISK_DB_STATEMENT_TIMEOUT_MS');
  return { connectionMs, statementMs, lockMs: pick('RISK_DB_LOCK_TIMEOUT_MS'), commandMs: connectionMs + statementMs };
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function waitFor(what: string, probe: () => Promise<boolean> | boolean, timeoutMs = 60_000, stepMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await probe()) return;
    } catch {
      // ainda não
    }
    if (Date.now() > deadline) throw new Error(`timeout esperando: ${what}`);
    await sleep(stepMs);
  }
}

/** Reinicia a app (após kill/stop) e espera ready. A app é read-only e sem estado em disco: `docker start` basta. */
export async function startApp(): Promise<void> {
  const e = e2eEnv();
  assertOwnedContainer(e.appContainer);
  if (!containerRunning(e.appContainer)) docker(['start', e.appContainer]);
  await waitFor('app ready', async () => (await fetch(`${e.baseUrl}/health/ready`)).status === 200, 60_000);
}

// ---------------------------------------------------------------- exclusão mútua entre arquivos (testes destrutivos)

const LOCK_DIR = join(tmpdir(), 'openclaw-risk-e2e.lock');
const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Os arquivos E2E compartilham banco e app; vários derrubam ou reiniciam recursos. Como o script não força
 * `--no-file-parallelism`, cada arquivo adquire este lock no beforeAll (mkdir é atômico) e o libera no afterAll.
 */
export async function acquireSuiteLock(timeoutMs = 600_000): Promise<() => void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(LOCK_DIR);
      writeFileSync(join(LOCK_DIR, 'pid'), String(process.pid));
      return () => {
        rmSync(LOCK_DIR, { recursive: true, force: true });
      };
    } catch {
      let owner = 0;
      try {
        owner = Number(readFileSync(join(LOCK_DIR, 'pid'), 'utf8'));
      } catch {
        // dono ainda gravando o pid
      }
      if (owner !== 0 && owner !== process.pid && !pidAlive(owner)) rmSync(LOCK_DIR, { recursive: true, force: true });
      if (Date.now() > deadline) throw new Error('timeout esperando o lock da suíte E2E');
      await sleep(200);
    }
  }
}

// ---------------------------------------------------------------- HTTP

export interface HttpResult {
  readonly status: number;
  readonly headers: Headers;
  readonly json: Record<string, unknown>;
  readonly text: string;
}

/** `status` 0 = sem resposta (conexão recusada/abortada/timeout): para testes de indisponibilidade. */
export async function call(base: string, method: 'GET' | 'POST', path: string, token: string | null, body?: unknown, timeoutMs = 20_000): Promise<HttpResult> {
  try {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // corpo não-JSON
    }
    return { status: res.status, headers: res.headers, json, text };
  } catch {
    return { status: 0, headers: new Headers(), json: {}, text: '' };
  }
}

export const EVALUATE = '/v1/risk/evaluations';
export const consumePath = (decisionId: string): string => `/v1/risk/authorizations/${decisionId}/consume`;
export const releasePath = (reservationId: string): string => `/v1/risk/reservations/${reservationId}/release`;

// ---------------------------------------------------------------- banco (superuser de TESTE do banco descartável)

/** Pool administrativo de TESTE (superuser do contêiner descartável). Nunca usado pela composição sob teste. */
export function adminPool(max = 4): pg.Pool {
  const pool = new pg.Pool({ connectionString: e2eEnv().databaseUrl, max });
  pool.on('error', () => undefined);
  return pool;
}

/** Banco de manutenção `postgres` do contêiner descartável (só para ALTER DATABASE do banco `*_test` do ciclo). */
function maintenanceUrl(url: string): string {
  const u = new URL(url);
  u.pathname = '/postgres';
  return u.toString();
}

/** URL do mesmo servidor apontando para outro banco (também `*_test`). */
export function withDatabase(url: string, database: string): string {
  if (!database.endsWith('_test')) throw new Error('banco deve terminar em _test');
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

// ---------------------------------------------------------------- indisponibilidade controlada do Postgres

/**
 * O banco E2E usa tmpfs: `docker stop`/`start` APAGARIA os dados (verificado). A indisponibilidade é, portanto, simulada sem
 * parar o contêiner: (a) `ALLOW_CONNECTIONS false` + término dos backends (novas conexões falham, as existentes caem);
 * (b) `docker pause` (processos congelados: conexões penduram); (c) SIGKILL em um backend (crash recovery do cluster).
 */
export async function withDatabaseRefusing<T>(work: () => Promise<T>): Promise<T> {
  const e = e2eEnv();
  const name = new URL(e.databaseUrl).pathname.slice(1);
  const client = new pg.Client({ connectionString: maintenanceUrl(e.databaseUrl) });
  client.on('error', () => undefined);
  await client.connect();
  try {
    await client.query(`ALTER DATABASE ${name} ALLOW_CONNECTIONS false`);
    await client.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [name]);
    return await work();
  } finally {
    await client.query(`ALTER DATABASE ${name} ALLOW_CONNECTIONS true`);
    await client.end();
  }
}

export async function withDatabasePaused<T>(work: () => Promise<T>): Promise<T> {
  const e = e2eEnv();
  assertOwnedContainer(e.dbContainer);
  docker(['pause', e.dbContainer]);
  try {
    return await work();
  } finally {
    docker(['unpause', e.dbContainer]);
    await waitFor('banco responde após unpause', async () => {
      const c = new pg.Client({ connectionString: e.databaseUrl });
      c.on('error', () => undefined);
      await c.connect();
      await c.query('SELECT 1');
      await c.end();
      return true;
    });
  }
}

/** SIGKILL em um backend do login de runtime: o postmaster derruba todas as conexões e faz crash recovery (dados preservados). */
export async function crashPostgresBackend(): Promise<void> {
  const e = e2eEnv();
  assertOwnedContainer(e.dbContainer);
  const admin = new pg.Client({ connectionString: e.databaseUrl });
  admin.on('error', () => undefined);
  await admin.connect();
  let pid: string | undefined;
  try {
    pid = (await admin.query<{ pid: string }>(`SELECT pid::text FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid() AND usename = 'e2e_runtime' LIMIT 1`)).rows[0]?.pid;
    pid ??= (await admin.query<{ pid: string }>(`SELECT pid::text FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid() LIMIT 1`)).rows[0]?.pid;
  } finally {
    await admin.end().catch(() => undefined);
  }
  if (pid === undefined || !/^[0-9]+$/.test(pid)) throw new Error('nenhum backend para derrubar');
  dockerRun(['exec', e.dbContainer, 'kill', '-9', pid]);
}

export async function waitDatabaseUp(timeoutMs = 60_000): Promise<void> {
  const e = e2eEnv();
  await waitFor('banco aceita conexões', async () => {
    const c = new pg.Client({ connectionString: e.databaseUrl });
    c.on('error', () => undefined);
    await c.connect();
    await c.query('SELECT 1');
    await c.end();
    return true;
  }, timeoutMs);
}

// ---------------------------------------------------------------- CLI pela imagem (one-shot, descartável)

/**
 * Executa `node dist/interfaces/cli/main.js <args>` em contêiner descartável da imagem sob teste (--rm, label exclusiva,
 * nome openclaw-risk-e2e-cli-*, rede host, somente leitura, sem capacidades). Valores de `envValues` viajam pelo ambiente do
 * processo e são repassados ao Docker por NOME (`-e NAME`), nunca em argumentos.
 */
export function runImageCli(args: readonly string[], envValues: Record<string, string>): { code: number | null; stdout: string; stderr: string } {
  const e = e2eEnv();
  const name = `openclaw-risk-e2e-cli-${randomBytes(4).toString('hex')}`;
  const flags = Object.keys(envValues).flatMap((k) => ['-e', k]);
  const result = dockerRun(
    ['run', '--rm', '--name', name, '--label', e.label, '--network', 'host', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', ...flags, '--entrypoint', 'node', e.image, 'dist/interfaces/cli/main.js', ...args],
    { env: { ...process.env, ...envValues }, timeoutMs: 90_000 },
  );
  // Timeout (host sobrecarregado): não deixa contêiner órfão (só o nosso, por nome exclusivo e label).
  if (result.code === null) dockerRun(['rm', '-f', name], { timeoutMs: 30_000 });
  return result;
}

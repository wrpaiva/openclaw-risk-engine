import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { acquireSuiteLock, adminPool, assertOwnedContainer, docker, dockerRun, e2eEnv, waitFor } from './support/env.js';
import { accountCounts, proposalAt, seedAccountFor, uniqueAccount } from './support/data.js';

// ADR-0011 (O2), plano §5. A app roda pela IMAGEM em rede bridge --internal do ciclo, SEM publicar portas (sem -p):
// (a) private-network + transporte + 0.0.0.0, (b) loopback + 127.0.0.1. O cliente é outro contêiner da mesma imagem na mesma rede.
// Tudo FICTÍCIO e descartável; só recursos com a label do ciclo e nomes openclaw-risk-e2e-*. Nada de prune; nunca aegis-postgres.
// LACUNA DECLARADA: a rede de teste é bridge --internal; a cifragem de uma overlay real NÃO é verificada aqui (checklist de deploy).
const env = e2eEnv();
const NETWORK = process.env['RISK_E2E_NETWORK'] ?? '';
const DB_ALIAS = process.env['RISK_E2E_DB_ALIAS'] ?? '';
const SECRETS_DIR = process.env['RISK_E2E_SECRETS_DIR'] ?? '';
const OVERLAY = 'plaintext-encrypted-overlay';
const PORT = '8080';
const SUFFIX = randomBytes(3).toString('hex');
const APP_A = `openclaw-risk-e2e-pn-a-${SUFFIX}`;
const APP_B = `openclaw-risk-e2e-pn-b-${SUFFIX}`;
const created = new Set<string>();

let release: (() => void) | undefined;
let admin: pg.Pool | undefined;
let ipA = '';
let ipB = '';
let account = '';

function requireNetworkEnv(): void {
  if (NETWORK === '' || DB_ALIAS === '' || SECRETS_DIR === '') throw new Error('RISK_E2E_NETWORK/RISK_E2E_DB_ALIAS/RISK_E2E_SECRETS_DIR ausentes: use `npm run test:e2e`');
  if (!NETWORK.startsWith('openclaw-risk-e2e-net-')) throw new Error('rede fora da convenção openclaw-risk-e2e-net-*; recusando');
  const [key, value] = env.label.split('=') as [string, string];
  const out = docker(['network', 'inspect', '--format', `{{index .Labels "${key}"}}|{{.Internal}}|{{.Driver}}`, NETWORK]).trim();
  if (out !== `${value}|true|bridge`) throw new Error('rede sem a label do ciclo, não interna ou não bridge; recusando');
}

const [LABEL_KEY, LABEL_VALUE] = env.label.split('=') as [string, string];
const IDS = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;

function appEnv(extra: Record<string, string>): string[] {
  const all: Record<string, string> = {
    RISK_ENVIRONMENT: 'PAPER',
    RISK_DATABASE_URL_FILE: '/run/secrets/runtime_database_url_net',
    RISK_LOG_LEVEL: 'info',
    RISK_CLOCK_SKEW_TOLERANCE_MS: '1000',
    RISK_DB_CONNECTION_TIMEOUT_MS: '2000',
    RISK_DB_STATEMENT_TIMEOUT_MS: '5000',
    RISK_DB_LOCK_TIMEOUT_MS: '2000',
    RISK_HTTP_ENABLED: 'true',
    RISK_HTTP_PORT: PORT,
    RISK_HTTP_MAX_BODY_BYTES: '65536',
    RISK_HTTP_REQUEST_TIMEOUT_MS: '10000',
    RISK_HTTP_HEADERS_TIMEOUT_MS: '5000',
    RISK_PRINCIPALS_FILE: '/run/secrets/principals.json',
    ...extra,
  };
  return Object.entries(all).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
}

/** Flags comuns de contêiner do teste: label do ciclo, nome openclaw-risk-e2e-*, somente leitura, sem capacidades, SEM -p. */
function baseFlags(name: string, network: string): string[] {
  if (!name.startsWith('openclaw-risk-e2e-')) throw new Error('nome fora da convenção');
  return ['--name', name, '--label', env.label, '--label', 'com.openclaw-risk-engine.test=1', '--network', network, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges'];
}

function startApp(name: string, extra: Record<string, string>): void {
  docker(['run', '-d', ...baseFlags(name, NETWORK), '--user', IDS, '-v', `${SECRETS_DIR}:/run/secrets:ro`, ...appEnv(extra), env.image]);
  created.add(name);
}

const ipOf = (name: string): string => docker(['inspect', '--format', `{{(index .NetworkSettings.Networks "${NETWORK}").IPAddress}}`, name]).trim();

const A_ENV = { RISK_HTTP_BIND_SCOPE: 'private-network', RISK_HTTP_TRANSPORT: OVERLAY, RISK_HTTP_HOST: '0.0.0.0' };
const B_ENV = { RISK_HTTP_BIND_SCOPE: 'loopback', RISK_HTTP_HOST: '127.0.0.1' };

const CLIENT_SCRIPT = `
const [url, method] = process.argv.slice(1);
const headers = {};
if (process.env.CLIENT_AUTH) headers.Authorization = 'Bearer ' + process.env.CLIENT_AUTH;
const body = process.env.CLIENT_BODY;
if (body) headers['Content-Type'] = 'application/json';
fetch(url, { method, headers, body: body || undefined, signal: AbortSignal.timeout(4000) })
  .then(async (r) => process.stdout.write(JSON.stringify({ status: r.status, text: await r.text() })))
  .catch(() => process.stdout.write(JSON.stringify({ status: 0, text: '' })));
`;

interface ClientResult { readonly status: number; readonly text: string }

/** Cliente = outro contêiner da mesma imagem (--entrypoint node), descartável. Token/corpo vão por ambiente, nunca por argumento. */
function client(network: string, host: string, method: 'GET' | 'POST', path: string, token: string | null = null, body?: unknown): ClientResult {
  const name = `openclaw-risk-e2e-pn-client-${randomBytes(4).toString('hex')}`;
  const envFlags = [...(token === null ? [] : ['-e', 'CLIENT_AUTH']), ...(body === undefined ? [] : ['-e', 'CLIENT_BODY'])];
  const r = dockerRun(
    ['run', '--rm', ...baseFlags(name, network), '--user', IDS, ...envFlags, '--entrypoint', 'node', env.image, '-e', CLIENT_SCRIPT, `http://${host}:${PORT}${path}`, method],
    { env: { ...process.env, ...(token === null ? {} : { CLIENT_AUTH: token }), ...(body === undefined ? {} : { CLIENT_BODY: JSON.stringify(body) }) }, timeoutMs: 60_000 },
  );
  if (r.code === null) dockerRun(['rm', '-f', name], { timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`cliente falhou (exit ${String(r.code)})`);
  return JSON.parse(r.stdout) as ClientResult;
}

function adminOf(): pg.Pool {
  if (admin === undefined) throw new Error('pool admin não iniciado');
  return admin;
}

const healthcheckIn = (name: string): number | null => {
  assertOwnedContainer(name);
  return dockerRun(['exec', name, 'node', 'dist/interfaces/cli/main.js', 'healthcheck']).code;
};

beforeAll(async () => {
  release = await acquireSuiteLock();
  requireNetworkEnv();
  const pool = adminPool(3);
  admin = pool;
  account = uniqueAccount();
  await seedAccountFor(pool, { accountId: account, agents: [env.agentId], executors: [env.executorId] });
  startApp(APP_A, A_ENV);
  startApp(APP_B, B_ENV);
  ipA = ipOf(APP_A);
  ipB = ipOf(APP_B);
  expect(ipA).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  expect(ipB).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  await waitFor('(a) ready pela rede interna', () => client(NETWORK, ipA, 'GET', '/health/ready').status === 200, 60_000, 500);
  await waitFor('(b) healthcheck interno', () => healthcheckIn(APP_B) === 0, 60_000, 500);
}, 180_000);

afterAll(async () => {
  // Só os próprios contêineres (nomes exclusivos desta execução + label do ciclo); a rede é removida pelo script.
  for (const name of created) {
    try {
      assertOwnedContainer(name);
      dockerRun(['rm', '-f', name], { timeoutMs: 30_000 });
    } catch {
      // já removido
    }
  }
  await admin?.end();
  release?.();
});

describe('(a) private-network + transporte + 0.0.0.0 na rede interna', () => {
  it('/health/live responde 200 a um cliente da mesma rede', () => {
    const r = client(NETWORK, ipA, 'GET', '/health/live');
    expect(r.status).toBe(200);
  });

  it('rota transacional: sem Authorization → 401; token inválido → 401; sem decisão alguma gravada', async () => {
    const body = proposalAt(Date.now(), { accountId: account, agentId: env.agentId });
    const none = client(NETWORK, ipA, 'POST', '/v1/risk/evaluations', null, body);
    expect(none.status).toBe(401);
    const bad = client(NETWORK, ipA, 'POST', '/v1/risk/evaluations', `invalido-${randomBytes(8).toString('hex')}`, body);
    expect(bad.status).toBe(401);
    for (const r of [none, bad]) expect(r.text).not.toContain('ALLOW_PAPER');
    expect(await accountCounts(adminOf(), account)).toMatchObject({ proposals: 0, decisions: 0, allow: 0, reservations: 0 });
  });

  it('Bearer de fixture: nem 401 nem 403, e nunca autorização real (a imagem só emite BLOCK)', async () => {
    const body = proposalAt(Date.now(), { accountId: account, agentId: env.agentId });
    const r = client(NETWORK, ipA, 'POST', '/v1/risk/evaluations', env.agentToken, body);
    expect([401, 403]).not.toContain(r.status);
    expect(r.status).toBeLessThan(500);
    expect(r.status).not.toBe(0);
    expect(r.text).not.toContain('ALLOW_PAPER');
    const counts = await accountCounts(adminOf(), account);
    expect(counts.allow).toBe(0);
    expect(counts.reservations).toBe(0);
    expect(counts.activeReservations).toBe(0);
  });

  it('cliente com --network none não alcança (a)', () => {
    const r = client('none', ipA, 'GET', '/health/live');
    expect(r.status).toBe(0);
  });

  it('healthcheck interno de (a) = 0 (o curinga do bind não impede a sonda; a escolha do host é garantida pelo unit de healthProbeHost)', () => {
    expect(healthcheckIn(APP_A)).toBe(0);
  });

  it('sem portas publicadas: PortBindings vazio e nenhuma HostPort', () => {
    const bindings = JSON.parse(docker(['inspect', '--format', '{{json .HostConfig.PortBindings}}', APP_A])) as Record<string, unknown> | null;
    expect(Object.keys(bindings ?? {})).toEqual([]);
    const ports = JSON.parse(docker(['inspect', '--format', '{{json .NetworkSettings.Ports}}', APP_A])) as Record<string, unknown> | null;
    expect(JSON.stringify(ports ?? {})).not.toContain('HostPort');
  });

  it('logs: http.listening com bindScope=private-network e transport; sem token, URL, host ou porta', () => {
    const logs = dockerRun(['logs', APP_A]);
    const text = `${logs.stdout}\n${logs.stderr}`;
    const listening = text.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l['event'] === 'http.listening');
    expect(listening).toBeDefined();
    expect(listening).toMatchObject({ outcome: 'STARTED', bindScope: 'private-network', transport: OVERLAY });
    for (const k of ['host', 'port', 'url']) expect(listening).not.toHaveProperty(k);
    expect(text).not.toContain('0.0.0.0');
    expect(text).not.toContain(PORT);
    for (const secret of [env.agentToken, env.executorToken]) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/postgres(ql)?:\/\//);
    expect(text).not.toContain(DB_ALIAS);
    expect(text).not.toMatch(/Bearer\s+\S/);
  });
});

describe('(b) loopback + 127.0.0.1 na mesma rede', () => {
  it('inalcançável por outro contêiner da rede, mas o healthcheck interno = 0', () => {
    expect(client(NETWORK, ipB, 'GET', '/health/live').status).toBe(0);
    expect(healthcheckIn(APP_B)).toBe(0);
  });

  it('sem portas publicadas: PortBindings vazio', () => {
    const bindings = JSON.parse(docker(['inspect', '--format', '{{json .HostConfig.PortBindings}}', APP_B])) as Record<string, unknown> | null;
    expect(Object.keys(bindings ?? {})).toEqual([]);
  });

  it('logs: http.listening com bindScope=loopback e sem transport', () => {
    const logs = dockerRun(['logs', APP_B]);
    const text = `${logs.stdout}\n${logs.stderr}`;
    const listening = text.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l['event'] === 'http.listening');
    expect(listening).toMatchObject({ bindScope: 'loopback' });
    expect(listening).not.toHaveProperty('transport');
    for (const k of ['host', 'port', 'url']) expect(listening).not.toHaveProperty(k);
    expect(text).not.toContain('0.0.0.0');
    expect(text).not.toContain(PORT);
    expect(text).not.toMatch(/postgres(ql)?:\/\//);
  });
});

describe('boot recusado (exit 2, mensagem fixa, sem listener) nas combinações inválidas', () => {
  function boot(extra: Record<string, string>): { code: number | null; out: string } {
    const name = `openclaw-risk-e2e-pn-bad-${randomBytes(4).toString('hex')}`;
    const r = dockerRun(['run', '--rm', ...baseFlags(name, NETWORK), '--user', IDS, '-v', `${SECRETS_DIR}:/run/secrets:ro`, ...appEnv(extra), env.image], { timeoutMs: 60_000 });
    if (r.code === null) dockerRun(['rm', '-f', name], { timeoutMs: 30_000 });
    return { code: r.code, out: `${r.stdout}\n${r.stderr}` };
  }

  it.each([
    ['private-network sem transporte', { RISK_HTTP_BIND_SCOPE: 'private-network', RISK_HTTP_HOST: '0.0.0.0' }, 'RISK_HTTP_BIND_SCOPE=private-network exige RISK_HTTP_TRANSPORT=plaintext-encrypted-overlay (ADR-0011)'],
    ['private-network com 127.0.0.1', { RISK_HTTP_BIND_SCOPE: 'private-network', RISK_HTTP_TRANSPORT: OVERLAY, RISK_HTTP_HOST: '127.0.0.1' }, 'RISK_HTTP_HOST: escopo private-network aceita só 0.0.0.0'],
    ['transporte em loopback', { RISK_HTTP_BIND_SCOPE: 'loopback', RISK_HTTP_TRANSPORT: OVERLAY, RISK_HTTP_HOST: '127.0.0.1' }, 'RISK_HTTP_TRANSPORT só é permitido com RISK_HTTP_BIND_SCOPE=private-network'],
    ['loopback com 0.0.0.0', { RISK_HTTP_HOST: '0.0.0.0' }, 'RISK_HTTP_HOST: escopo loopback aceita só IP de loopback'],
  ] as const)('%s', (_name, extra, message) => {
    const r = boot({ ...extra });
    expect(r.code).toBe(2);
    expect(r.out).toContain(message);
    expect(r.out).not.toMatch(/postgres(ql)?:\/\//);
    expect(r.out).not.toMatch(/\n\s+at /);
    expect(r.out).not.toContain('http.listening');
  });
});

describe('higiene do ciclo', () => {
  it('os contêineres de teste têm a label do ciclo e a rede é a interna do ciclo', () => {
    for (const name of [APP_A, APP_B]) {
      expect(docker(['inspect', '--format', `{{index .Config.Labels "${LABEL_KEY}"}}`, name]).trim()).toBe(LABEL_VALUE);
    }
    expect(docker(['network', 'inspect', '--format', '{{.Internal}}', NETWORK]).trim()).toBe('true');
  });
});

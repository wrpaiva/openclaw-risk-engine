import { writeFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createIsolatedDatabase, createRuntimeLogin, type IsolatedDatabase, type RuntimeLogin } from './support/database.js';
import { buildDist, freePort, runNode, runtimeEnv, startNode, waitForStatus, writePrincipals, type Dist, type RunningMain } from './support/dist.js';

// main real: readiness, draining e desligamento ordenado (etapa 2.5). Tudo FICTÍCIO; banco descartável *_test.
const STACK = /\n\s+at .*\(|node:internal|\.js:\d+:\d+|Error:/;
let dist: Dist;
let db: IsolatedDatabase;
let rt: RuntimeLogin;
let running: RunningMain | undefined;

beforeAll(async () => {
  dist = buildDist('risk-main-shutdown');
  writePrincipals(dist.work);
  db = await createIsolatedDatabase();
  rt = await createRuntimeLogin(db);
});
afterEach(async () => {
  if (running && running.child.exitCode === null) {
    running.child.kill('SIGKILL');
    await running.exited();
  }
  running = undefined;
});
afterAll(async () => {
  await rt.drop();
  await db.drop();
  dist.cleanup();
});

async function start(url = rt.url): Promise<{ port: number; main: RunningMain }> {
  const port = await freePort();
  const main = startNode(dist.httpMain, runtimeEnv({ RISK_DATABASE_URL: url, RISK_HTTP_PORT: String(port), RISK_PRINCIPALS_FILE: `${dist.work}/principals.json` }));
  running = main;
  await waitForStatus(`http://127.0.0.1:${port}/health/live`, 200);
  return { port, main };
}

/** Abre uma conexão com a requisição INCOMPLETA (cabeçalhos sem a linha em branco final): a requisição fica em andamento. */
async function openPending(port: number, path: string): Promise<{ finish(): Promise<string>; socket: Socket }> {
  const socket = connect(port, '127.0.0.1');
  let data = '';
  socket.on('data', (d: Buffer) => (data += d.toString()));
  socket.on('error', () => undefined);
  await new Promise<void>((resolve) => socket.once('connect', resolve));
  socket.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n`);
  return {
    socket,
    finish: () =>
      new Promise<string>((resolve) => {
        socket.once('close', () => {
          resolve(data);
        });
        socket.write('\r\n');
        setTimeout(() => socket.destroy(), 4000);
      }),
  };
}
const statusLine = (raw: string) => /^HTTP\/1\.1 (\d{3})/.exec(raw)?.[1];
const bodyOf = (raw: string) => JSON.parse(raw.slice(raw.indexOf('\r\n\r\n') + 4).replace(/^[0-9a-f]+\r\n/i, '').replace(/\r\n0\r\n\r\n$/, '')) as Record<string, unknown>;

describe('main real: readiness com banco migrado e login de runtime', () => {
  it('ready 200 com checks ok e live 200; sem versão/hostname no corpo; logs sem http.request das sondas', async () => {
    const { port, main } = await start();
    const ready = await fetch(`http://127.0.0.1:${port}/health/ready`);
    expect(ready.status).toBe(200);
    expect(ready.headers.get('cache-control')).toBe('no-store');
    expect(await ready.json()).toEqual({ status: 'ready', checks: { database: 'ok', schema: 'ok', privileges: 'ok', reconciliation: 'ok', draining: 'ok' } });
    expect((await fetch(`http://127.0.0.1:${port}/health/live`)).status).toBe(200);
    expect(main.stderr()).toBe('');
  });

  it('ready vira 503 quando o schema diverge (checksum alterado no banco) e volta a 200 ao restaurar', async () => {
    const { port } = await start();
    const url = `http://127.0.0.1:${port}/health/ready`;
    expect((await fetch(url)).status).toBe(200);
    const original = (await db.pool.query<{ checksum: string }>(`SELECT checksum FROM schema_migrations WHERE version = '0002_access_grants.sql'`)).rows[0]?.checksum ?? '';
    await db.pool.query(`UPDATE schema_migrations SET checksum = $1 WHERE version = '0002_access_grants.sql'`, ['0'.repeat(64)]);
    try {
      const bad = await fetch(url);
      expect(bad.status).toBe(503);
      expect(await bad.json()).toEqual({ status: 'not_ready', checks: { database: 'ok', schema: 'fail', privileges: 'ok', reconciliation: 'ok', draining: 'ok' } });
      expect((await fetch(`http://127.0.0.1:${port}/health/live`)).status).toBe(200);
    } finally {
      await db.pool.query(`UPDATE schema_migrations SET checksum = $1 WHERE version = '0002_access_grants.sql'`, [original]);
    }
    expect((await fetch(url)).status).toBe(200);
  });

  it('ready vira 503 quando o runtime ganha privilégio extra em tempo de execução (privileges fail)', async () => {
    const { port } = await start();
    const url = `http://127.0.0.1:${port}/health/ready`;
    expect((await fetch(url)).status).toBe(200);
    await db.pool.query(`GRANT DELETE ON risk_outbox TO ${rt.role}`);
    try {
      const bad = await fetch(url);
      expect(bad.status).toBe(503);
      expect(((await bad.json()) as { checks: Record<string, string> }).checks['privileges']).toBe('fail');
    } finally {
      await db.pool.query(`REVOKE DELETE ON risk_outbox FROM ${rt.role}`);
    }
    expect((await fetch(url)).status).toBe(200);
  });
});

describe.each(['SIGTERM', 'SIGINT'] as const)('desligamento ordenado com %s', (signal) => {
  it('requisições em andamento: ready → 503 (draining), live → 200; processo sai com 0; sem stack', async () => {
    const { port, main } = await start();
    const pendingReady = await openPending(port, '/health/ready');
    const pendingLive = await openPending(port, '/health/live');
    await new Promise((r) => setTimeout(r, 300));
    const exited = main.exited();
    main.child.kill(signal);
    await new Promise((r) => setTimeout(r, 300));
    const [ready, live] = await Promise.all([pendingReady.finish(), pendingLive.finish()]);
    expect(statusLine(ready)).toBe('503');
    expect(bodyOf(ready)).toEqual({ status: 'not_ready', checks: { database: 'ok', schema: 'ok', privileges: 'ok', reconciliation: 'ok', draining: 'fail' } });
    expect(statusLine(live)).toBe('200');
    expect(bodyOf(live)).toEqual({ status: 'live' });
    const result = await Promise.race([exited, new Promise<null>((r) => setTimeout(() => { r(null); }, 15_000))]);
    expect(result).toEqual({ code: 0, signal: null });
    expect(main.stderr()).not.toMatch(STACK);
    expect(main.stderr()).toBe('');
  });

  it('sem requisições em andamento: sai com 0 e deixa de aceitar conexões', async () => {
    const { port, main } = await start();
    const exited = main.exited();
    main.child.kill(signal);
    const result = await Promise.race([exited, new Promise<null>((r) => setTimeout(() => { r(null); }, 15_000))]);
    expect(result).toEqual({ code: 0, signal: null });
    await expect(fetch(`http://127.0.0.1:${port}/health/live`)).rejects.toThrow();
    expect(main.stderr()).toBe('');
  });

  it('não deixa conexões do runtime abertas no banco após a saída (pool encerrado)', async () => {
    const { main } = await start();
    const exited = main.exited();
    main.child.kill(signal);
    expect((await exited).code).toBe(0);
    await new Promise((r) => setTimeout(r, 300));
    const { rows } = await db.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM pg_stat_activity WHERE usename = $1`, [rt.role]);
    expect(rows[0]?.n).toBe('0');
  });
});

describe('main real: nunca sobe com credencial inadequada', () => {
  it('superuser → sai com 1, mensagem fixa, sem escutar', async () => {
    const port = await freePort();
    const main = startNode(dist.httpMain, runtimeEnv({ RISK_DATABASE_URL: db.url, RISK_HTTP_PORT: String(port), RISK_PRINCIPALS_FILE: `${dist.work}/principals.json` }));
    running = main;
    const result = await main.exited();
    expect(result.code).toBe(1);
    expect(main.stderr()).toBe('privilégios do usuário de runtime excedem o mínimo ou não puderam ser verificados; servidor não iniciado\n');
    await expect(fetch(`http://127.0.0.1:${port}/health/live`)).rejects.toThrow();
  });

  it('credencial de migração no ambiente do servidor → sai com 2 (ConfigError, igual à CLI), sem escutar', async () => {
    const port = await freePort();
    const main = startNode(
      dist.httpMain,
      runtimeEnv({ RISK_DATABASE_URL: rt.url, RISK_MIGRATION_DATABASE_URL: db.url, RISK_HTTP_PORT: String(port), RISK_PRINCIPALS_FILE: `${dist.work}/principals.json` }),
    );
    running = main;
    expect((await main.exited()).code).toBe(2);
    expect(main.stderr()).toBe('credencial de migração não pertence ao ambiente de runtime\n');
    expect(main.stderr()).not.toContain(new URL(db.url).password);
  });

  // Erros de CONFIGURAÇÃO saem com 2 (igual à CLI); privilégio, banco e listen saem com 1 (testes acima e em mainListenError).
  it.each([
    ['RISK_HTTP_ENABLED inválido', { RISK_HTTP_ENABLED: 'talvez' }],
    ['RISK_HTTP_ENABLED=false (servidor não deve subir)', { RISK_HTTP_ENABLED: 'false' }],
    ['RISK_ENVIRONMENT ≠ PAPER', { RISK_ENVIRONMENT: 'LIVE' }],
    ['credencial de exchange no ambiente', { BINANCE_API_KEY: 'valor-fixture' }],
    ['arquivo de principais inexistente', { RISK_PRINCIPALS_FILE: '/nao/existe/principals.json' }],
  ])('%s → exit 2, mensagem fixa, sem stack nem segredo', async (_label, extra) => {
    const port = await freePort();
    const r = await runNode(
      dist.httpMain,
      [],
      runtimeEnv({ RISK_DATABASE_URL: rt.url, RISK_HTTP_PORT: String(port), RISK_PRINCIPALS_FILE: `${dist.work}/principals.json`, ...extra }),
    );
    expect(r.code).toBe(2);
    expect(r.stderr).not.toMatch(STACK);
    expect(r.stderr).not.toContain(new URL(rt.url).password);
    expect(r.stderr).not.toContain('valor-fixture');
    expect(r.stdout).not.toContain('http.listening');
  });

  it('arquivo de principais com JSON inválido → exit 2 sem ecoar o conteúdo', async () => {
    const port = await freePort();
    const file = `${dist.work}/principals-invalido.json`;
    writeFileSync(file, '{"version":1,"principals":"segredo-fixture-no-arquivo"');
    const r = await runNode(dist.httpMain, [], runtimeEnv({ RISK_DATABASE_URL: rt.url, RISK_HTTP_PORT: String(port), RISK_PRINCIPALS_FILE: file }));
    expect(r.code).toBe(2);
    expect(r.stderr).not.toContain('segredo-fixture-no-arquivo');
    expect(r.stderr).not.toMatch(STACK);
  });
});

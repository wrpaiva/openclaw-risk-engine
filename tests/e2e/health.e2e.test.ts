import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acquireSuiteLock, appDbDeadlines, call, docker, dockerRun, e2eEnv, startApp, waitFor, waitDatabaseUp, withDatabasePaused, withDatabaseRefusing } from './support/env.js';

// T5 — saúde da IMAGEM real (SPEC §9.4 item 6 e 10; ADR-0009; notas 2.5). Camada (a): app pela imagem, runtime de verdade.
// Invariantes: I-05 (falha de dependência => nenhuma autorização; aqui: ready fecha). Lacunas: o Docker não roda o
// healthcheck com intervalo no teste (só o comando é executado); sem orquestrador (Swarm) por decisão da etapa.
const env = e2eEnv();
let release: () => void;
beforeAll(async () => {
  release = await acquireSuiteLock();
  await startApp();
});
afterAll(() => {
  release();
});

const READY_OK = { status: 'ready', checks: { database: 'ok', schema: 'ok', privileges: 'ok', reconciliation: 'ok', draining: 'ok' } };

describe('saúde pela imagem', () => {
  it('live 200 e ready 200 sem autenticação, corpos fixos e no-store; sem versão/hostname', async () => {
    const live = await call(env.baseUrl, 'GET', '/health/live', null);
    expect(live.status).toBe(200);
    expect(live.json).toEqual({ status: 'live' });
    expect(live.headers.get('cache-control')).toBe('no-store');
    const ready = await call(env.baseUrl, 'GET', '/health/ready', null);
    expect(ready.status).toBe(200);
    expect(ready.json).toEqual(READY_OK);
    expect(ready.headers.get('cache-control')).toBe('no-store');
    expect(ready.text).not.toMatch(/version|host|postgres|e2e_runtime|openclaw_risk/i);
  });

  it('métodos diferentes de GET → 405; caminho desconhecido → 404; nada autorizado', async () => {
    for (const path of ['/health/live', '/health/ready']) {
      const r = await call(env.baseUrl, 'POST', path, null, {});
      expect(r.status).toBe(405);
      expect(r.headers.get('allow')).toBe('GET');
    }
    expect((await call(env.baseUrl, 'GET', '/health/other', null)).status).toBe(404);
    expect((await call(env.baseUrl, 'GET', '/health', null)).status).toBe(404);
  });

  it('o comando do HEALTHCHECK da imagem sai 0 dentro do contêiner em execução', () => {
    const r = dockerRun(['exec', env.appContainer, 'node', 'dist/interfaces/cli/main.js', 'healthcheck']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('live');
  });

  it('banco recusando conexões: ready → 503 (database fail), live continua 200; ao voltar, ready → 200', async () => {
    await withDatabaseRefusing(async () => {
      await waitFor('ready 503', async () => (await call(env.baseUrl, 'GET', '/health/ready', null)).status === 503, 30_000);
      const ready = await call(env.baseUrl, 'GET', '/health/ready', null);
      expect(ready.status).toBe(503);
      expect(ready.json).toMatchObject({ status: 'not_ready', checks: { database: 'fail' } });
      expect(ready.text).not.toMatch(/ECONNREFUSED|postgres|password|at .*\(/i);
      expect((await call(env.baseUrl, 'GET', '/health/live', null)).status).toBe(200);
    });
    await waitDatabaseUp();
    await waitFor('ready volta a 200', async () => (await call(env.baseUrl, 'GET', '/health/ready', null)).status === 200, 30_000);
    expect((await call(env.baseUrl, 'GET', '/health/ready', null)).json).toEqual(READY_OK);
  });

  it('banco congelado (docker pause): ready nunca devolve 200 e live segue 200; ao descongelar, ready volta a 200', async () => {
    await withDatabasePaused(async () => {
      const r = await call(env.baseUrl, 'GET', '/health/ready', null, undefined, 8000);
      // Fail-closed: 503 ou nenhuma resposta (status 0). Jamais 200.
      expect([0, 503]).toContain(r.status);
      expect((await call(env.baseUrl, 'GET', '/health/live', null)).status).toBe(200);
    });
    await waitFor('ready volta a 200', async () => (await call(env.baseUrl, 'GET', '/health/ready', null)).status === 200, 90_000);
  });

  // Prazo do cliente (clientLease.ts): cada verificação da readiness tem no máximo CONNECTION + STATEMENT timeout. Com o banco
  // congelado a resposta é 503 (nunca 200, nunca pendura); o teto é derivado dos timeouts configurados em scripts/test-e2e.sh.
  it('banco congelado: ready responde 503 (database fail) em tempo finito, abaixo de um teto derivado dos timeouts configurados', async () => {
    const { commandMs } = appDbDeadlines();
    const slackMs = 5000;
    await withDatabasePaused(async () => {
      for (let i = 0; i < 2; i += 1) {
        const started = Date.now();
        const r = await call(env.baseUrl, 'GET', '/health/ready', null, undefined, commandMs + slackMs + 5000);
        const elapsed = Date.now() - started;
        expect(r.status, `tentativa ${i}`).toBe(503);
        expect(r.json).toMatchObject({ status: 'not_ready', checks: { database: 'fail', schema: 'fail', reconciliation: 'fail' } });
        expect(r.text).not.toMatch(/timeout|prazo|ECONN|postgres|password|at .*\(/i);
        expect(elapsed, `tentativa ${i}`).toBeLessThan(commandMs + slackMs);
      }
      expect((await call(env.baseUrl, 'GET', '/health/live', null)).status).toBe(200);
    });
    await waitFor('ready volta a 200', async () => (await call(env.baseUrl, 'GET', '/health/ready', null)).status === 200, 90_000);
    expect((await call(env.baseUrl, 'GET', '/health/ready', null)).json).toEqual(READY_OK);
  });

  it('a app segue de pé após a oscilação (sem reinício do contêiner)', () => {
    expect(docker(['inspect', '--format', '{{.State.Running}} {{.RestartCount}}', env.appContainer]).trim()).toBe('true 0');
  });
});

import { hostname } from 'node:os';
import { connect } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CheckReadinessResult } from '../../src/application/CheckReadiness.js';
import { resolveRoute } from '../../src/interfaces/http/router.js';
import { startServer, type TestServer } from './support.js';

// Rotas de saúde (etapa 2.5). Tudo FICTÍCIO; nenhum banco: readiness é um dublê.
const OK = { database: 'OK', schema: 'OK', privileges: 'OK', reconciliation: 'OK' } as const;
const KEYS = ['database', 'schema', 'privileges', 'reconciliation'] as const;
const result = (checks: Partial<Record<(typeof KEYS)[number], 'OK' | 'FAIL'>> = {}, ready?: boolean): CheckReadinessResult => {
  const merged = { ...OK, ...checks };
  return { ready: ready ?? Object.values(merged).every((v) => v === 'OK'), checks: merged };
};

let srv: TestServer | undefined;
afterEach(async () => {
  await srv?.close();
  srv = undefined;
});

const getJson = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`${srv?.url ?? ''}${path}`, init);
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, json: text === '' ? null : (JSON.parse(text) as Record<string, unknown>) };
};
const requestLogs = () => srv?.logger.entries.filter((e) => e.event === 'http.request') ?? [];

describe('GET /health/live', () => {
  it('200 sem autenticação, sem readiness e sem banco', async () => {
    srv = await startServer();
    const r = await getJson('/health/live');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ status: 'live' });
    for (const uc of [srv.evaluate, srv.consume, srv.release, srv.getDecision]) expect(uc).not.toHaveBeenCalled();
  });

  it('200 mesmo em draining e com readiness que lança', async () => {
    const execute = vi.fn(() => Promise.reject(new Error('banco-fora-segredo')));
    srv = await startServer({ readiness: { execute }, isDraining: () => true });
    expect((await getJson('/health/live')).status).toBe(200);
    expect(execute).not.toHaveBeenCalled();
  });

  it('200 mesmo com isDraining que lança', async () => {
    srv = await startServer({
      isDraining: () => {
        throw new Error('boom');
      },
    });
    expect((await getJson('/health/live')).status).toBe(200);
  });

  it('cabeçalho Authorization inválido não altera nada (isenção, não autenticação)', async () => {
    srv = await startServer();
    expect((await getJson('/health/live', { headers: { Authorization: 'Bearer errado' } })).status).toBe(200);
  });

  it('query string é ignorada; variações de caminho são 404', async () => {
    srv = await startServer();
    expect((await getJson('/health/live?x=1')).status).toBe(200);
    for (const path of ['/health/live/', '/health/live/extra', '/Health/live', '/health', '/health/liveness', '/health/%6Cive']) {
      expect((await getJson(path)).status, path).toBe(404);
    }
  });
});

describe('GET /health/ready', () => {
  it('todas as verificações OK e sem draining → 200', async () => {
    srv = await startServer({ readiness: { execute: vi.fn(() => Promise.resolve(result())) }, isDraining: () => false });
    const r = await getJson('/health/ready');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ status: 'ready', checks: { database: 'ok', schema: 'ok', privileges: 'ok', reconciliation: 'ok', draining: 'ok' } });
  });

  it.each(KEYS)('falha em %s → 503 apontando só essa verificação', async (check) => {
    srv = await startServer({ readiness: { execute: vi.fn(() => Promise.resolve(result({ [check]: 'FAIL' }))) }, isDraining: () => false });
    const r = await getJson('/health/ready');
    expect(r.status).toBe(503);
    const checks = (r.json?.['checks'] ?? {}) as Record<string, string>;
    expect(r.json?.['status']).toBe('not_ready');
    expect(checks[check]).toBe('fail');
    for (const other of KEYS.filter((c) => c !== check)) expect(checks[other], other).toBe('ok');
  });

  it('draining → 503 com draining=fail, mesmo com tudo OK', async () => {
    srv = await startServer({ readiness: { execute: vi.fn(() => Promise.resolve(result())) }, isDraining: () => true });
    const r = await getJson('/health/ready');
    expect(r.status).toBe(503);
    expect(r.json).toEqual({ status: 'not_ready', checks: { database: 'ok', schema: 'ok', privileges: 'ok', reconciliation: 'ok', draining: 'fail' } });
  });

  it('transição de draining muda 200 → 503 sem reiniciar', async () => {
    let draining = false;
    srv = await startServer({ readiness: { execute: vi.fn(() => Promise.resolve(result())) }, isDraining: () => draining });
    expect((await getJson('/health/ready')).status).toBe(200);
    draining = true;
    expect((await getJson('/health/ready')).status).toBe(503);
    expect((await getJson('/health/live')).status).toBe(200);
  });

  it('readiness ausente → 503 (fail-closed), todas as verificações em fail', async () => {
    srv = await startServer();
    const r = await getJson('/health/ready');
    expect(r.status).toBe(503);
    expect(r.json).toEqual({ status: 'not_ready', checks: { database: 'fail', schema: 'fail', privileges: 'fail', reconciliation: 'fail', draining: 'ok' } });
  });

  it('readiness que lança (síncrono ou assíncrono) → 503 sem vazar a mensagem', async () => {
    for (const execute of [
      vi.fn(() => Promise.reject(new Error('senha=hunter2 host=db-interno'))),
      vi.fn(() => {
        throw new Error('senha=hunter2 host=db-interno');
      }),
    ]) {
      srv = await startServer({ readiness: { execute: execute }, isDraining: () => false });
      const r = await getJson('/health/ready');
      expect(r.status).toBe(503);
      expect(r.text).not.toMatch(/hunter2|db-interno/);
      expect(JSON.stringify(srv.logger.entries)).not.toMatch(/hunter2|db-interno/);
      await srv.close();
      srv = undefined;
    }
  });

  it('isDraining que lança → 503 (trata como drenando)', async () => {
    srv = await startServer({
      readiness: { execute: vi.fn(() => Promise.resolve(result())) },
      isDraining: () => {
        throw new Error('boom');
      },
    });
    const r = await getJson('/health/ready');
    expect(r.status).toBe(503);
    expect((r.json?.['checks'] as Record<string, string>)['draining']).toBe('fail');
  });

  it('resultado incoerente nunca vira 200: ready=true com check FAIL, e ready=false com tudo OK', async () => {
    srv = await startServer({ readiness: { execute: vi.fn(() => Promise.resolve(result({ schema: 'FAIL' }, true))) } });
    expect((await getJson('/health/ready')).status).toBe(503);
    await srv.close();
    srv = await startServer({ readiness: { execute: vi.fn(() => Promise.resolve(result({}, false))) } });
    expect((await getJson('/health/ready')).status).toBe(503);
  });

  it('reconciliation ausente no resultado (ready=true) nunca produz 200', async () => {
    const partial = { ready: true, checks: { database: 'OK', schema: 'OK', privileges: 'OK' } };
    srv = await startServer({ readiness: { execute: vi.fn(() => Promise.resolve(partial)) as never } });
    const r = await getJson('/health/ready');
    expect(r.status).toBe(503);
    expect((r.json?.['checks'] as Record<string, string>)['reconciliation']).toBe('fail');
  });

  it('valores inesperados em checks (não OK) nunca produzem 200', async () => {
    const weird = { ready: true, checks: { database: 'OK', schema: 'OK', privileges: 'OK', reconciliation: 'MAYBE' } };
    srv = await startServer({ readiness: { execute: vi.fn(() => Promise.resolve(weird)) as never } });
    expect((await getJson('/health/ready')).status).toBe(503);
  });
});

describe('contrato comum das rotas de saúde', () => {
  it('Cache-Control: no-store em 200, 503 e 405', async () => {
    srv = await startServer({ readiness: { execute: vi.fn(() => Promise.resolve(result({ database: 'FAIL' }))) } });
    for (const [path, init, status] of [
      ['/health/live', {}, 200],
      ['/health/ready', {}, 503],
      ['/health/live', { method: 'POST' }, 405],
    ] as const) {
      const r = await getJson(path, init);
      expect(r.status).toBe(status);
      expect(r.headers.get('cache-control'), `${init.constructor.name} ${path}`).toBe('no-store');
    }
  });

  it.each(['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'])('%s em /health/live e /health/ready → 405 com Allow: GET', async (method) => {
    const execute = vi.fn(() => Promise.resolve(result()));
    srv = await startServer({ readiness: { execute } });
    for (const path of ['/health/live', '/health/ready']) {
      const res = await fetch(`${srv.url}${path}`, { method, ...(method === 'HEAD' ? {} : { body: '{}', headers: { 'Content-Type': 'application/json' } }) });
      expect(res.status, `${method} ${path}`).toBe(405);
      expect(res.headers.get('allow')).toBe('GET');
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('corpo fixo: sem versão, hostname, mensagens de erro, stack ou nomes de objetos', async () => {
    srv = await startServer({
      readiness: { execute: vi.fn(() => Promise.reject(Object.assign(new Error('relation risk_decisions does not exist'), { code: '42P01' }))) },
    });
    for (const path of ['/health/live', '/health/ready']) {
      const r = await getJson(path);
      expect(r.text.toLowerCase(), path).not.toMatch(/version|versão|uptime|node|v\d+\.\d+|stack|error|erro|risk_|42p01|postgres|\bat\b.*\(/);
      expect(r.text, path).not.toContain(hostname());
      expect(Object.keys(r.json ?? {}).sort()).toEqual(path.endsWith('live') ? ['status'] : ['checks', 'status']);
    }
    expect(Object.keys((await getJson('/health/ready')).json?.['checks'] as object).sort()).toEqual(['database', 'draining', 'privileges', 'reconciliation', 'schema']);
  });

  it('corpo grande não é lido: GET com Content-Length enorme e sem corpo responde mesmo assim', async () => {
    srv = await startServer({ readiness: { execute: vi.fn(() => Promise.resolve(result())) } });
    for (const [path, status] of [['/health/live', 200], ['/health/ready', 200]] as const) {
      const response = await new Promise<string>((resolve, reject) => {
        const socket = connect(srv?.port ?? 0, '127.0.0.1');
        let data = '';
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new Error('servidor ficou esperando o corpo'));
        }, 3000);
        socket.on('data', (d: Buffer) => {
          data += d.toString();
          if (data.includes('\r\n\r\n')) {
            clearTimeout(timer);
            socket.destroy();
            resolve(data);
          }
        });
        socket.on('error', () => undefined);
        socket.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nContent-Length: 999999999\r\nConnection: close\r\n\r\n`);
      });
      expect(response.startsWith(`HTTP/1.1 ${status}`), path).toBe(true);
    }
  });

  it('log http.request só para respostas diferentes de 200', async () => {
    let ready = true;
    srv = await startServer({ readiness: { execute: vi.fn(() => Promise.resolve(ready ? result() : result({ database: 'FAIL' }))) } });
    await getJson('/health/live');
    await getJson('/health/ready');
    expect(requestLogs()).toEqual([]);
    ready = false;
    await getJson('/health/ready');
    await getJson('/health/live', { method: 'POST' });
    const logs = requestLogs();
    expect(logs.map((l) => [l.fields.route, l.fields.httpStatus])).toEqual([
      ['GET /health/ready', 503],
      ['UNMATCHED', 405],
    ]);
    expect(logs[0]?.level).toBe('error');
    expect(logs[1]?.level).toBe('info');
  });

  it('rotas de saúde não disparam nenhum caso de uso de risco', async () => {
    srv = await startServer({ readiness: { execute: vi.fn(() => Promise.resolve(result())) } });
    await getJson('/health/live');
    await getJson('/health/ready');
    for (const uc of [srv.evaluate, srv.consume, srv.release, srv.getDecision]) expect(uc).not.toHaveBeenCalled();
  });
});

describe('isenção de autenticação restrita às rotas de saúde', () => {
  const PROBES: readonly (readonly [string, string])[] = [
    ['POST', '/v1/risk/evaluations'],
    ['GET', '/v1/risk/decisions/abc'],
    ['POST', '/v1/risk/authorizations/abc/consume'],
    ['POST', '/v1/risk/reservations/abc/release'],
  ];

  it('roteador: auth NONE somente em live e ready; as demais exigem REQUIRED', () => {
    for (const [method, path] of PROBES) {
      const m = resolveRoute(method, path);
      expect(m.kind).toBe('FOUND');
      if (m.kind === 'FOUND') expect(m.route.auth, path).toBe('REQUIRED');
    }
    for (const path of ['/health/live', '/health/ready']) {
      const m = resolveRoute('GET', path);
      expect(m.kind === 'FOUND' && m.route.auth).toBe('NONE');
    }
  });

  it('nenhum caminho fora de /health/(live|ready) resolve com auth NONE (varredura de variações)', () => {
    const paths = ['/health', '/health/', '/health/live/', '/v1/health/live', '/v1/risk/health/live', '//health/live', '/health/live%00', '/health/ready/x', '/HEALTH/READY', '/'];
    for (const p of paths) {
      for (const method of ['GET', 'POST', 'PUT', 'HEAD']) {
        const m = resolveRoute(method, p);
        expect(m.kind === 'FOUND' && m.route.auth === 'NONE', `${method} ${p}`).toBe(false);
      }
    }
  });

  it('rotas /v1 sem credencial seguem 401 e não chamam o caso de uso', async () => {
    srv = await startServer({ readiness: { execute: vi.fn(() => Promise.resolve(result())) } });
    for (const [method, path] of PROBES) {
      const res = await fetch(`${srv.url}${path}`, { method, ...(method === 'POST' ? { body: '{}', headers: { 'Content-Type': 'application/json' } } : {}) });
      expect(res.status, path).toBe(401);
    }
    for (const uc of [srv.evaluate, srv.consume, srv.release, srv.getDecision]) expect(uc).not.toHaveBeenCalled();
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_TOKEN, DECISION_ID, EXECUTOR_TOKEN, fakeDecision, HASH, RESERVATION_ID, startServer, type TestServer } from './support.js';

// Etapa 2.4 (M2/B1): kind inesperado vira 500 sem conexão pendurada; níveis e conteúdo dos logs.
let s: TestServer;
beforeAll(async () => {
  s = await startServer();
});
afterAll(async () => s.close());
beforeEach(() => {
  for (const f of [s.evaluate, s.consume, s.release, s.getDecision]) {
    f.mockReset();
    f.mockResolvedValue({ kind: 'UNAVAILABLE' });
  }
  s.logger.entries.length = 0;
});

const SECRET_MARKER = 'segredo-corpo-fixture-xyz';
const proposalBody = { marker: SECRET_MARKER };
const consumeBody = { accountId: 'paper-fixture', paperOrderId: 'order-1', proposalHash: HASH };

interface Req {
  path: string;
  token: string;
  body?: unknown;
  method?: string;
}
const send = async (r: Req) => {
  const res = await fetch(s.url + r.path, {
    method: r.method ?? (r.body === undefined ? 'GET' : 'POST'),
    headers: { Authorization: `Bearer ${r.token}`, ...(r.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: r.body === undefined ? undefined : JSON.stringify(r.body),
    signal: AbortSignal.timeout(3000), // conexão pendurada falharia aqui
  });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as { error?: { code?: string; requestId?: string } } };
};

const R_EVAL: Req = { path: '/v1/risk/evaluations', token: AGENT_TOKEN, body: proposalBody };
const R_GET: Req = { path: `/v1/risk/decisions/${DECISION_ID}`, token: AGENT_TOKEN };
const R_CONSUME: Req = { path: `/v1/risk/authorizations/${DECISION_ID}/consume`, token: EXECUTOR_TOKEN, body: consumeBody };
const R_RELEASE: Req = { path: `/v1/risk/reservations/${RESERVATION_ID}/release`, token: EXECUTOR_TOKEN, body: { reason: 'x' } };
const ROUTES: readonly { name: string; stub: () => TestServer['evaluate']; req: Req }[] = [
  { name: 'evaluate', stub: () => s.evaluate, req: R_EVAL },
  { name: 'getDecision', stub: () => s.getDecision, req: R_GET },
  { name: 'consume', stub: () => s.consume, req: R_CONSUME },
  { name: 'release', stub: () => s.release, req: R_RELEASE },
];
const BAD_RESULTS: readonly [string, unknown][] = [
  ['kind desconhecido', { kind: 'NOVO_KIND_FUTURO' }],
  ['undefined', undefined],
  ['null', null],
  ['objeto sem kind', {}],
];

describe('M2/B1: resultado inesperado do caso de uso → 500 INTERNAL_ERROR', () => {
  for (const route of ROUTES) {
    it.each(BAD_RESULTS)(`${route.name}: %s`, async (_label, bad) => {
      route.stub().mockResolvedValue(bad);
      const r = await send(route.req);
      expect(r.status).toBe(500);
      expect(r.json.error?.code).toBe('INTERNAL_ERROR');
      expect(r.text).not.toContain('ALLOW_PAPER');
      expect(r.text).not.toContain(SECRET_MARKER);

      const internal = s.logger.entries.filter((e) => e.event === 'http.internal_error');
      expect(internal.length).toBeGreaterThanOrEqual(1);
      for (const e of internal) {
        expect(e.level).toBe('error');
        // Só errorKind (mais requestId/route); nunca mensagem, corpo ou token.
        expect(Object.keys(e.fields).sort()).toEqual(['errorKind', 'requestId', 'route']);
        expect(typeof e.fields.errorKind).toBe('string');
      }
      const request = s.logger.entries.filter((e) => e.event === 'http.request');
      expect(request).toHaveLength(1);
      expect(request[0]?.level).toBe('error');
      expect(request[0]?.fields.httpStatus).toBe(500);
    });
  }

  it.each([['kind desconhecido', { kind: 'NOVO_KIND_FUTURO' }], ['objeto sem kind', {}]])('getDecision: %s → 500', async (_l, bad) => {
    s.getDecision.mockResolvedValue(bad);
    const r = await send(R_GET);
    expect(r.status).toBe(500);
    expect(s.logger.entries.some((e) => e.event === 'http.internal_error')).toBe(true);
  });

  it('caso de uso que lança (Error e valor não-Error) → 500 e só errorKind no log', async () => {
    s.evaluate.mockRejectedValue(new Error(`falha com ${SECRET_MARKER} e Bearer ${AGENT_TOKEN}`));
    const a = await send(R_EVAL);
    expect(a.status).toBe(500);
    s.consume.mockRejectedValue('texto solto');
    const b = await send(R_CONSUME);
    expect(b.status).toBe(500);
    const kinds = s.logger.entries.filter((e) => e.event === 'http.internal_error').map((e) => e.fields.errorKind);
    expect(kinds).toEqual(['Error', 'NonError']);
    const logs = JSON.stringify(s.logger.entries);
    expect(logs).not.toContain(SECRET_MARKER);
    expect(logs).not.toContain(AGENT_TOKEN);
  });

  it('resposta nunca é 200 com decisão ALLOW_PAPER quando o kind é inesperado', async () => {
    s.evaluate.mockResolvedValue({ kind: 'DECISION_V2', decision: fakeDecision({ status: 'ALLOW_PAPER' }) });
    const r = await send(R_EVAL);
    expect(r.status).toBe(500);
    expect(r.text).not.toContain('ALLOW_PAPER');
  });
});

describe('níveis de log do http.request', () => {
  const level = () => s.logger.entries.filter((e) => e.event === 'http.request').map((e) => [e.level, e.fields.httpStatus]);

  it('200 → info', async () => {
    s.getDecision.mockResolvedValue({ kind: 'FOUND', decision: fakeDecision() });
    expect((await send(R_GET)).status).toBe(200);
    expect(level()).toEqual([['info', 200]]);
  });
  it('404 → info', async () => {
    s.getDecision.mockResolvedValue({ kind: 'NOT_FOUND' });
    expect((await send(R_GET)).status).toBe(404);
    expect(level()).toEqual([['info', 404]]);
  });
  it('409 → info', async () => {
    s.consume.mockResolvedValue({ kind: 'CONFLICT' });
    expect((await send(R_CONSUME)).status).toBe(409);
    expect(level()).toEqual([['info', 409]]);
  });
  it('422 → info', async () => {
    expect((await send({ ...R_CONSUME, body: { accountId: 'x' } })).status).toBe(422);
    expect(level()).toEqual([['info', 422]]);
  });
  it('401 → warn', async () => {
    expect((await send({ ...R_GET, token: 'tok-invalido' })).status).toBe(401);
    expect(level()).toEqual([['warn', 401]]);
  });
  it('403 por papel errado → warn', async () => {
    expect((await send({ ...R_EVAL, token: EXECUTOR_TOKEN })).status).toBe(403);
    expect(level()).toEqual([['warn', 403]]);
  });
  it('403 devolvido pelo caso de uso → warn', async () => {
    s.consume.mockResolvedValue({ kind: 'FORBIDDEN' });
    expect((await send(R_CONSUME)).status).toBe(403);
    expect(level()).toEqual([['warn', 403]]);
  });
  it('503 → error', async () => {
    expect((await send(R_GET)).status).toBe(503);
    expect(level()).toEqual([['error', 503]]);
  });
  it('500 → error', async () => {
    s.release.mockResolvedValue({ kind: '???' });
    expect((await send(R_RELEASE)).status).toBe(500);
    expect(level()).toEqual([['error', 500]]);
  });
});

describe('logs nunca carregam token, Authorization nem corpo', () => {
  it('em respostas 200, 401, 403, 422, 500 e 503', async () => {
    s.getDecision.mockResolvedValue({ kind: 'FOUND', decision: fakeDecision() });
    await send(R_GET);
    await send({ ...R_GET, token: 'tok-vazado-fixture-9' });
    await send({ ...R_EVAL, token: EXECUTOR_TOKEN });
    await send({ ...R_CONSUME, body: { ...consumeBody, extra: SECRET_MARKER } });
    s.evaluate.mockResolvedValue({ kind: 'ZZZ' });
    await send(R_EVAL);
    s.release.mockResolvedValue({ kind: 'UNAVAILABLE' });
    await send(R_RELEASE);
    const logs = JSON.stringify(s.logger.entries);
    expect(s.logger.entries.length).toBeGreaterThan(5);
    for (const secret of [AGENT_TOKEN, EXECUTOR_TOKEN, 'tok-vazado-fixture-9', SECRET_MARKER, 'Bearer', 'Authorization', HASH]) {
      expect(logs).not.toContain(secret);
    }
  });
});

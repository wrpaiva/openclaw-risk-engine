import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_ID,
  AGENT_TOKEN,
  DECISION_ID,
  EXECUTOR_ID,
  EXECUTOR_TOKEN,
  fakeDecision,
  HASH,
  LIMITS,
  RESERVATION_ID,
  startServer,
  type TestServer,
} from './support.js';

let s: TestServer;
const responses: string[] = []; // todo corpo de resposta visto, para a checagem de vazamento
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

interface Call {
  method?: string;
  path: string;
  token?: string | null;
  authorization?: string;
  headers?: Record<string, string>;
  body?: unknown;
  rawBody?: string;
}
async function call(c: Call) {
  const headers: Record<string, string> = { ...c.headers };
  const auth = c.authorization ?? (c.token === null ? undefined : `Bearer ${c.token ?? AGENT_TOKEN}`);
  if (auth !== undefined) headers['Authorization'] = auth;
  const hasBody = c.body !== undefined || c.rawBody !== undefined;
  if (hasBody && !('Content-Type' in headers)) headers['Content-Type'] = 'application/json';
  const res = await fetch(s.url + c.path, {
    method: c.method ?? (hasBody ? 'POST' : 'GET'),
    headers,
    ...(hasBody ? { body: c.rawBody ?? JSON.stringify(c.body) } : {}),
  });
  const text = await res.text();
  responses.push(text);
  let json: { error?: { code?: string; requestId?: string; [k: string]: unknown } } & Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as typeof json;
  } catch {
    /* corpo não JSON */
  }
  return { status: res.status, headers: res.headers, text, json };
}

const EVAL = '/v1/risk/evaluations';
const CONSUME = `/v1/risk/authorizations/${DECISION_ID}/consume`;
const RELEASE = `/v1/risk/reservations/${RESERVATION_ID}/release`;
const GET = `/v1/risk/decisions/${DECISION_ID}`;
const consumeBody = { accountId: 'paper-fixture', paperOrderId: 'order-1', proposalHash: HASH };
const noCalls = () => {
  for (const f of [s.evaluate, s.consume, s.release, s.getDecision]) expect(f).not.toHaveBeenCalled();
};

describe('roteamento: 404 e 405', () => {
  it.each(['/', '/v1', '/v1/risk', '/v1/risk/evaluations/extra', '/v2/risk/evaluations', '/v1/risk/decisions/', '/v1/risk/decisions/a%2Fb', '/v1/risk/decisions/' + 'x'.repeat(129)])(
    '%s → 404 mesmo sem token (rota antes de autenticação)',
    async (path) => {
      const r = await call({ path, token: null });
      expect(r.status).toBe(404);
      expect(r.json.error?.code).toBe('NOT_FOUND');
      noCalls();
    },
  );

  it.each([
    ['GET', EVAL, 'POST'],
    ['PUT', EVAL, 'POST'],
    ['POST', GET, 'GET'],
    ['DELETE', GET, 'GET'],
    ['GET', CONSUME, 'POST'],
    ['GET', RELEASE, 'POST'],
  ])('%s %s → 405 com Allow: %s', async (method, path, allow) => {
    const r = await call({ method, path });
    expect(r.status).toBe(405);
    expect(r.headers.get('allow')).toBe(allow);
    noCalls();
  });

  it('query string não muda a rota', async () => {
    s.getDecision.mockResolvedValue({ kind: 'NOT_FOUND' });
    expect((await call({ path: `${GET}?x=1` })).status).toBe(404);
    expect(s.getDecision).toHaveBeenCalledOnce();
  });
});

describe('autenticação: 401', () => {
  it.each([
    ['sem header', { token: null }],
    ['token desconhecido', { token: 'desconhecido' }],
    ['token vazio', { authorization: 'Bearer ' }],
    ['esquema minúsculo', { authorization: `bearer ${AGENT_TOKEN}` }],
    ['esquema Basic', { authorization: `Basic ${AGENT_TOKEN}` }],
    ['sem esquema', { authorization: AGENT_TOKEN }],
    ['dois espaços', { authorization: `Bearer  ${AGENT_TOKEN}` }],
    ['token com sufixo', { authorization: `Bearer ${AGENT_TOKEN} extra` }],
    ['token com sufixo colado', { authorization: `Bearer ${AGENT_TOKEN}x` }],
    ['token com 513 caracteres', { authorization: `Bearer ${'a'.repeat(513)}` }],
    ['token com caractere fora do conjunto', { authorization: `Bearer ${AGENT_TOKEN}!` }],
  ] as const)('%s', async (_l, c) => {
    const r = await call({ path: EVAL, body: { x: 1 }, ...c });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toBe('Bearer');
    expect(r.json.error?.code).toBe('UNAUTHENTICATED');
    noCalls();
  });

  it('autenticador que lança → 401, sem vazar', async () => {
    const t = await startServer({
      authenticator: {
        authenticate: () => {
          throw new Error(`explodiu com ${AGENT_TOKEN}`);
        },
      },
    });
    try {
      const res = await fetch(`${t.url}${EVAL}`, { method: 'POST', headers: { Authorization: `Bearer ${AGENT_TOKEN}`, 'Content-Type': 'application/json' }, body: '{}' });
      const text = await res.text();
      expect(res.status).toBe(401);
      expect(text).not.toContain(AGENT_TOKEN);
      expect(JSON.stringify(t.logger.entries)).not.toContain(AGENT_TOKEN);
      expect(t.evaluate).not.toHaveBeenCalled();
    } finally {
      await t.close();
    }
  });

  it('corpo enorme sem token → 401 sem ler o corpo e sem chamar casos de uso', async () => {
    const r = await call({ path: EVAL, token: null, rawBody: 'x'.repeat(5 * 1024 * 1024) });
    expect(r.status).toBe(401);
    noCalls();
  });

  it('GET de decisão sem token → 401', async () => {
    expect((await call({ path: GET, token: null })).status).toBe(401);
    noCalls();
  });
});

describe('papel: 403', () => {
  it.each([
    ['AGENT em consume', CONSUME, AGENT_TOKEN, consumeBody],
    ['AGENT em release', RELEASE, AGENT_TOKEN, { reason: 'x' }],
    ['executor em evaluations', EVAL, EXECUTOR_TOKEN, {}],
  ])('%s', async (_l, path, token, body) => {
    const r = await call({ path, token, body });
    expect(r.status).toBe(403);
    expect(r.json.error?.code).toBe('FORBIDDEN');
    expect(s.logger.entries.some((e) => e.event === 'http.forbidden' && e.fields.outcome === 'WRONG_ROLE')).toBe(true);
    noCalls();
  });

  it('403 por papel vem antes de validar Content-Type e corpo', async () => {
    const r = await call({ path: CONSUME, token: AGENT_TOKEN, rawBody: 'não é json', headers: { 'Content-Type': 'text/plain' } });
    expect(r.status).toBe(403);
    noCalls();
  });

  it('GET de decisão é permitido a AGENT e a executor', async () => {
    s.getDecision.mockResolvedValue({ kind: 'NOT_FOUND' });
    expect((await call({ path: GET, token: AGENT_TOKEN })).status).toBe(404);
    expect((await call({ path: GET, token: EXECUTOR_TOKEN })).status).toBe(404);
    expect(s.getDecision).toHaveBeenCalledTimes(2);
  });
});

describe('Connection: close em erros antes da leitura do corpo de POST', () => {
  it.each([
    ['401', { path: EVAL, token: null, body: {} }],
    ['403', { path: CONSUME, token: AGENT_TOKEN, body: consumeBody }],
    ['400 Content-Type', { path: EVAL, rawBody: '{}', headers: { 'Content-Type': 'text/plain' } }],
  ] as const)('%s', async (_l, c) => {
    const r = await call(c);
    expect([401, 403, 400]).toContain(r.status);
    expect(r.headers.get('connection')).toBe('close');
    noCalls();
  });

  it('ids não-UUID chegam ao caso de uso e o 404 dele é repassado', async () => {
    s.consume.mockResolvedValue({ kind: 'NOT_FOUND' });
    s.release.mockResolvedValue({ kind: 'NOT_FOUND' });
    expect((await call({ path: '/v1/risk/authorizations/nao-uuid/consume', token: EXECUTOR_TOKEN, body: consumeBody })).status).toBe(404);
    expect((await call({ path: '/v1/risk/reservations/nao-uuid/release', token: EXECUTOR_TOKEN, body: { reason: 'x' } })).status).toBe(404);
    expect(s.logger.entries.filter((e) => e.level === 'error')).toEqual([]);
  });
});

describe('corpo: 400 e 413', () => {
  it.each([
    ['text/plain', { 'Content-Type': 'text/plain' }],
    ['form', { 'Content-Type': 'application/x-www-form-urlencoded' }],
    ['json parecido', { 'Content-Type': 'application/jsonx' }],
  ])('Content-Type %s → 400', async (_l, headers) => {
    const r = await call({ path: EVAL, rawBody: '{}', headers });
    expect(r.status).toBe(400);
    expect(r.json.error?.code).toBe('INVALID_CONTENT_TYPE');
    noCalls();
  });

  it('Content-Type com charset é aceito', async () => {
    s.evaluate.mockResolvedValue({ kind: 'IDEMPOTENCY_CONFLICT' });
    expect((await call({ path: EVAL, rawBody: '{}', headers: { 'Content-Type': 'Application/JSON; charset=utf-8' } })).status).toBe(409);
  });

  it.each([['{nope'], ['[]'], ['"texto"'], ['null'], ['']])('corpo %j → 400 INVALID_JSON', async (rawBody) => {
    const r = await call({ path: EVAL, rawBody });
    expect(r.status).toBe(400);
    expect(r.json.error?.code).toBe('INVALID_JSON');
    noCalls();
  });

  it('corpo no limite exato é aceito; 1 byte acima → 413', async () => {
    s.evaluate.mockResolvedValue({ kind: 'IDEMPOTENCY_CONFLICT' });
    const pad = (n: number) => `{"a":"${'x'.repeat(n - 8)}"}`;
    expect(pad(LIMITS.maxBodyBytes).length).toBe(LIMITS.maxBodyBytes);
    expect((await call({ path: EVAL, rawBody: pad(LIMITS.maxBodyBytes) })).status).toBe(409);
    s.evaluate.mockClear();
    const r = await call({ path: EVAL, rawBody: pad(LIMITS.maxBodyBytes + 1) });
    expect(r.status).toBe(413);
    expect(r.json.error?.code).toBe('PAYLOAD_TOO_LARGE');
    expect(s.evaluate).not.toHaveBeenCalled();
  });

  it('413 com Content-Length declarado: Connection: close e socket destruído', async () => {
    const result = await new Promise<{ status: number; connection: string | undefined; closed: boolean }>((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port: s.port, path: EVAL, method: 'POST', headers: { Authorization: `Bearer ${AGENT_TOKEN}`, 'Content-Type': 'application/json', 'Content-Length': String(LIMITS.maxBodyBytes + 100) } },
        (res) => {
          res.resume();
          res.on('close', () => {
            // `close` da resposta sinaliza a conexão encerrada pelo servidor.
            resolve({ status: res.statusCode ?? 0, connection: res.headers.connection, closed: true });
          });
        },
      );
      req.on('error', reject);
      req.write('x'.repeat(100));
      // Não termina o corpo: o servidor deve responder 413 e derrubar a conexão.
    });
    expect(result.status).toBe(413);
    expect(result.connection).toBe('close');
    expect(result.closed).toBe(true);
    expect(s.evaluate).not.toHaveBeenCalled();
  });

  it('413 em corpo chunked sem Content-Length, parando a leitura', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port: s.port, path: EVAL, method: 'POST', headers: { Authorization: `Bearer ${AGENT_TOKEN}`, 'Content-Type': 'application/json' } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', (e) => {
        // A conexão pode ser derrubada logo após a resposta; só falha se não houve status.
        if ((e as NodeJS.ErrnoException).code !== 'ECONNRESET' && (e as NodeJS.ErrnoException).code !== 'EPIPE') reject(e);
      });
      req.write('{"a":"' + 'x'.repeat(LIMITS.maxBodyBytes * 2));
      req.end();
    });
    expect(status).toBe(413);
    expect(s.evaluate).not.toHaveBeenCalled();
  });

  it('Content-Length não numérico → 400', async () => {
    const raw = await new Promise<string>((resolve) => {
      const sock = connect(s.port, '127.0.0.1', () => {
        sock.write(`POST ${EVAL} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${AGENT_TOKEN}\r\nContent-Type: application/json\r\nContent-Length: abc\r\n\r\n{}`);
      });
      let data = '';
      sock.on('data', (d: Buffer) => {
        data += d.toString();
        if (data.includes('\r\n\r\n')) sock.destroy();
      });
      sock.on('close', () => {
        resolve(data);
      });
    });
    // O parser HTTP do Node já pode recusar com 400 antes do handler; ambos são 400.
    expect(raw.split('\r\n')[0]).toMatch(/^HTTP\/1\.1 400 /);
    noCalls();
  });
});

describe('POST /v1/risk/evaluations: tabela de status', () => {
  it('DECISION → 200 com a decisão; replay marca Idempotent-Replayed', async () => {
    s.evaluate.mockResolvedValueOnce({ kind: 'DECISION', decision: fakeDecision(), replayed: false });
    const a = await call({ path: EVAL, body: {} });
    expect(a.status).toBe(200);
    expect(a.json['decisionId']).toBe(DECISION_ID);
    expect(a.headers.get('idempotent-replayed')).toBeNull();
    s.evaluate.mockResolvedValueOnce({ kind: 'DECISION', decision: fakeDecision(), replayed: true });
    const b = await call({ path: EVAL, body: {} });
    expect(b.status).toBe(200);
    expect(b.headers.get('idempotent-replayed')).toBe('true');
  });

  it.each([
    ['FORBIDDEN', 403, 'FORBIDDEN'],
    ['UNAUTHENTICATED', 401, 'UNAUTHENTICATED'],
    ['INVALID_CONTRACT', 422, 'INVALID_CONTRACT'],
  ])('REJECTED/%s → %i', async (reason, status, code) => {
    s.evaluate.mockResolvedValue({ kind: 'REJECTED', reason, violations: [{ code: 'INVALID_PROPOSAL', message: 'fixture' }] });
    const r = await call({ path: EVAL, body: {} });
    expect(r.status).toBe(status);
    expect(r.json.error?.code).toBe(code);
    expect(r.json.error?.requestId).toMatch(/^[0-9a-f-]{36}$/);
    if (status === 401) expect(r.headers.get('www-authenticate')).toBe('Bearer');
    // Sem autorização em nenhum caminho de rejeição.
    expect(r.text).not.toContain('ALLOW_PAPER');
    expect(r.text).not.toContain('reservationId');
  });

  it('422 devolve violations com observed truncado em 64', async () => {
    const long = 'z'.repeat(500);
    s.evaluate.mockResolvedValue({
      kind: 'REJECTED',
      reason: 'INVALID_CONTRACT',
      violations: [{ code: 'INVALID_PROPOSAL', field: 'quantity', message: 'm', observed: long }, { code: 'INVALID_PROPOSAL', message: 'curto', observed: 'abc' }],
    });
    const r = await call({ path: EVAL, body: {} });
    const v = (r.json.error?.['violations'] ?? []) as { observed?: string }[];
    expect(v[0]?.observed).toBe(`${'z'.repeat(64)}...`);
    expect(v[1]?.observed).toBe('abc');
    expect(r.text).not.toContain(long);
  });

  it.each([
    [{ kind: 'IDEMPOTENCY_CONFLICT' }, 409, 'IDEMPOTENCY_CONFLICT'],
    [{ kind: 'UNAVAILABLE' }, 503, 'UNAVAILABLE'],
  ])('%j → %i', async (result, status, code) => {
    s.evaluate.mockResolvedValue(result);
    const r = await call({ path: EVAL, body: {} });
    expect(r.status).toBe(status);
    expect(r.json.error?.code).toBe(code);
  });
});

describe('GET /v1/risk/decisions/:id', () => {
  it('FOUND → 200', async () => {
    s.getDecision.mockResolvedValue({ kind: 'FOUND', decision: fakeDecision() });
    const r = await call({ path: GET });
    expect(r.status).toBe(200);
    expect(s.getDecision).toHaveBeenCalledWith({ decisionId: DECISION_ID, principal: { kind: 'AGENT', principalId: AGENT_ID } });
  });

  it('decisão alheia (fake NOT_FOUND) → 404 sem pistas de existência', async () => {
    s.getDecision.mockResolvedValue({ kind: 'NOT_FOUND' });
    const r = await call({ path: GET });
    expect(r.status).toBe(404);
    expect(Object.keys(r.json.error ?? {}).sort()).toEqual(['code', 'requestId']);
  });

  it('UNAVAILABLE → 503', async () => {
    expect((await call({ path: GET })).status).toBe(503);
  });
});

describe('POST /v1/risk/authorizations/:id/consume', () => {
  const run = (result: unknown) => {
    s.consume.mockResolvedValue(result);
    return call({ path: CONSUME, token: EXECUTOR_TOKEN, body: consumeBody });
  };

  it('CONSUMED → 200 com o corpo exato', async () => {
    const r = await run({ kind: 'CONSUMED', reservationId: RESERVATION_ID, replayed: false });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ status: 'CONSUMED', reservationId: RESERVATION_ID, replayed: false });
    expect(s.consume).toHaveBeenCalledWith({ principal: { kind: 'PAPER_EXECUTOR', principalId: EXECUTOR_ID }, decisionId: DECISION_ID, ...consumeBody });
  });

  it.each([
    [{ kind: 'FORBIDDEN' }, 403, 'FORBIDDEN'],
    [{ kind: 'NOT_FOUND' }, 404, 'NOT_FOUND'],
    [{ kind: 'CONFLICT' }, 409, 'CONFLICT'],
    [{ kind: 'UNAVAILABLE' }, 503, 'UNAVAILABLE'],
  ])('%j → %i', async (result, status, code) => {
    const r = await run(result);
    expect(r.status).toBe(status);
    expect(r.json.error?.code).toBe(code);
    expect(r.text).not.toContain('CONSUMED');
  });

  it.each(['BLOCKED', 'EXPIRED', 'RELEASED', 'PROPOSAL_MISMATCH'])('NOT_AUTHORIZED/%s → 409 com reason', async (reason) => {
    const r = await run({ kind: 'NOT_AUTHORIZED', reason });
    expect(r.status).toBe(409);
    expect(r.json.error).toMatchObject({ code: 'NOT_AUTHORIZED', reason });
  });

  it.each([
    ['sem accountId', { paperOrderId: 'o', proposalHash: HASH }, 'accountId'],
    ['hash sem prefixo', { ...consumeBody, proposalHash: 'a'.repeat(64) }, 'proposalHash'],
    ['hash em maiúsculas', { ...consumeBody, proposalHash: `sha256:${'A'.repeat(64)}` }, 'proposalHash'],
    ['paperOrderId com espaço', { ...consumeBody, paperOrderId: 'a b' }, 'paperOrderId'],
    ['campo extra', { ...consumeBody, agentId: 'x' }, ''],
    ['tipo errado', { ...consumeBody, accountId: 5 }, 'accountId'],
  ])('corpo inválido (%s) → 422 sem chamar o caso de uso', async (_l, body, field) => {
    const r = await call({ path: CONSUME, token: EXECUTOR_TOKEN, body });
    expect(r.status).toBe(422);
    expect(r.json.error?.code).toBe('INVALID_CONTRACT');
    expect(r.json.error?.['fields']).toEqual(expect.arrayContaining(field === '' ? [] : [field]));
    expect(s.consume).not.toHaveBeenCalled();
  });
});

describe('POST /v1/risk/reservations/:id/release', () => {
  const run = (result: unknown, body: unknown = { reason: 'cancelado' }) => {
    s.release.mockResolvedValue(result);
    return call({ path: RELEASE, token: EXECUTOR_TOKEN, body });
  };

  it('RELEASED → 200 com corpo exato', async () => {
    const r = await run({ kind: 'RELEASED', replayed: true });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ status: 'RELEASED', replayed: true });
    expect(s.release).toHaveBeenCalledWith({ principal: { kind: 'PAPER_EXECUTOR', principalId: EXECUTOR_ID }, reservationId: RESERVATION_ID, reason: 'cancelado' });
  });

  it.each([
    [{ kind: 'FORBIDDEN' }, 403, 'FORBIDDEN'],
    [{ kind: 'NOT_FOUND' }, 404, 'NOT_FOUND'],
    [{ kind: 'CONFLICT', status: 'CONSUMED' }, 409, 'CONFLICT'],
    [{ kind: 'UNAVAILABLE' }, 503, 'UNAVAILABLE'],
  ])('%j → %i', async (result, status, code) => {
    const r = await run(result);
    expect(r.status).toBe(status);
    expect(r.json.error?.code).toBe(code);
  });

  it.each([
    ['sem reason', {}],
    ['reason vazio', { reason: '' }],
    ['reason com 257 caracteres', { reason: 'r'.repeat(257) }],
    ['campo extra', { reason: 'x', extra: 1 }],
    ['reason não string', { reason: 5 }],
  ])('corpo inválido (%s) → 422', async (_l, body) => {
    const r = await run({ kind: 'RELEASED', replayed: false }, body);
    expect(r.status).toBe(422);
    expect(r.json.error?.['fields']).toBeDefined();
    expect(s.release).not.toHaveBeenCalled();
  });
});

describe('identidade vem do token, nunca do payload', () => {
  it('agentId, accountId e environment falsificados no payload não mudam a identidade repassada', async () => {
    s.evaluate.mockResolvedValue({ kind: 'UNAVAILABLE' });
    const forged = { agentId: 'agent-evil', accountId: 'paper-evil', environment: 'LIVE', principalId: 'agent-evil', authenticatedAgentId: 'agent-evil' };
    await call({ path: EVAL, body: forged });
    expect(s.evaluate).toHaveBeenCalledOnce();
    const arg = s.evaluate.mock.calls[0]?.[0] as { authenticatedAgentId: string; proposal: Record<string, unknown> };
    expect(arg.authenticatedAgentId).toBe(AGENT_ID);
    // O payload segue intacto para o caso de uso rejeitar a divergência; o servidor não o "corrige".
    expect(arg.proposal).toEqual(forged);
  });

  it('principal de consume/release vem do token; campos de identidade no corpo são recusados', async () => {
    s.consume.mockResolvedValue({ kind: 'UNAVAILABLE' });
    const r = await call({ path: CONSUME, token: EXECUTOR_TOKEN, body: { ...consumeBody, principalId: 'executor-evil' } });
    expect(r.status).toBe(422);
    expect(s.consume).not.toHaveBeenCalled();
  });

  it('cabeçalhos de identidade forjados são ignorados', async () => {
    s.evaluate.mockResolvedValue({ kind: 'UNAVAILABLE' });
    await call({ path: EVAL, body: {}, headers: { 'X-Agent-Id': 'agent-evil', 'X-Forwarded-User': 'agent-evil' } });
    expect((s.evaluate.mock.calls[0]?.[0] as { authenticatedAgentId: string }).authenticatedAgentId).toBe(AGENT_ID);
  });
});

describe('falhas internas e vazamentos', () => {
  it.each([
    ['evaluate', EVAL, AGENT_TOKEN, {}],
    ['consume', CONSUME, EXECUTOR_TOKEN, consumeBody],
    ['release', RELEASE, EXECUTOR_TOKEN, { reason: 'x' }],
    ['getDecision', GET, AGENT_TOKEN, undefined],
  ])('%s que lança → 500 INTERNAL_ERROR, nunca 200 nem ALLOW_PAPER, sem vazar a mensagem', async (name, path, token, body) => {
    const fake = { evaluate: s.evaluate, consume: s.consume, release: s.release, getDecision: s.getDecision }[name as 'evaluate'];
    fake.mockRejectedValue(new Error(`boom segredo ${token} postgres://user:senha@db/x`));
    const r = await call({ path, token, ...(body === undefined ? {} : { body }) });
    expect(r.status).toBe(500);
    expect(r.json.error?.code).toBe('INTERNAL_ERROR');
    expect(r.text).not.toContain('ALLOW_PAPER');
    expect(r.text).not.toContain('boom');
    expect(r.text).not.toContain('senha');
    const logs = JSON.stringify(s.logger.entries);
    expect(logs).not.toContain('boom');
    expect(logs).not.toContain('senha');
    expect(logs).not.toContain(token);
  });

  it('fake que lança de forma síncrona também vira 500', async () => {
    s.evaluate.mockImplementation(() => {
      throw new Error('sync');
    });
    expect((await call({ path: EVAL, body: {} })).status).toBe(500);
  });

  it('o token nunca aparece em log nem em corpo de resposta, em nenhum caminho', async () => {
    s.evaluate.mockResolvedValue({ kind: 'DECISION', decision: fakeDecision(), replayed: false });
    s.consume.mockResolvedValue({ kind: 'CONSUMED', reservationId: RESERVATION_ID, replayed: false });
    s.release.mockResolvedValue({ kind: 'RELEASED', replayed: false });
    s.getDecision.mockResolvedValue({ kind: 'FOUND', decision: fakeDecision() });
    await call({ path: EVAL, body: {} });
    await call({ path: EVAL, token: EXECUTOR_TOKEN, body: {} });
    await call({ path: EVAL, token: 'token-errado-secreto-xyz', body: {} });
    await call({ path: EVAL, rawBody: '{nope' });
    await call({ path: CONSUME, token: EXECUTOR_TOKEN, body: consumeBody });
    await call({ path: RELEASE, token: EXECUTOR_TOKEN, body: { reason: 'x' } });
    await call({ path: GET });
    await call({ path: '/nada', token: AGENT_TOKEN });
    s.evaluate.mockRejectedValue(new Error('x'));
    await call({ path: EVAL, body: {} });
    const logs = JSON.stringify(s.logger.entries);
    const bodies = responses.join('\n');
    for (const secret of [AGENT_TOKEN, EXECUTOR_TOKEN, 'token-errado-secreto-xyz']) {
      expect(logs, secret).not.toContain(secret);
      expect(bodies, secret).not.toContain(secret);
    }
    expect(logs).not.toMatch(/Bearer/i);
  });

  it('respostas de erro têm o formato fixo e cabeçalhos de segurança', async () => {
    const r = await call({ path: '/nada', token: null });
    expect(Object.keys(r.json)).toEqual(['error']);
    expect(r.headers.get('content-type')).toContain('application/json');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('cada requisição loga http.request com rota-padrão (sem ids) e status', async () => {
    s.getDecision.mockResolvedValue({ kind: 'NOT_FOUND' });
    await call({ path: GET });
    const entry = s.logger.entries.find((e) => e.event === 'http.request');
    expect(entry?.fields).toMatchObject({ route: 'GET /v1/risk/decisions/:id', httpStatus: 404, principalId: AGENT_ID });
    expect(JSON.stringify(entry)).not.toContain(DECISION_ID);
  });
});

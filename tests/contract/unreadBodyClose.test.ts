import { connect, type Socket } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DECISION_ID, RESERVATION_ID, startServer, type TestServer } from './support.js';

// POST/PUT/PATCH/DELETE em rota inexistente (404) ou com método não permitido (405): o corpo NÃO é lido; a resposta traz
// `Connection: close` e o servidor destrói o socket (nada de drenar um upload arbitrário). Sockets brutos: o fetch esconde isso.
let s: TestServer;
beforeAll(async () => {
  s = await startServer();
});
afterAll(async () => s.close());
beforeEach(() => {
  for (const f of [s.evaluate, s.consume, s.release, s.getDecision]) f.mockClear();
});

interface Raw {
  readonly head: string;
  readonly status: number;
  readonly closed: boolean;
  readonly bytesAfterHead: number;
}

/** Envia só os cabeçalhos (Content-Length grande, sem corpo) e espera resposta + fechamento. */
async function rawRequest(method: string, path: string, extraHeaders: readonly string[] = [], declaredBody = 5_000_000): Promise<Raw> {
  return new Promise<Raw>((resolve, reject) => {
    const socket: Socket = connect(s.port, '127.0.0.1');
    let data = '';
    let closed = false;
    const timer = setTimeout(() => {
      socket.destroy();
      const [head = ''] = data.split('\r\n\r\n');
      resolve({ head, status: Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1] ?? 0), closed, bytesAfterHead: 0 });
    }, 3000);
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      data += chunk;
    });
    socket.on('error', (error) => {
      // ECONNRESET é um fechamento válido (socket destruído com o corpo não lido).
      if ((error as NodeJS.ErrnoException).code === 'ECONNRESET') return;
      clearTimeout(timer);
      reject(error);
    });
    socket.on('close', () => {
      closed = true;
      clearTimeout(timer);
      const [head = '', ...rest] = data.split('\r\n\r\n');
      resolve({ head, status: Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1] ?? 0), closed, bytesAfterHead: rest.join('').length });
    });
    socket.on('connect', () => {
      socket.write([`${method} ${path} HTTP/1.1`, 'Host: 127.0.0.1', 'Content-Type: application/json', `Content-Length: ${declaredBody}`, ...extraHeaders, '', '{"parcial":'].join('\r\n'));
    });
  });
}

const BODY_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;
const noUseCaseCalls = () => {
  for (const f of [s.evaluate, s.consume, s.release, s.getDecision]) expect(f).not.toHaveBeenCalled();
};

describe('404 com método de corpo: Connection: close e socket destruído sem ler o corpo', () => {
  it.each(BODY_METHODS)('%s em rota inexistente', async (method) => {
    const r = await rawRequest(method, '/v1/nao-existe');
    expect(r.status).toBe(404);
    expect(r.head.toLowerCase()).toContain('connection: close');
    expect(r.closed, 'socket deve fechar mesmo com o corpo declarado incompleto').toBe(true);
    noUseCaseCalls();
  });

  it.each(BODY_METHODS)('%s em rota inexistente SEM token e COM token de agente: mesma resposta, sem passar pela autenticação', async (method) => {
    for (const extra of [[], ['Authorization: Bearer tok-fixture-agent-0001'], ['Authorization: Bearer token-invalido']]) {
      const r = await rawRequest(method, '/v2/risk/evaluations', extra);
      expect(r.status).toBe(404);
      expect(r.closed).toBe(true);
    }
    noUseCaseCalls();
  });
});

describe('405 com método de corpo: Connection: close, Allow e socket destruído', () => {
  const cases = [
    ['PUT', '/v1/risk/evaluations', 'POST'],
    ['PATCH', '/v1/risk/evaluations', 'POST'],
    ['DELETE', '/v1/risk/evaluations', 'POST'],
    ['POST', `/v1/risk/decisions/${DECISION_ID}`, 'GET'],
    ['PUT', `/v1/risk/decisions/${DECISION_ID}`, 'GET'],
    ['PATCH', `/v1/risk/authorizations/${DECISION_ID}/consume`, 'POST'],
    ['DELETE', `/v1/risk/reservations/${RESERVATION_ID}/release`, 'POST'],
    ['POST', '/health/live', 'GET'],
    ['DELETE', '/health/ready', 'GET'],
  ] as const;

  it.each(cases)('%s %s → 405', async (method, path, allow) => {
    const r = await rawRequest(method, path);
    expect(r.status).toBe(405);
    const head = r.head.toLowerCase();
    expect(head).toContain('connection: close');
    expect(head).toContain(`allow: ${allow.toLowerCase()}`);
    expect(r.closed).toBe(true);
    noUseCaseCalls();
  });
});

describe('controles', () => {
  it('GET em rota inexistente NÃO força Connection: close (sem corpo a descartar)', async () => {
    const res = await fetch(`${s.url}/v1/nao-existe`);
    expect(res.status).toBe(404);
    expect(res.headers.get('connection')?.toLowerCase()).not.toBe('close');
    await res.text();
  });

  it('o servidor continua saudável depois de várias conexões destruídas', async () => {
    await Promise.all(BODY_METHODS.flatMap((m) => [rawRequest(m, '/nada'), rawRequest(m, '/v1/risk/evaluations/extra')]));
    expect((await fetch(`${s.url}/health/live`)).status).toBe(200);
    noUseCaseCalls();
  });

  it('o corpo não é lido: um corpo enorme enviado depois da resposta não chega a nenhum caso de uso e o log não o contém', async () => {
    await new Promise<void>((resolve) => {
      const socket = connect(s.port, '127.0.0.1');
      socket.on('error', () => undefined);
      socket.on('close', () => {
        resolve();
      });
      socket.on('connect', () => {
        socket.write('POST /v1/nao-existe HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\n');
        setTimeout(() => socket.write('SEGREDO-NO-CORPO-zz9'.padEnd(100, 'x'), () => undefined), 50);
      });
      setTimeout(() => {
        socket.destroy();
        resolve();
      }, 2000);
    });
    noUseCaseCalls();
    expect(JSON.stringify(s.logger.entries)).not.toContain('SEGREDO-NO-CORPO-zz9');
  });
});

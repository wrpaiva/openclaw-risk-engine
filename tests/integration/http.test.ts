import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Sha256TokenAuthenticator } from '../../src/infrastructure/auth/Sha256TokenAuthenticator.js';
import { startServer, type TestServer } from '../contract/support.js';
import { validProposal } from '../fixtures/proposals.js';
import { count, createIsolatedDatabase, createRuntimeLogin, seedAccount, seedPolicy, type IsolatedDatabase, type RuntimeLogin } from './support/database.js';
import { buildDist, freePort, runtimeEnv, writePrincipals, type Dist } from './support/dist.js';
import { AGENT, EXECUTOR, harness, uniqueProposal, type Harness } from './support/harness.js';

// Tokens e principais FICTÍCIOS.
const TOKENS = { agent: 'tok-e2e-agent-0001', nogrant: 'tok-e2e-nogrant-0001', executor: 'tok-e2e-executor-0001' } as const;
const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');
const PRINCIPALS = [
  { principalId: AGENT, kind: 'AGENT' as const, tokenSha256: [sha(TOKENS.agent)] },
  { principalId: 'agent-e2e-nogrant', kind: 'AGENT' as const, tokenSha256: [sha(TOKENS.nogrant)] },
  { principalId: EXECUTOR, kind: 'PAPER_EXECUTOR' as const, tokenSha256: [sha(TOKENS.executor)] },
];

interface Body {
  decisionId: string;
  reservationId: string;
  accountId: string;
  proposalHash: string;
  status: string;
  violations: unknown[];
  error: { code: string };
}

let db: IsolatedDatabase;
let h: Harness;
let srv: TestServer;

beforeAll(async () => {
  db = await createIsolatedDatabase();
  await seedAccount(db.pool);
  await seedPolicy(db.pool);
});
afterAll(async () => db.drop());
beforeEach(async () => {
  h = harness(db.pool);
  srv = await startServer({
    authenticator: new Sha256TokenAuthenticator(PRINCIPALS),
    evaluate: h.evaluate,
    consume: h.consume,
    release: h.release,
    getDecision: h.get,
    logger: h.logger,
    limits: { maxBodyBytes: 65_536, requestTimeoutMs: 5000, headersTimeoutMs: 3000 },
  });
});
afterEach(async () => {
  await srv.close();
});

async function post(path: string, token: string, body: unknown) {
  const res = await fetch(srv.url + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, json: (await res.json()) as Body };
}
const get = async (path: string, token: string) => {
  const res = await fetch(srv.url + path, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, json: (await res.json()) as Body };
};
const reservationStatus = async (id: string) =>
  (await db.pool.query<{ status: string }>('SELECT status FROM risk_reservations WHERE reservation_id = $1', [id])).rows[0]?.status;

describe('HTTP ponta a ponta sobre PostgreSQL', () => {
  it('agente com grant → ALLOW_PAPER; executor consome; segundo consume com outra ordem → 409', async () => {
    const proposal = uniqueProposal();
    const evaluated = await post('/v1/risk/evaluations', TOKENS.agent, proposal);
    expect(evaluated.status).toBe(200);
    const d = evaluated.json;
    expect(d.status).toBe('ALLOW_PAPER');
    expect(d.violations).toEqual([]);
    expect(d.reservationId).toEqual(expect.any(String));
    expect(await reservationStatus(d.reservationId)).toBe('ACTIVE');

    // Replay da mesma proposta devolve a mesma decisão, marcado como replay.
    const replay = await post('/v1/risk/evaluations', TOKENS.agent, proposal);
    expect(replay.status).toBe(200);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(replay.json.decisionId).toBe(d.decisionId);

    const path = `/v1/risk/authorizations/${d.decisionId}/consume`;
    const body = { accountId: d.accountId, paperOrderId: 'order-e2e-1', proposalHash: d.proposalHash };
    const first = await post(path, TOKENS.executor, body);
    expect(first.status).toBe(200);
    expect(first.json).toEqual({ status: 'CONSUMED', reservationId: d.reservationId, replayed: false });
    // Mesma ordem: idempotente.
    expect((await post(path, TOKENS.executor, body)).json).toMatchObject({ status: 'CONSUMED', replayed: true });
    // Outra ordem: conflito.
    const second = await post(path, TOKENS.executor, { ...body, paperOrderId: 'order-e2e-2' });
    expect(second.status).toBe(409);
    expect(second.json.error.code).toBe('CONFLICT');
    expect(await reservationStatus(d.reservationId)).toBe('CONSUMED');
  });

  it('leitura de decisão: dono e executor leem; agente sem grant não', async () => {
    const d = (await post('/v1/risk/evaluations', TOKENS.agent, uniqueProposal())).json;
    const path = `/v1/risk/decisions/${d.decisionId}`;
    expect((await get(path, TOKENS.agent)).status).toBe(200);
    expect((await get(path, TOKENS.executor)).status).toBe(200);
    expect((await get(path, TOKENS.nogrant)).status).toBe(404);
    expect((await get('/v1/risk/decisions/nao-e-uuid', TOKENS.agent)).status).toBe(404);
  });

  it('release pelo executor e consumo posterior → 409 NOT_AUTHORIZED RELEASED', async () => {
    const d = (await post('/v1/risk/evaluations', TOKENS.agent, uniqueProposal())).json;
    const rel = await post(`/v1/risk/reservations/${d.reservationId}/release`, TOKENS.executor, { reason: 'cancelado' });
    expect(rel).toMatchObject({ status: 200, json: { status: 'RELEASED', replayed: false } });
    const c = await post(`/v1/risk/authorizations/${d.decisionId}/consume`, TOKENS.executor, {
      accountId: d.accountId,
      paperOrderId: 'order-late',
      proposalHash: d.proposalHash,
    });
    expect(c.status).toBe(409);
    expect(c.json.error).toMatchObject({ code: 'NOT_AUTHORIZED', reason: 'RELEASED' });
  });

  it('agente sem grant → 403 e nenhuma linha em trade_proposals nem em risk_decisions', async () => {
    const proposals = await count(db.pool, 'trade_proposals');
    const decisions = await count(db.pool, 'risk_decisions');
    const reservations = await count(db.pool, 'risk_reservations');
    const r = await post('/v1/risk/evaluations', TOKENS.nogrant, uniqueProposal({ agentId: 'agent-e2e-nogrant' }));
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.json)).not.toContain('ALLOW_PAPER');
    expect(await count(db.pool, 'trade_proposals')).toBe(proposals);
    expect(await count(db.pool, 'risk_decisions')).toBe(decisions);
    expect(await count(db.pool, 'risk_reservations')).toBe(reservations);
  });

  it('payload com agentId de outro agente → 403 (identidade do token prevalece), nada gravado', async () => {
    const proposals = await count(db.pool, 'trade_proposals');
    const r = await post('/v1/risk/evaluations', TOKENS.agent, uniqueProposal({ agentId: 'agent-e2e-nogrant' }));
    expect(r.status).toBe(403);
    expect(await count(db.pool, 'trade_proposals')).toBe(proposals);
  });

  it('contrato inválido → 422 sem gravar; environment LIVE nunca autoriza', async () => {
    const proposals = await count(db.pool, 'trade_proposals');
    const bad = await post('/v1/risk/evaluations', TOKENS.agent, uniqueProposal({ quantity: '1e-2' }));
    expect(bad.status).toBe(422);
    const reservations = await count(db.pool, 'risk_reservations');
    const live = await post('/v1/risk/evaluations', TOKENS.agent, uniqueProposal({ environment: 'LIVE' }));
    expect(JSON.stringify(live.json)).not.toContain('ALLOW_PAPER');
    expect(live.json.status).not.toBe('ALLOW_PAPER');
    expect(await count(db.pool, 'risk_reservations')).toBe(reservations);
    expect(await count(db.pool, 'trade_proposals')).toBe(proposals);
  });

  it('conflito de idempotência (mesma chave, proposta diferente) → 409', async () => {
    const proposal = uniqueProposal();
    expect((await post('/v1/risk/evaluations', TOKENS.agent, proposal)).status).toBe(200);
    const other = { ...proposal, proposalId: randomUUID(), quantity: '0.02' };
    const r = await post('/v1/risk/evaluations', TOKENS.agent, other);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('dependência indisponível → 503 sem autorização e sem reserva', async () => {
    h.external.failSnapshot = true;
    const reservations = await count(db.pool, 'risk_reservations');
    const r = await post('/v1/risk/evaluations', TOKENS.agent, uniqueProposal());
    expect(r.status).toBe(503);
    expect(JSON.stringify(r.json)).not.toContain('ALLOW_PAPER');
    expect(await count(db.pool, 'risk_reservations')).toBe(reservations);
  });

  it('o token nunca aparece nos logs capturados', async () => {
    await post('/v1/risk/evaluations', TOKENS.agent, uniqueProposal());
    await post('/v1/risk/evaluations', TOKENS.nogrant, uniqueProposal({ agentId: 'agent-e2e-nogrant' }));
    const logs = JSON.stringify(h.logger.entries);
    for (const t of Object.values(TOKENS)) expect(logs).not.toContain(t);
  });
});

describe('smoke do main real (sem fontes configuradas só emite BLOCK)', () => {
  let dist: Dist;
  let child: ChildProcess | undefined;
  let port = 0;
  let smokeDb: IsolatedDatabase;
  let rt: RuntimeLogin;
  const stderr: string[] = [];

  beforeAll(async () => {
    // Compila para um diretório temporário (fora do repositório) e liga node_modules e migrations por link.
    dist = buildDist('risk-main-smoke');
    const principalsFile = writePrincipals(dist.work, PRINCIPALS);

    smokeDb = await createIsolatedDatabase();
    await seedAccount(smokeDb.pool);
    await seedPolicy(smokeDb.pool);
    // O main recusa superuser (2.5): conecta como login de runtime (privilégio mínimo), não como o admin do teste.
    rt = await createRuntimeLogin(smokeDb);
    port = await freePort();
    child = spawn('node', [dist.httpMain], {
      env: runtimeEnv({ RISK_DATABASE_URL: rt.url, RISK_HTTP_PORT: String(port), RISK_PRINCIPALS_FILE: principalsFile }),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr?.on('data', (d: Buffer) => stderr.push(d.toString()));
    for (let i = 0; ; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/nada`);
        if (r.status === 404) break;
      } catch {
        if (i > 60) throw new Error(`main não subiu: ${stderr.join('')}`);
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  });
  afterAll(async () => {
    child?.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
    child?.kill('SIGKILL');
    await rt.drop();
    await smokeDb.drop();
    dist.cleanup();
  });

  it('avaliação válida devolve BLOCK (fail-closed), sem reserva; token errado → 401', async () => {
    const now = Date.now();
    const proposal = validProposal({
      proposalId: randomUUID(),
      idempotencyKey: `idem-${randomUUID()}`,
      createdAt: new Date(now - 1000).toISOString(),
      expiresAt: new Date(now + 30_000).toISOString(),
    });
    const res = await fetch(`http://127.0.0.1:${port}/v1/risk/evaluations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKENS.agent}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(proposal),
    });
    const body = (await res.json()) as Body;
    expect(res.status).toBe(200);
    expect(body.status).toBe('BLOCK');
    expect(body.violations.length).toBeGreaterThan(0);
    expect(body.reservationId).toBeNull();
    expect(await count(smokeDb.pool, 'risk_reservations')).toBe(0);
    expect(await count(smokeDb.pool, 'risk_decisions', `status = 'ALLOW_PAPER'`)).toBe(0);

    const bad = await fetch(`http://127.0.0.1:${port}/v1/risk/evaluations`, { method: 'POST', headers: { Authorization: 'Bearer errado', 'Content-Type': 'application/json' }, body: '{}' });
    expect(bad.status).toBe(401);
    expect(stderr.join('')).not.toContain(TOKENS.agent);
  });
});

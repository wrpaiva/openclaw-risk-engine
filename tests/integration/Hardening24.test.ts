import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RiskDecisionV1 } from '../../src/domain/RiskDecision.js';
import { Sha256TokenAuthenticator } from '../../src/infrastructure/auth/Sha256TokenAuthenticator.js';
import { EXECUTOR_TOKEN, startServer, type TestServer } from '../contract/support.js';
import { count, createIsolatedDatabase, seedAccount, seedGrant, seedPolicy, type IsolatedDatabase } from './support/database.js';
import { AGENT, agentPrincipal, EXECUTOR, executorPrincipal, harness, uniqueProposal, type Harness } from './support/harness.js';

// Etapa 2.4, achados M1/B1/B4/B5 contra o PostgreSQL descartável. Dados FICTÍCIOS.
const TOKENS = { agent: 'tok-h24-agent-0001', executor: 'tok-h24-executor-0001' } as const;
const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');

let db: IsolatedDatabase;
let h: Harness;
let srv: TestServer;

beforeAll(async () => {
  db = await createIsolatedDatabase();
  await seedAccount(db.pool);
  await seedAccount(db.pool, 'paper-other', false);
  await seedGrant(db.pool, { principalId: AGENT, role: 'AGENT', accountId: 'paper-other' });
  await seedPolicy(db.pool);
});
afterAll(async () => db.drop());
beforeEach(async () => {
  h = harness(db.pool);
  srv = await startServer({
    authenticator: new Sha256TokenAuthenticator([
      { principalId: AGENT, kind: 'AGENT', tokenSha256: [sha(TOKENS.agent)] },
      { principalId: EXECUTOR, kind: 'PAPER_EXECUTOR', tokenSha256: [sha(TOKENS.executor)] },
    ]),
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

async function authorize(): Promise<RiskDecisionV1> {
  const r = await h.evaluate.execute({ proposal: uniqueProposal(), authenticatedAgentId: AGENT });
  if (r.kind !== 'DECISION' || r.decision.status !== 'ALLOW_PAPER') throw new Error('esperava ALLOW_PAPER');
  return r.decision;
}

/** Corrompe dados "no banco" desligando só o trigger de imutabilidade; religa sempre. */
async function tamper(table: string, trigger: string, sql: string, params: unknown[]): Promise<void> {
  const client = await db.pool.connect();
  try {
    await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    try {
      await client.query(sql, params);
    } finally {
      await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
    }
  } finally {
    client.release();
  }
}
const tamperDecision = (id: string, jsonSql: string, params: unknown[] = []) =>
  tamper('risk_decisions', 'risk_decisions_immutable', `UPDATE risk_decisions SET decision_json = ${jsonSql} WHERE decision_id = $1`, [id, ...params]);
const tamperReservation = (id: string, setSql: string, params: unknown[] = []) =>
  tamper('risk_reservations', 'risk_reservations_guard', `UPDATE risk_reservations SET ${setSql} WHERE reservation_id = $1`, [id, ...params]);

const reservationRow = async (id: string | null) =>
  (await db.pool.query<{ status: string; paper_order_id: string | null }>('SELECT status, paper_order_id FROM risk_reservations WHERE reservation_id = $1', [id])).rows[0];
const consume = (d: RiskDecisionV1, paperOrderId = `order-${randomUUID()}`) =>
  h.consume.execute({ principal: executorPrincipal(), decisionId: d.decisionId, accountId: d.accountId, paperOrderId, proposalHash: d.proposalHash });
const noConsumption = async (d: RiskDecisionV1) => {
  expect(await reservationRow(d.reservationId)).toEqual({ status: 'ACTIVE', paper_order_id: null });
  expect(await count(db.pool, 'risk_audit_events', `event_type IN ('RESERVATION_CONSUMED','RESERVATION_EXPIRED') AND decision_id = $1`, [d.decisionId])).toBe(0);
  expect(await count(db.pool, 'risk_outbox', `aggregate_id = $1 AND event_type = 'risk.authorization.consumed'`, [d.decisionId])).toBe(0);
};
const post = (path: string, token: string, body: unknown) =>
  fetch(srv.url + path, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('M1: consume com dados persistidos corrompidos', () => {
  it('decision_json inválido → UNAVAILABLE e nada consumido (HTTP 503)', async () => {
    const d = await authorize();
    await tamperDecision(d.decisionId, `'{"foo": 1}'::jsonb`);
    expect(await consume(d)).toEqual({ kind: 'UNAVAILABLE' });
    await noConsumption(d);
    const res = await post(`/v1/risk/authorizations/${d.decisionId}/consume`, TOKENS.executor, { accountId: d.accountId, paperOrderId: 'order-http', proposalHash: d.proposalHash });
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain('CONSUMED');
    await noConsumption(d);
  });

  it('GET de decision_json inválido → 503, nunca 200 (agente dono e executor)', async () => {
    const d = await authorize();
    await tamperDecision(d.decisionId, `'{"status":"ALLOW_PAPER"}'::jsonb`);
    expect(await h.get.execute({ decisionId: d.decisionId, principal: agentPrincipal() })).toEqual({ kind: 'UNAVAILABLE' });
    for (const token of [TOKENS.agent, TOKENS.executor]) {
      const res = await fetch(`${srv.url}/v1/risk/decisions/${d.decisionId}`, { headers: { Authorization: `Bearer ${token}` } });
      expect(res.status).toBe(503);
      expect(await res.text()).not.toContain(d.reservationId ?? 'sem-reserva');
    }
  });

  it('reservationId da decisão diferente da reserva → 503 e não consome', async () => {
    const d = await authorize();
    await tamperDecision(d.decisionId, `jsonb_set(decision_json, '{reservationId}', to_jsonb($2::text))`, [randomUUID()]);
    expect(await consume(d)).toEqual({ kind: 'UNAVAILABLE' });
    await noConsumption(d);
  });

  it('accountId da reserva diferente da decisão → não consome', async () => {
    const d = await authorize();
    await tamperReservation(d.reservationId ?? '', `account_id = 'paper-other'`);
    expect(await consume(d)).toEqual({ kind: 'UNAVAILABLE' });
    await noConsumption(d);
  });

  it('expires_at da reserva diferente de authorizationExpiresAt → não consome, mesmo que a reserva ainda esteja no prazo', async () => {
    const d = await authorize();
    await tamperReservation(d.reservationId ?? '', `expires_at = expires_at + interval '1 millisecond'`);
    expect(await consume(d)).toEqual({ kind: 'UNAVAILABLE' });
    await noConsumption(d);
    // Divergência também para menos, e com relógio já vencido: continua sem fechar nada.
    const e = await authorize();
    await tamperReservation(e.reservationId ?? '', `expires_at = expires_at - interval '1 second'`);
    h.clock.set(e.authorizationExpiresAt ?? '');
    expect(await consume(e)).toEqual({ kind: 'UNAVAILABLE' });
    await noConsumption(e);
  });

  it('TTL vencido continua EXPIRED (reserva fechada, auditoria consume-after-ttl, sem outbox)', async () => {
    const d = await authorize();
    h.clock.set(d.authorizationExpiresAt ?? '');
    expect(await consume(d)).toEqual({ kind: 'NOT_AUTHORIZED', reason: 'EXPIRED' });
    expect((await reservationRow(d.reservationId))?.status).toBe('EXPIRED');
    const { rows } = await db.pool.query<{ details_json: { trigger: string } }>(`SELECT details_json FROM risk_audit_events WHERE event_type = 'RESERVATION_EXPIRED' AND decision_id = $1`, [d.decisionId]);
    expect(rows.map((r) => r.details_json.trigger)).toEqual(['consume-after-ttl']);
    expect(await count(db.pool, 'risk_outbox', `aggregate_id = $1 AND event_type = 'risk.authorization.consumed'`, [d.decisionId])).toBe(0);
  });
});

describe('B1/B5 (item 5): agentId divergente na avaliação', () => {
  it('log warn evaluate.forbidden/AGENT_ID_MISMATCH, 403 e nenhuma gravação', async () => {
    const tables = ['trade_proposals', 'risk_decisions', 'risk_reservations', 'risk_audit_events', 'risk_outbox'];
    const before = await Promise.all(tables.map((t) => count(db.pool, t)));
    h.logger.entries.length = 0;
    const r = await post('/v1/risk/evaluations', TOKENS.agent, uniqueProposal({ agentId: 'agent-impostor' }));
    expect(r.status).toBe(403);
    expect(await r.text()).not.toContain('ALLOW_PAPER');
    expect(await Promise.all(tables.map((t) => count(db.pool, t)))).toEqual(before);
    const forbidden = h.logger.entries.filter((e) => e.event === 'evaluate.forbidden');
    expect(forbidden).toHaveLength(1);
    expect(forbidden[0]?.level).toBe('warn');
    expect(forbidden[0]?.fields).toMatchObject({ outcome: 'AGENT_ID_MISMATCH', principalId: AGENT });
    expect(h.logger.entries.find((e) => e.event === 'http.request')).toMatchObject({ level: 'warn', fields: { httpStatus: 403 } });
  });
});

describe('B5: auditoria do conflito de idempotência', () => {
  const auditRows = async (key: string) =>
    (await db.pool.query<{ proposal_id: string | null; account_id: string; details_json: Record<string, unknown> }>(
      `SELECT proposal_id, account_id, details_json FROM risk_audit_events WHERE event_type = 'IDEMPOTENCY_CONFLICT' AND details_json->>'idempotencyKey' = $1`,
      [key],
    )).rows;

  it('proposalId existente em OUTRA conta: audit com proposal_id NULL e attemptedProposalId nos details', async () => {
    const original = uniqueProposal();
    expect((await h.evaluate.execute({ proposal: original, authenticatedAgentId: AGENT })).kind).toBe('DECISION');
    const attempt = uniqueProposal({ proposalId: original['proposalId'], accountId: 'paper-other' });
    const r = await h.evaluate.execute({ proposal: attempt, authenticatedAgentId: AGENT });
    expect(r).toEqual({ kind: 'IDEMPOTENCY_CONFLICT' });
    const rows = await auditRows(String(attempt['idempotencyKey']));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.proposal_id).toBeNull();
    expect(rows[0]?.account_id).toBe('paper-other');
    expect(rows[0]?.details_json['attemptedProposalId']).toBe(original['proposalId']);
    // Nada novo gravado para a tentativa.
    expect(await count(db.pool, 'trade_proposals', `account_id = 'paper-other'`)).toBe(0);
  });

  it('mesma conta (mesma chave, hash diferente): grava o proposalId existente', async () => {
    const original = uniqueProposal();
    expect((await h.evaluate.execute({ proposal: original, authenticatedAgentId: AGENT })).kind).toBe('DECISION');
    const attempt = { ...original, proposalId: randomUUID(), quantity: '0.0002' };
    expect(await h.evaluate.execute({ proposal: attempt, authenticatedAgentId: AGENT })).toEqual({ kind: 'IDEMPOTENCY_CONFLICT' });
    const rows = await auditRows(String(original['idempotencyKey']));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.proposal_id).toBe(original['proposalId']);
    expect(rows[0]?.account_id).toBe('paper-fixture');
    expect(rows[0]?.details_json['attemptedProposalId']).toBe(attempt.proposalId);
  });
});

describe('B4: release após o TTL', () => {
  async function isolated() {
    const iso = await createIsolatedDatabase();
    await seedAccount(iso.pool);
    await seedPolicy(iso.pool, { maxGrossExposureBase: '1.5' }); // cabe uma ordem por vez
    return { iso, local: harness(iso.pool) };
  }
  const later = (local: Harness) => {
    local.external.snapshot = { ...(local.external.snapshot ?? never()), asOf: '2026-11-13T22:00:29.000Z' };
    local.external.marketQuote = { ...(local.external.marketQuote ?? never()), asOf: '2026-11-13T22:00:29.500Z' };
    return uniqueProposal({ createdAt: '2026-11-13T22:00:20.000Z', expiresAt: '2026-11-13T22:01:00.000Z' });
  };

  it('now >= expiresAt: reserva EXPIRED, 409 {status:EXPIRED}, auditoria release-after-ttl, capacidade liberada uma vez, repetição igual', async () => {
    const { iso, local } = await isolated();
    const server = await startServer({ release: local.release, logger: local.logger });
    try {
      const first = await local.evaluate.execute({ proposal: uniqueProposal(), authenticatedAgentId: AGENT });
      if (first.kind !== 'DECISION' || first.decision.status !== 'ALLOW_PAPER') throw new Error('esperava ALLOW_PAPER');
      const d = first.decision;
      local.clock.set(d.authorizationExpiresAt ?? ''); // exatamente no limite
      const proposal = later(local);
      const blocked = await local.evaluate.execute({ proposal, authenticatedAgentId: AGENT });
      expect(blocked.kind === 'DECISION' && blocked.decision.violations.map((v) => v.code)).toContain('MAX_GROSS_EXPOSURE');

      const call = () =>
        fetch(`${server.url}/v1/risk/reservations/${d.reservationId}/release`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${EXECUTOR_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: 'cancelado' }),
        });
      for (let i = 0; i < 2; i++) {
        const res = await call();
        expect(res.status).toBe(409);
        const body = (await res.json()) as { error: { code: string; status: string } };
        expect(body.error).toMatchObject({ code: 'CONFLICT', status: 'EXPIRED' });
      }
      const { rows } = await iso.pool.query<{ status: string; paper_order_id: string | null }>('SELECT status, paper_order_id FROM risk_reservations WHERE reservation_id = $1', [d.reservationId]);
      expect(rows[0]?.status).toBe('EXPIRED');
      expect(await count(iso.pool, 'risk_audit_events', `event_type = 'RESERVATION_RELEASED'`)).toBe(0);
      const audit = await iso.pool.query<{ details_json: { trigger: string } }>(`SELECT details_json FROM risk_audit_events WHERE event_type = 'RESERVATION_EXPIRED' AND reservation_id = $1`, [d.reservationId]);
      expect(audit.rows.map((r) => r.details_json.trigger)).toEqual(['release-after-ttl']);
      // A varredura não encontra mais nada (já expirada) e a capacidade voltou: nova ordem é autorizada.
      expect(await local.expire.execute()).toBe(0);
      const retry = await local.evaluate.execute({ proposal: later(local), authenticatedAgentId: AGENT });
      expect(retry.kind === 'DECISION' && retry.decision.status).toBe('ALLOW_PAPER');
      expect(await count(iso.pool, 'risk_reservations', `status = 'ACTIVE'`)).toBe(1);
    } finally {
      await server.close();
      await iso.drop();
    }
  });

  it('1 ms antes do vencimento ainda libera (RELEASED)', async () => {
    const { iso, local } = await isolated();
    try {
      const first = await local.evaluate.execute({ proposal: uniqueProposal(), authenticatedAgentId: AGENT });
      if (first.kind !== 'DECISION') throw new Error(first.kind);
      local.clock.set('2026-11-13T22:00:29.999Z');
      expect(await local.release.execute({ principal: executorPrincipal(), reservationId: first.decision.reservationId ?? '', reason: 'x' })).toEqual({ kind: 'RELEASED', replayed: false });
    } finally {
      await iso.drop();
    }
  });
});

function never(): never {
  throw new Error('fixture ausente');
}

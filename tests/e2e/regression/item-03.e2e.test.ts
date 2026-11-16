import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { acquireSuiteLock, adminPool, call, e2eEnv, EVALUATE } from '../support/env.js';
import { accountCounts, asDecision, integrityViolations, proposalAt, seedAccountFor, uniqueAccount } from '../support/data.js';
import { agentAt, agentProposal, evaluateVia, startComposition, type Composition } from '../support/composition.js';

// Item §9.4 #3 — "Risk Engine autoriza somente PAPER após reserva atômica".
// Invariantes: I-01 (ALLOW com TTL, para a proposta exata), I-02 (registro persistido), I-04 (uma reserva por proposta),
// I-05 (falha antes do COMMIT => nenhuma autorização), I-07 (ALLOW expira; só PAPER).
// Camadas: (b) composição para ALLOW (única forma de obtê-lo: a imagem real tem fontes Unconfigured, logo só BLOCK);
// (a) imagem para provar que a proposta válida NÃO é autorizada sem fontes.
// LACUNA: ALLOW_PAPER "em produção" não é demonstrável sem as fontes reais (D-02/D-03/D-05); a prova de ALLOW vale para a
// composição de teste (mesmos casos de uso e adaptadores de produção, fontes falsas em tests/).
const env = e2eEnv();
let release: () => void;
let admin: pg.Pool;
let comp: Composition;
let account: string;
const agent = () => agentAt(comp, 0);

beforeAll(async () => {
  release = await acquireSuiteLock();
  admin = adminPool();
  comp = await startComposition();
  account = uniqueAccount();
  await seedAccountFor(admin, { accountId: account, agents: [agent().id], executors: [comp.identities.executor.id] });
});
afterAll(async () => {
  await comp.close();
  await admin.end();
  release();
});

describe('composição: ALLOW só com reserva atômica', () => {
  it('ALLOW_PAPER devolvido ⇒ decisão, reserva ACTIVE, auditoria e TTL persistidos (visíveis a outra conexão após a resposta)', async () => {
    const r = await evaluateVia(comp, agent(), agentProposal(comp, account, agent()));
    expect(r.status).toBe(200);
    const d = asDecision(r.json);
    expect(d.status).toBe('ALLOW_PAPER');
    expect(d.violations).toEqual([]);
    const row = await admin.query<{ status: string; expires_at: Date; exposure_base: string; da: Date }>(
      `SELECT r.status, r.expires_at, r.exposure_base::text, d.authorization_expires_at da FROM risk_reservations r JOIN risk_decisions d ON d.decision_id = r.decision_id WHERE r.reservation_id = $1`,
      [d.reservationId],
    );
    expect(row.rows[0]?.status).toBe('ACTIVE');
    expect(row.rows[0]?.expires_at.toISOString()).toBe(d.authorizationExpiresAt);
    expect(Number(row.rows[0]?.exposure_base)).toBeGreaterThan(0);
    // TTL de autorização: no futuro e dentro da política (30 s fictícios).
    const ttl = Date.parse(d.authorizationExpiresAt ?? '') - comp.clock.nowMs();
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30_000);
    const events = await admin.query<{ event_type: string }>('SELECT event_type FROM risk_audit_events WHERE decision_id = $1 ORDER BY event_type', [d.decisionId]);
    expect(events.rows.map((e) => e.event_type)).toEqual(expect.arrayContaining(['DECISION_RECORDED', 'RESERVATION_CREATED']));
    expect(await integrityViolations(admin, account)).toEqual([]);
  });

  it('falha ANTES do COMMIT (rollback): resposta 503 sem ALLOW e nada persistido; reenvio depois autoriza exatamente uma vez', async () => {
    const before = await accountCounts(admin, account);
    const proposal = agentProposal(comp, account, agent());
    comp.fault.armed = true;
    const failed = await evaluateVia(comp, agent(), proposal);
    comp.fault.armed = false;
    expect(failed.status).toBe(503);
    expect(failed.text).not.toContain('ALLOW_PAPER');
    expect(await accountCounts(admin, account)).toEqual(before);
    const retried = await evaluateVia(comp, agent(), proposal);
    expect(asDecision(retried.json).status).toBe('ALLOW_PAPER');
    expect(retried.headers.get('idempotent-replayed')).toBeNull();
    const after = await accountCounts(admin, account);
    expect(after).toMatchObject({ proposals: before.proposals + 1, allow: before.allow + 1, reservations: before.reservations + 1 });
    expect(await integrityViolations(admin, account)).toEqual([]);
  });

  it('BLOCK nunca carrega reserva e não ocupa capacidade', async () => {
    const before = await accountCounts(admin, account);
    const r = await evaluateVia(comp, agent(), agentProposal(comp, account, agent(), { stopLossPrice: '100.50' }));
    expect(asDecision(r.json)).toMatchObject({ status: 'BLOCK', reservationId: null, authorizationExpiresAt: null });
    expect((await accountCounts(admin, account)).reservations).toBe(before.reservations);
  });

  it('defesa em profundidade no banco (login de runtime): ALLOW sem reserva é recusado pelo CHECK; ALLOW com reserva inexistente falha no COMMIT', async () => {
    // O próprio runtime não consegue gravar uma decisão ALLOW incoerente, mesmo se o código errasse.
    const proposalId = randomUUID();
    const hash = `sha256:${'b'.repeat(64)}`;
    const client = await comp.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO trade_proposals (proposal_id, account_id, agent_id, idempotency_key, proposal_hash, payload_json, correlation_id, received_at) VALUES ($1, $2, $3, $4, $5, '{}', 'c', now())`,
        [proposalId, account, agent().id, `idem-${randomUUID()}`, hash],
      );
      await expect(
        client.query(
          `INSERT INTO risk_decisions (decision_id, proposal_id, account_id, agent_id, status, violations_json, evaluated_at, decision_json) VALUES ($1, $2, $3, $4, 'ALLOW_PAPER', '[]', now(), '{}')`,
          [randomUUID(), proposalId, account, agent().id],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO trade_proposals (proposal_id, account_id, agent_id, idempotency_key, proposal_hash, payload_json, correlation_id, received_at) VALUES ($1, $2, $3, $4, $5, '{}', 'c', now())`,
        [proposalId, account, agent().id, `idem-${randomUUID()}`, hash],
      );
      await client.query(
        `INSERT INTO risk_decisions (decision_id, proposal_id, account_id, agent_id, status, violations_json, policy_hash, snapshot_version, market_data_as_of, reservation_id, authorization_expires_at, evaluated_at, decision_json)
         VALUES ($1, $2, $3, $4, 'ALLOW_PAPER', '[]', $5, 's', now(), $6, now() + interval '30 seconds', now(), '{}')`,
        [randomUUID(), proposalId, account, agent().id, hash, randomUUID()],
      );
      await expect(client.query('COMMIT')).rejects.toMatchObject({ code: '23503' });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
    expect((await admin.query('SELECT 1 FROM trade_proposals WHERE proposal_id = $1', [proposalId])).rowCount).toBe(0);
  });
});

describe('imagem real: proposta válida sem fontes configuradas → BLOCK (fail-closed)', () => {
  it('5 propostas válidas, com política e grant → todas BLOCK, nenhuma ALLOW_PAPER, nenhuma reserva', async () => {
    const acct = uniqueAccount();
    await seedAccountFor(admin, { accountId: acct, agents: [env.agentId] });
    const results = await Promise.all(Array.from({ length: 5 }, () => call(env.baseUrl, 'POST', EVALUATE, env.agentToken, proposalAt(Date.now(), { accountId: acct, agentId: env.agentId }))));
    for (const r of results) {
      expect(r.status).toBe(200);
      expect(r.text).not.toContain('ALLOW_PAPER');
      const d = asDecision(r.json);
      expect(d.status).toBe('BLOCK');
      expect(d.violations.length).toBeGreaterThan(0);
      expect(d.reservationId).toBeNull();
    }
    expect(await accountCounts(admin, acct)).toMatchObject({ proposals: 5, decisions: 5, allow: 0, block: 5, reservations: 0 });
    expect(await integrityViolations(admin, acct)).toEqual([]);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { acquireSuiteLock, adminPool, call, e2eEnv, EVALUATE } from '../support/env.js';
import { accountCounts, asDecision, integrityViolations, proposalAt, seedAccountFor, uniqueAccount } from '../support/data.js';
import { agentAt, agentProposal, evaluateVia, startComposition, type Composition } from '../support/composition.js';

// Item §9.4 #1 — "OpenClaw emite proposta de um agente permitido".
// Invariantes: I-06 (decisão vinculada a conta/agente/proposta/política/market data/snapshot), I-02 (decisão só com
// política + inputs + registro persistido), I-05 (identidade inválida => nenhuma autorização).
// Camadas: (b) composição (fixture-agent-1..7 com grants, HTTP real, Postgres real como login de runtime) para ALLOW;
// (a) imagem real para identidade/grant (a imagem só devolve BLOCK: fontes Unconfigured).
// LACUNA DECLARADA: o OpenClaw real (agentes, gateway) não é tocado; o "simulador" é um cliente HTTP que emite o contrato
// TradeProposalV1 com a identidade do token. Sem o adaptador real não há prova de integração com os 7 agentes reais.
const env = e2eEnv();
let release: () => void;
let admin: pg.Pool;
let comp: Composition;
let account: string;

beforeAll(async () => {
  release = await acquireSuiteLock();
  admin = adminPool();
  comp = await startComposition();
  account = uniqueAccount();
  await seedAccountFor(admin, { accountId: account, agents: comp.identities.agents.map((a) => a.id), executors: [comp.identities.executor.id] });
});
afterAll(async () => {
  await comp.close();
  await admin.end();
  release();
});

describe('composição: simulador dos 7 agentes', () => {
  it('cada um dos 7 agentes com grant emite proposta e recebe ALLOW_PAPER vinculado à sua identidade (I-06)', async () => {
    const results = await Promise.all(comp.identities.agents.map((agent) => evaluateVia(comp, agent, agentProposal(comp, account, agent))));
    results.forEach((r, i) => {
      expect(r.status, `agent ${i + 1}`).toBe(200);
      const d = asDecision(r.json);
      expect(d.status).toBe('ALLOW_PAPER');
      expect(d.violations).toEqual([]);
      expect(d.agentId).toBe(comp.identities.agents[i]?.id);
      expect(d.accountId).toBe(account);
      expect(d.reservationId).toEqual(expect.any(String));
      for (const bound of [d.proposalHash, d.policyVersion, d.policyHash, d.marketDataAsOf, d.snapshotVersion, d.authorizationExpiresAt]) expect(bound).toEqual(expect.any(String));
    });
    const rows = await admin.query<{ agent_id: string; ok: boolean }>(
      `SELECT d.agent_id, (d.policy_hash IS NOT NULL AND d.snapshot_version IS NOT NULL AND d.market_data_as_of IS NOT NULL AND p.proposal_hash IS NOT NULL
         AND p.agent_id = d.agent_id AND p.account_id = d.account_id AND r.decision_id = d.decision_id) AS ok
       FROM risk_decisions d JOIN trade_proposals p ON p.proposal_id = d.proposal_id JOIN risk_reservations r ON r.reservation_id = d.reservation_id
       WHERE d.account_id = $1 ORDER BY d.agent_id`,
      [account],
    );
    expect(rows.rows.map((r) => r.agent_id)).toEqual(comp.identities.agents.map((a) => a.id));
    expect(rows.rows.every((r) => r.ok)).toBe(true);
    expect(await integrityViolations(admin, account)).toEqual([]);
  });

  it('agente com token válido mas SEM grant na conta → 403; nada gravado', async () => {
    const before = await accountCounts(admin, account);
    const r = await evaluateVia(comp, comp.identities.nogrant, agentProposal(comp, account, comp.identities.nogrant));
    expect(r.status).toBe(403);
    expect(r.text).not.toContain('ALLOW_PAPER');
    expect(await accountCounts(admin, account)).toEqual(before);
  });

  it('sem token, token desconhecido ou esquema inválido → 401; token do executor em /evaluations → 403; nada gravado', async () => {
    const before = await accountCounts(admin, account);
    const agent = agentAt(comp, 0);
    const body = agentProposal(comp, account, agent);
    expect((await call(comp.url, 'POST', EVALUATE, null, body)).status).toBe(401);
    expect((await call(comp.url, 'POST', EVALUATE, 'token-inexistente-fixture', body)).status).toBe(401);
    expect((await call(comp.url, 'POST', EVALUATE, `${agent.token}x`, body)).status).toBe(401);
    expect((await call(comp.url, 'POST', EVALUATE, comp.identities.executor.token, body)).status).toBe(403);
    expect(await accountCounts(admin, account)).toEqual(before);
  });

  it('agente A com o token de A não pode emitir em nome de B (agentId do payload ≠ identidade) → 403; nada gravado', async () => {
    const [a, b] = comp.identities.agents as [(typeof comp.identities.agents)[number], (typeof comp.identities.agents)[number]];
    const before = await accountCounts(admin, account);
    const r = await evaluateVia(comp, a, agentProposal(comp, account, b));
    expect(r.status).toBe(403);
    expect(r.text).not.toContain('ALLOW_PAPER');
    expect(await accountCounts(admin, account)).toEqual(before);
  });

  it('grant revogado: o agente passa a ser recusado (403) e o histórico anterior permanece', async () => {
    const agent = agentAt(comp, 6);
    const own = uniqueAccount();
    await seedAccountFor(admin, { accountId: own, agents: [agent.id] });
    expect((await evaluateVia(comp, agent, agentProposal(comp, own, agent))).status).toBe(200);
    await admin.query(`UPDATE risk_access_grants SET revoked_at = now(), revoked_by = 'fixture-admin' WHERE principal_id = $1 AND account_id = $2`, [agent.id, own]);
    const after = await evaluateVia(comp, agent, agentProposal(comp, own, agent));
    expect(after.status).toBe(403);
    expect((await accountCounts(admin, own)).decisions).toBe(1);
  });
});

describe('imagem real: identidade e grant', () => {
  it('token inválido → 401; agente do ciclo SEM grant → 403; COM grant → 200 BLOCK (nunca ALLOW_PAPER); executor em /evaluations → 403', async () => {
    const acct = uniqueAccount();
    await seedAccountFor(admin, { accountId: acct, agents: [], executors: [] });
    const nowMs = Date.now();
    const body = proposalAt(nowMs, { accountId: acct, agentId: env.agentId });
    expect((await call(env.baseUrl, 'POST', EVALUATE, 'tok-invalido-fixture', body)).status).toBe(401);
    expect((await call(env.baseUrl, 'POST', EVALUATE, null, body)).status).toBe(401);
    expect((await call(env.baseUrl, 'POST', EVALUATE, env.executorToken, body)).status).toBe(403);
    const denied = await call(env.baseUrl, 'POST', EVALUATE, env.agentToken, body);
    expect(denied.status).toBe(403);
    expect(denied.text).not.toContain('ALLOW_PAPER');
    expect(await accountCounts(admin, acct)).toMatchObject({ proposals: 0, decisions: 0, reservations: 0 });

    await admin.query(
      `INSERT INTO risk_access_grants (grant_id, principal_id, role, account_id, granted_at, granted_by) VALUES (gen_random_uuid(), $1, 'AGENT', $2, now(), 'fixture-admin')`,
      [env.agentId, acct],
    );
    const granted = await call(env.baseUrl, 'POST', EVALUATE, env.agentToken, body);
    expect(granted.status).toBe(200);
    expect(asDecision(granted.json)).toMatchObject({ status: 'BLOCK', agentId: env.agentId, accountId: acct, reservationId: null });
    expect(granted.text).not.toContain('ALLOW_PAPER');
    expect(await integrityViolations(admin, acct)).toEqual([]);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { acquireSuiteLock, adminPool, call, consumePath, e2eEnv, EVALUATE, releasePath } from '../support/env.js';
import { accountCounts, asDecision, integrityViolations, proposalAt, seedAccountFor, uniqueAccount, type DecisionBody } from '../support/data.js';
import { agentAt, agentProposal, evaluateVia, startComposition, type Composition } from '../support/composition.js';

// Item §9.4 #5 — "Repetição e concorrência não duplicam ordens, decisões ou exposição".
// Invariantes: I-03 (exposição reservada + aberta + pendente nunca ultrapassa o limite sob concorrência), I-04 (uma proposta
// aceita uma vez => uma reserva, uma execução), I-05 (concorrência não resolvida => nenhuma autorização indevida).
// Camadas: (b) composição (rajadas HTTP concorrentes, Postgres real como runtime); (a) imagem para replays/rajadas de BLOCK.
// LACUNA: "ordens" duplicadas não são observáveis (executor paper ausente, D-05/D-09): só paper_order_id/reserva/decisão.
const env = e2eEnv();
let release: () => void;
let admin: pg.Pool;
let comp: Composition;
const agent = () => agentAt(comp, 0);
const executor = () => comp.identities.executor;

beforeAll(async () => {
  release = await acquireSuiteLock();
  admin = adminPool(12);
  comp = await startComposition({ poolMax: 24 });
});
afterAll(async () => {
  await comp.close();
  await admin.end();
  release();
});

describe('composição: rajadas concorrentes', () => {
  it('20 requisições simultâneas da MESMA proposta → 1 decisão, 1 reserva, respostas idênticas (19 replays)', async () => {
    const account = uniqueAccount();
    await seedAccountFor(admin, { accountId: account, agents: [agent().id] });
    const proposal = agentProposal(comp, account, agent());
    const results = await Promise.all(Array.from({ length: 20 }, () => evaluateVia(comp, agent(), proposal)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => asDecision(r.json).decisionId)).size).toBe(1);
    // Corpo semanticamente idêntico (o JSONB do banco reordena as chaves; a igualdade é por conteúdo, não por bytes).
    for (const r of results) expect(r.json).toEqual(results[0]?.json);
    expect(results.filter((r) => r.headers.get('idempotent-replayed') === 'true')).toHaveLength(19);
    expect(await accountCounts(admin, account)).toMatchObject({ proposals: 1, decisions: 1, allow: 1, reservations: 1 });
    expect(await integrityViolations(admin, account)).toEqual([]);
  });

  it('mesma chave idempotente com payload alterado → 409 sem nova reserva; mesmo proposalId com chave nova → 409', async () => {
    const account = uniqueAccount();
    await seedAccountFor(admin, { accountId: account, agents: [agent().id] });
    const original = agentProposal(comp, account, agent());
    const first = await evaluateVia(comp, agent(), original);
    expect(asDecision(first.json).status).toBe('ALLOW_PAPER');
    const before = await accountCounts(admin, account);
    const altered = await evaluateVia(comp, agent(), { ...original, quantity: '0.02' });
    expect(altered.status).toBe(409);
    expect(altered.text).not.toContain('ALLOW_PAPER');
    const sameIdNewKey = await evaluateVia(comp, agent(), { ...original, idempotencyKey: 'idem-outra-chave' });
    expect(sameIdNewKey.status).toBe(409);
    expect(sameIdNewKey.text).not.toContain('ALLOW_PAPER');
    expect(await accountCounts(admin, account)).toMatchObject({ proposals: before.proposals, decisions: before.decisions, reservations: before.reservations });
    // A conta registra o conflito na auditoria.
    const conflicts = await admin.query<{ n: string }>(`SELECT count(*)::text n FROM risk_audit_events WHERE account_id = $1 AND event_type = 'IDEMPOTENCY_CONFLICT'`, [account]);
    expect(Number(conflicts.rows[0]?.n)).toBeGreaterThanOrEqual(2);
  });

  it('I-03: 30 propostas distintas simultâneas com limite global 3.5 → exatamente 3 ALLOW (1.0001 cada); exposição ativa ≤ limite', async () => {
    const account = uniqueAccount();
    await seedAccountFor(admin, { accountId: account, agents: comp.identities.agents.map((a) => a.id), policyOverrides: { maxGrossExposureBase: '3.5' } });
    const results = await Promise.all(
      Array.from({ length: 30 }, (_v, i) => {
        const a = agentAt(comp, i % 7);
        return evaluateVia(comp, a, agentProposal(comp, account, a));
      }),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    const decisions = results.map((r) => asDecision(r.json));
    expect(decisions.filter((d) => d.status === 'ALLOW_PAPER')).toHaveLength(3);
    for (const d of decisions.filter((d) => d.status === 'BLOCK')) expect(d.violations.map((v) => v.code)).toContain('MAX_GROSS_EXPOSURE');
    expect(await accountCounts(admin, account)).toMatchObject({ proposals: 30, decisions: 30, allow: 3, reservations: 3, activeReservations: 3 });
    expect(await integrityViolations(admin, account, '3.5')).toEqual([]);
  });

  it('consume e release simultâneos da mesma reserva: exatamente um vence (200) e o estado final é coerente', async () => {
    const account = uniqueAccount();
    await seedAccountFor(admin, { accountId: account, agents: [agent().id], executors: [executor().id] });
    for (let round = 0; round < 3; round += 1) {
      const d: DecisionBody = asDecision((await evaluateVia(comp, agent(), agentProposal(comp, account, agent()))).json);
      const [c, r] = await Promise.all([
        call(comp.url, 'POST', consumePath(d.decisionId), executor().token, { accountId: account, paperOrderId: `order-race-${round}-${d.decisionId}`, proposalHash: d.proposalHash }),
        call(comp.url, 'POST', releasePath(d.reservationId ?? ''), executor().token, { reason: 'corrida' }),
      ]);
      expect([c.status, r.status].filter((s) => s === 200)).toHaveLength(1);
      expect([c.status, r.status].filter((s) => s === 409)).toHaveLength(1);
      const state = (await admin.query<{ status: string; paper_order_id: string | null }>('SELECT status, paper_order_id FROM risk_reservations WHERE reservation_id = $1', [d.reservationId])).rows[0];
      expect(state?.status).toBe(c.status === 200 ? 'CONSUMED' : 'RELEASED');
      expect(state?.paper_order_id !== null).toBe(c.status === 200);
    }
    expect(await integrityViolations(admin, account)).toEqual([]);
  });

  it('replays sequenciais devolvem a decisão original (mesmo conteúdo), inclusive depois do consumo', async () => {
    const account = uniqueAccount();
    await seedAccountFor(admin, { accountId: account, agents: [agent().id], executors: [executor().id] });
    const proposal = agentProposal(comp, account, agent());
    const first = await evaluateVia(comp, agent(), proposal);
    const d = asDecision(first.json);
    expect((await call(comp.url, 'POST', consumePath(d.decisionId), executor().token, { accountId: account, paperOrderId: `order-replay-${d.decisionId}`, proposalHash: d.proposalHash })).status).toBe(200);
    for (let i = 0; i < 3; i += 1) {
      const again = await evaluateVia(comp, agent(), proposal);
      expect(again.json).toEqual(first.json);
      expect(again.headers.get('idempotent-replayed')).toBe('true');
    }
    expect(await accountCounts(admin, account)).toMatchObject({ proposals: 1, decisions: 1, reservations: 1 });
  });
});

describe('imagem real: replays e rajadas', () => {
  it('20 simultâneas da mesma proposta → 1 linha por tabela, decisão idêntica; 20 distintas → 20 decisões BLOCK; invariantes SQL', async () => {
    const account = uniqueAccount();
    await seedAccountFor(admin, { accountId: account, agents: [env.agentId] });
    const same = proposalAt(Date.now(), { accountId: account, agentId: env.agentId });
    const burst = await Promise.all(Array.from({ length: 20 }, () => call(env.baseUrl, 'POST', EVALUATE, env.agentToken, same)));
    expect(burst.every((r) => r.status === 200)).toBe(true);
    expect(new Set(burst.map((r) => asDecision(r.json).decisionId)).size).toBe(1);
    expect(burst.some((r) => r.text.includes('ALLOW_PAPER'))).toBe(false);
    expect(await accountCounts(admin, account)).toMatchObject({ proposals: 1, decisions: 1 });
    const distinct = await Promise.all(Array.from({ length: 20 }, () => call(env.baseUrl, 'POST', EVALUATE, env.agentToken, proposalAt(Date.now(), { accountId: account, agentId: env.agentId }))));
    expect(distinct.every((r) => r.status === 200)).toBe(true);
    expect(new Set(distinct.map((r) => asDecision(r.json).decisionId)).size).toBe(20);
    expect(await accountCounts(admin, account)).toMatchObject({ proposals: 21, decisions: 21, allow: 0, reservations: 0 });
    expect(await integrityViolations(admin, account)).toEqual([]);
    const changed = await call(env.baseUrl, 'POST', EVALUATE, env.agentToken, { ...same, quantity: '0.02' });
    expect(changed.status).toBe(409);
  });
});

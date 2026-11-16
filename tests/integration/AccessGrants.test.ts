import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RiskDecisionV1 } from '../../src/domain/RiskDecision.js';
import { count, createIsolatedDatabase, seedAccount, seedGrant, seedPolicy, type IsolatedDatabase } from './support/database.js';
import { AGENT, agentPrincipal, EXECUTOR, executorPrincipal, harness, uniqueProposal, type Harness } from './support/harness.js';

// Principais e contas FICTÍCIOS. A matriz de grants não representa política real de acesso.
const ACCOUNT_1 = 'paper-fixture';
const ACCOUNT_2 = 'paper-two';
const AGENTS = Array.from({ length: 7 }, (_, i) => `fixture-agent-${i + 1}`);
const ZERO_UUID = '00000000-0000-4000-8000-000000000000';

let db: IsolatedDatabase;
let h: Harness;

beforeAll(async () => {
  db = await createIsolatedDatabase();
  // seedAccount concede AGENT e executor de fixture em paper-fixture; paper-two começa sem grants.
  await seedAccount(db.pool);
  await seedAccount(db.pool, ACCOUNT_2, false);
  await seedPolicy(db.pool);
});
afterAll(async () => db.drop());
beforeEach(() => {
  h = harness(db.pool);
});

const evaluateAs = (agent: string, accountId: string, overrides: Record<string, unknown> = {}) =>
  h.evaluate.execute({ proposal: uniqueProposal({ agentId: agent, accountId, ...overrides }), authenticatedAgentId: agent });

async function authorize(): Promise<RiskDecisionV1> {
  const r = await h.evaluate.execute({ proposal: uniqueProposal(), authenticatedAgentId: AGENT });
  if (r.kind !== 'DECISION' || r.decision.status !== 'ALLOW_PAPER') throw new Error('esperava ALLOW_PAPER');
  return r.decision;
}

const reservationStatus = async (id: string | null) =>
  (await db.pool.query<{ status: string }>('SELECT status FROM risk_reservations WHERE reservation_id = $1', [id])).rows[0]?.status;

describe('avaliação exige grant AGENT na conta', () => {
  it('7 agentes x 2 contas: só o par com grant é avaliado; os demais são FORBIDDEN sem gravar nada', async () => {
    // Agente i (1..7): grant em ACCOUNT_1 se ímpar, em ACCOUNT_2 se par.
    for (const [i, agent] of AGENTS.entries()) {
      await seedGrant(db.pool, { principalId: agent, role: 'AGENT', accountId: (i + 1) % 2 === 1 ? ACCOUNT_1 : ACCOUNT_2 });
    }
    const proposalsBefore = await count(db.pool, 'trade_proposals');
    const decisionsBefore = await count(db.pool, 'risk_decisions');

    let denied = 0;
    let evaluated = 0;
    for (const [i, agent] of AGENTS.entries()) {
      const granted = (i + 1) % 2 === 1 ? ACCOUNT_1 : ACCOUNT_2;
      for (const account of [ACCOUNT_1, ACCOUNT_2]) {
        const r = await evaluateAs(agent, account);
        if (account === granted) {
          expect(r.kind, `${agent}@${account}`).toBe('DECISION');
          evaluated += 1;
        } else {
          expect(r, `${agent}@${account}`).toMatchObject({ kind: 'REJECTED', reason: 'FORBIDDEN' });
          expect(r.kind === 'REJECTED' && r.violations.map((v) => v.code)).toEqual(['UNAUTHORIZED_AGENT']);
          denied += 1;
        }
      }
    }
    expect(evaluated).toBe(7);
    expect(denied).toBe(7);
    // Somente as 7 avaliações autorizadas gravaram proposta e decisão.
    expect(await count(db.pool, 'trade_proposals')).toBe(proposalsBefore + 7);
    expect(await count(db.pool, 'risk_decisions')).toBe(decisionsBefore + 7);
    // Negações vão para o logger, não para a auditoria em banco.
    expect(h.logger.entries.filter((e) => e.event === 'evaluate.forbidden')).toHaveLength(7);
    // Nenhum evento de auditoria referencia proposta negada (não há linha em trade_proposals).
    expect(await count(db.pool, 'risk_audit_events', 'proposal_id IS NOT NULL AND proposal_id NOT IN (SELECT proposal_id FROM trade_proposals)')).toBe(0);
  });

  it('negação não escreve na auditoria', async () => {
    const before = await count(db.pool, 'risk_audit_events');
    const proposalsBefore = await count(db.pool, 'trade_proposals');
    const r = await evaluateAs('fixture-agent-nobody', ACCOUNT_1);
    expect(r).toMatchObject({ kind: 'REJECTED', reason: 'FORBIDDEN' });
    expect(await count(db.pool, 'risk_audit_events')).toBe(before);
    expect(await count(db.pool, 'trade_proposals')).toBe(proposalsBefore);
    expect(h.logger.entries.some((e) => e.event === 'evaluate.forbidden' && e.fields.principalId === 'fixture-agent-nobody')).toBe(true);
  });

  it('grant revogado → FORBIDDEN', async () => {
    await seedGrant(db.pool, { principalId: 'fixture-agent-revoked', role: 'AGENT', accountId: ACCOUNT_1, revokedAt: '2026-06-01T00:00:00Z' });
    const before = await count(db.pool, 'risk_decisions');
    expect(await evaluateAs('fixture-agent-revoked', ACCOUNT_1)).toMatchObject({ kind: 'REJECTED', reason: 'FORBIDDEN' });
    expect(await count(db.pool, 'risk_decisions')).toBe(before);
  });

  it('grant com papel PAPER_EXECUTOR não habilita avaliar como agente', async () => {
    await seedGrant(db.pool, { principalId: 'fixture-agent-wrongrole', role: 'PAPER_EXECUTOR', accountId: ACCOUNT_1 });
    expect(await evaluateAs('fixture-agent-wrongrole', ACCOUNT_1)).toMatchObject({ kind: 'REJECTED', reason: 'FORBIDDEN' });
  });

  it('replay da mesma chave idempotente por agente sem grant → FORBIDDEN, sem revelar a decisão', async () => {
    const proposal = uniqueProposal();
    const original = await h.evaluate.execute({ proposal, authenticatedAgentId: AGENT });
    expect(original.kind).toBe('DECISION');
    // Outro agente, sem grant em ACCOUNT_1, repete conta + chave (e proposalId).
    const stolen = { ...proposal, agentId: 'fixture-agent-intruder' };
    const r = await h.evaluate.execute({ proposal: stolen, authenticatedAgentId: 'fixture-agent-intruder' });
    expect(r).toMatchObject({ kind: 'REJECTED', reason: 'FORBIDDEN' });
    expect(JSON.stringify(r)).not.toContain(original.kind === 'DECISION' ? original.decision.decisionId : 'x');
  });

  it('replay após revogação do grant do próprio agente → FORBIDDEN', async () => {
    const proposal = uniqueProposal({ agentId: 'fixture-agent-late', accountId: ACCOUNT_1 });
    await seedGrant(db.pool, { principalId: 'fixture-agent-late', role: 'AGENT', accountId: ACCOUNT_1 });
    const first = await h.evaluate.execute({ proposal, authenticatedAgentId: 'fixture-agent-late' });
    expect(first.kind).toBe('DECISION');
    await db.pool.query(
      `UPDATE risk_access_grants SET revoked_at = now(), revoked_by = 'fixture-admin' WHERE principal_id = 'fixture-agent-late' AND revoked_at IS NULL`,
    );
    const replay = await h.evaluate.execute({ proposal, authenticatedAgentId: 'fixture-agent-late' });
    expect(replay).toMatchObject({ kind: 'REJECTED', reason: 'FORBIDDEN' });
  });
});

describe('trigger e índice de risk_access_grants', () => {
  const q = (sql: string, params: unknown[] = []) => db.pool.query(sql, params);

  it('DELETE é proibido', async () => {
    await expect(q(`DELETE FROM risk_access_grants`)).rejects.toThrow(/apagadas/);
  });

  it('segunda revogação é proibida', async () => {
    const id = await seedGrant(db.pool, { principalId: 'fixture-trigger-1', role: 'AGENT', accountId: ACCOUNT_2, revokedAt: '2026-06-01T00:00:00Z' });
    await expect(q(`UPDATE risk_access_grants SET revoked_at = now() WHERE grant_id = $1`, [id])).rejects.toThrow(/revogada/);
  });

  it('alterar outras colunas é proibido, com ou sem revogação', async () => {
    const id = await seedGrant(db.pool, { principalId: 'fixture-trigger-2', role: 'AGENT', accountId: ACCOUNT_2 });
    await expect(q(`UPDATE risk_access_grants SET granted_by = 'outro' WHERE grant_id = $1`, [id])).rejects.toThrow(/revogada/);
    await expect(q(`UPDATE risk_access_grants SET principal_id = 'outro' WHERE grant_id = $1`, [id])).rejects.toThrow(/revogada/);
    await expect(q(`UPDATE risk_access_grants SET account_id = $2 WHERE grant_id = $1`, [id, ACCOUNT_1])).rejects.toThrow(/revogada/);
    await expect(
      q(`UPDATE risk_access_grants SET role = 'PAPER_EXECUTOR', revoked_at = now(), revoked_by = 'x' WHERE grant_id = $1`, [id]),
    ).rejects.toThrow(/revogada/);
    // Desfazer revogação também é proibido.
    const revoked = await seedGrant(db.pool, { principalId: 'fixture-trigger-3', role: 'AGENT', accountId: ACCOUNT_2, revokedAt: '2026-06-01T00:00:00Z' });
    await expect(q(`UPDATE risk_access_grants SET revoked_at = NULL, revoked_by = NULL WHERE grant_id = $1`, [revoked])).rejects.toThrow();
    // O grant intacto continua ativo.
    expect(await count(db.pool, 'risk_access_grants', 'grant_id = $1 AND revoked_at IS NULL', [id])).toBe(1);
  });

  it('índice impede dois grants ativos iguais; após revogar, um novo é permitido', async () => {
    const id = await seedGrant(db.pool, { principalId: 'fixture-trigger-4', role: 'AGENT', accountId: ACCOUNT_2 });
    await expect(seedGrant(db.pool, { principalId: 'fixture-trigger-4', role: 'AGENT', accountId: ACCOUNT_2 })).rejects.toThrow(/one_active/);
    await q(`UPDATE risk_access_grants SET revoked_at = now(), revoked_by = 'fixture-admin' WHERE grant_id = $1`, [id]);
    await expect(seedGrant(db.pool, { principalId: 'fixture-trigger-4', role: 'AGENT', accountId: ACCOUNT_2 })).resolves.toBeTypeOf('string');
  });

  it('grant exige conta existente e papel válido', async () => {
    await expect(seedGrant(db.pool, { principalId: 'fixture-trigger-5', role: 'AGENT', accountId: 'conta-inexistente' })).rejects.toThrow();
    await expect(q(`UPDATE risk_access_grants SET role = 'ADMIN' WHERE false`)).resolves.toBeDefined();
    await expect(
      q(`INSERT INTO risk_access_grants (grant_id, principal_id, role, account_id, granted_at, granted_by)
         VALUES (gen_random_uuid(), 'fixture-trigger-6', 'ADMIN', $1, now(), 'x')`, [ACCOUNT_1]),
    ).rejects.toThrow(/check/i);
  });
});

describe('ConsumePaperAuthorization e grants', () => {
  it('AGENT não consome; executor sem grant não consome; reserva continua ACTIVE', async () => {
    const d = await authorize();
    const base = { decisionId: d.decisionId, accountId: d.accountId, paperOrderId: 'order-forbidden', proposalHash: d.proposalHash };
    expect(await h.consume.execute({ ...base, principal: agentPrincipal() })).toEqual({ kind: 'FORBIDDEN' });
    expect(await h.consume.execute({ ...base, principal: executorPrincipal('executor-nogrant') })).toEqual({ kind: 'FORBIDDEN' });
    expect(await h.consume.execute({ ...base, principal: executorPrincipal(AGENT) })).toEqual({ kind: 'FORBIDDEN' });
    expect(await reservationStatus(d.reservationId)).toBe('ACTIVE');
    expect(await count(db.pool, 'risk_audit_events', `event_type = 'RESERVATION_CONSUMED' AND decision_id = $1`, [d.decisionId])).toBe(0);
  });

  it('executor com grant revogado não consome', async () => {
    await seedGrant(db.pool, { principalId: 'executor-revoked', role: 'PAPER_EXECUTOR', accountId: ACCOUNT_1, revokedAt: '2026-06-01T00:00:00Z' });
    const d = await authorize();
    const r = await h.consume.execute({ principal: executorPrincipal('executor-revoked'), decisionId: d.decisionId, accountId: d.accountId, paperOrderId: 'o', proposalHash: d.proposalHash });
    expect(r).toEqual({ kind: 'FORBIDDEN' });
    expect(await reservationStatus(d.reservationId)).toBe('ACTIVE');
  });

  it('proposalHash divergente → NOT_AUTHORIZED PROPOSAL_MISMATCH, reserva intacta', async () => {
    const d = await authorize();
    const wrong = `sha256:${'0'.repeat(64)}`;
    const r = await h.consume.execute({ principal: executorPrincipal(), decisionId: d.decisionId, accountId: d.accountId, paperOrderId: 'o', proposalHash: wrong });
    expect(r).toEqual({ kind: 'NOT_AUTHORIZED', reason: 'PROPOSAL_MISMATCH' });
    expect(await reservationStatus(d.reservationId)).toBe('ACTIVE');
  });

  it('accountId diferente da decisão (executor com grant nas duas contas) → NOT_FOUND (sem oráculo de existência)', async () => {
    await seedGrant(db.pool, { principalId: 'executor-both', role: 'PAPER_EXECUTOR', accountId: ACCOUNT_1 });
    await seedGrant(db.pool, { principalId: 'executor-both', role: 'PAPER_EXECUTOR', accountId: ACCOUNT_2 });
    const d = await authorize();
    const r = await h.consume.execute({ principal: executorPrincipal('executor-both'), decisionId: d.decisionId, accountId: ACCOUNT_2, paperOrderId: 'o', proposalHash: d.proposalHash });
    expect(r).toEqual({ kind: 'NOT_FOUND' });
    expect(await reservationStatus(d.reservationId)).toBe('ACTIVE');
    expect(h.logger.entries.some((e) => e.event === 'consume.account_mismatch')).toBe(true);
    // Mesma resposta de uma decisão inexistente.
    expect(await h.consume.execute({ principal: executorPrincipal('executor-both'), decisionId: ZERO_UUID, accountId: ACCOUNT_2, paperOrderId: 'o', proposalHash: d.proposalHash })).toEqual({ kind: 'NOT_FOUND' });
  });

  it('executor só da outra conta não consome decisão desta (FORBIDDEN na conta informada)', async () => {
    await seedGrant(db.pool, { principalId: 'executor-two-only', role: 'PAPER_EXECUTOR', accountId: ACCOUNT_2 });
    const d = await authorize();
    const r = await h.consume.execute({ principal: executorPrincipal('executor-two-only'), decisionId: d.decisionId, accountId: d.accountId, paperOrderId: 'o', proposalHash: d.proposalHash });
    expect(r).toEqual({ kind: 'FORBIDDEN' });
    expect(await reservationStatus(d.reservationId)).toBe('ACTIVE');
  });

  it('executor com grant consome normalmente', async () => {
    const d = await authorize();
    const r = await h.consume.execute({ principal: executorPrincipal(), decisionId: d.decisionId, accountId: d.accountId, paperOrderId: 'order-ok', proposalHash: d.proposalHash });
    expect(r).toEqual({ kind: 'CONSUMED', reservationId: d.reservationId, replayed: false });
  });
});

describe('ReleaseRiskReservation e grants', () => {
  it('executor sem grant na conta → NOT_FOUND e reserva intacta; AGENT → FORBIDDEN', async () => {
    const d = await authorize();
    const id = d.reservationId ?? '';
    expect(await h.release.execute({ principal: executorPrincipal('executor-nogrant'), reservationId: id, reason: 'x' })).toEqual({ kind: 'NOT_FOUND' });
    expect(await h.release.execute({ principal: agentPrincipal(), reservationId: id, reason: 'x' })).toEqual({ kind: 'FORBIDDEN' });
    expect(await reservationStatus(id)).toBe('ACTIVE');
    // Mesma resposta para reserva inexistente: sem oráculo de existência.
    expect(await h.release.execute({ principal: executorPrincipal('executor-nogrant'), reservationId: ZERO_UUID, reason: 'x' })).toEqual({ kind: 'NOT_FOUND' });
  });

  it('executor com grant libera', async () => {
    const d = await authorize();
    expect(await h.release.execute({ principal: executorPrincipal(), reservationId: d.reservationId ?? '', reason: 'x' })).toEqual({ kind: 'RELEASED', replayed: false });
  });
});

describe('GetRiskDecision e grants', () => {
  it('o agente dono lê a própria decisão', async () => {
    const d = await authorize();
    const r = await h.get.execute({ principal: agentPrincipal(), decisionId: d.decisionId });
    expect(r).toMatchObject({ kind: 'FOUND', decision: { decisionId: d.decisionId } });
  });

  it('outro agente com grant na mesma conta → NOT_FOUND (igual a inexistente)', async () => {
    await seedGrant(db.pool, { principalId: 'agent-fixture-forex', role: 'AGENT', accountId: ACCOUNT_1 });
    const d = await authorize();
    expect(await h.get.execute({ principal: agentPrincipal('agent-fixture-forex'), decisionId: d.decisionId })).toEqual({ kind: 'NOT_FOUND' });
    expect(await h.get.execute({ principal: agentPrincipal('agent-fixture-forex'), decisionId: ZERO_UUID })).toEqual({ kind: 'NOT_FOUND' });
  });

  it('agente dono com grant revogado → NOT_FOUND', async () => {
    const proposal = uniqueProposal({ agentId: 'fixture-agent-getrev', accountId: ACCOUNT_1 });
    await seedGrant(db.pool, { principalId: 'fixture-agent-getrev', role: 'AGENT', accountId: ACCOUNT_1 });
    const r = await h.evaluate.execute({ proposal, authenticatedAgentId: 'fixture-agent-getrev' });
    if (r.kind !== 'DECISION') throw new Error(r.kind);
    await db.pool.query(`UPDATE risk_access_grants SET revoked_at = now(), revoked_by = 'fixture-admin' WHERE principal_id = 'fixture-agent-getrev'`);
    expect(await h.get.execute({ principal: agentPrincipal('fixture-agent-getrev'), decisionId: r.decision.decisionId })).toEqual({ kind: 'NOT_FOUND' });
  });

  it('executor da conta lê; executor de outra conta → NOT_FOUND', async () => {
    await seedGrant(db.pool, { principalId: 'executor-two-get', role: 'PAPER_EXECUTOR', accountId: ACCOUNT_2 });
    const d = await authorize();
    expect(await h.get.execute({ principal: executorPrincipal(EXECUTOR), decisionId: d.decisionId })).toMatchObject({ kind: 'FOUND' });
    expect(await h.get.execute({ principal: executorPrincipal('executor-two-get'), decisionId: d.decisionId })).toEqual({ kind: 'NOT_FOUND' });
    expect(await h.get.execute({ principal: executorPrincipal('executor-nogrant'), decisionId: d.decisionId })).toEqual({ kind: 'NOT_FOUND' });
  });

  it('id que não é UUID → NOT_FOUND, sem consultar o banco', async () => {
    for (const id of ['', 'nao-e-uuid', "1' OR '1'='1", ' '.repeat(3)]) {
      expect(await h.get.execute({ principal: agentPrincipal(), decisionId: id })).toEqual({ kind: 'NOT_FOUND' });
    }
  });
});

describe('ids não-UUID em consume e release', () => {
  it.each(['', 'nao-e-uuid', "1' OR '1'='1", '00000000-0000-0000-0000-00000000000g'])('%j → NOT_FOUND sem log de erro e sem gravar', async (id) => {
    const audit = await count(db.pool, 'risk_audit_events');
    const c = await h.consume.execute({ principal: executorPrincipal(), decisionId: id, accountId: ACCOUNT_1, paperOrderId: 'o', proposalHash: `sha256:${'0'.repeat(64)}` });
    const r = await h.release.execute({ principal: executorPrincipal(), reservationId: id, reason: 'x' });
    expect(c).toEqual({ kind: 'NOT_FOUND' });
    expect(r).toEqual({ kind: 'NOT_FOUND' });
    expect(h.logger.entries.filter((e) => e.level === 'error')).toEqual([]);
    expect(await count(db.pool, 'risk_audit_events')).toBe(audit);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { acquireSuiteLock, adminPool, appDbDeadlines, call, consumePath, docker, e2eEnv, EVALUATE, startApp, waitFor, withDatabasePaused } from './support/env.js';
import { accountCounts, asDecision, integrityViolations, proposalAt, seedAccountFor, uniqueAccount, type DecisionBody } from './support/data.js';
import { agentAt, agentProposal, evaluateVia, startComposition, type Composition } from './support/composition.js';

// Prazo do cliente na APP REAL (imagem), banco congelado com `docker pause` (só o contêiner com a label do ciclo; withDatabasePaused
// recusa qualquer outro). Invariante I-05: falha de dependência => nenhuma autorização, resposta em tempo finito (503), nada gravado.
// Teto de resposta derivado dos timeouts de scripts/test-e2e.sh: CONNECTION + STATEMENT por comando, mais folga explícita.
const env = e2eEnv();
const SLACK_MS = 5000;
let release: () => void;
let admin: pg.Pool;
let comp: Composition;
let account = '';
let decision: DecisionBody;

beforeAll(async () => {
  release = await acquireSuiteLock();
  await startApp();
  admin = adminPool(3);
  comp = await startComposition();
  account = uniqueAccount();
  // Agente da composição cria o ALLOW (a imagem real só emite BLOCK); o executor da IMAGEM é quem consome.
  await seedAccountFor(admin, { accountId: account, agents: [agentAt(comp, 0).id, env.agentId], executors: [env.executorId], policyOverrides: { maxAuthorizationTtlMs: 600_000 } });
  decision = asDecision((await evaluateVia(comp, agentAt(comp, 0), agentProposal(comp, account, agentAt(comp, 0)))).json);
  expect(decision.status).toBe('ALLOW_PAPER');
});
afterAll(async () => {
  await comp.close();
  await admin.end();
  release();
});

const bound = (): number => appDbDeadlines().commandMs + SLACK_MS;
const imageEvaluate = (timeoutMs: number) => call(env.baseUrl, 'POST', EVALUATE, env.agentToken, proposalAt(Date.now(), { accountId: account, agentId: env.agentId }), timeoutMs);

describe('app real com o banco congelado: evaluate e consume → 503 em tempo finito, nunca ALLOW', { timeout: 180_000 }, () => {
  it('o teto vem dos timeouts do script (sanidade do derivado)', () => {
    const d = appDbDeadlines();
    expect(d.commandMs).toBe(d.connectionMs + d.statementMs);
    expect(d.connectionMs).toBeGreaterThan(0);
    expect(d.statementMs).toBeGreaterThan(0);
  });

  it('evaluate (conexão ociosa congelada e rajada concorrente) → 503 dentro do teto, sem ALLOW e sem gravar nada; após unpause volta ao normal', async () => {
    // Aquece o pool: deixa conexões ociosas, que ficarão congeladas.
    expect((await imageEvaluate(20_000)).status).toBe(200);
    const before = await accountCounts(admin, account);
    const proposals = Array.from({ length: 6 }, () => proposalAt(Date.now(), { accountId: account, agentId: env.agentId }));
    const results = await withDatabasePaused(async () => {
      const started = Date.now();
      const settled = await Promise.all(
        proposals.map(async (p) => {
          const r = await call(env.baseUrl, 'POST', EVALUATE, env.agentToken, p, bound() + 10_000);
          return { r, elapsed: Date.now() - started };
        }),
      );
      return settled;
    });
    for (const { r, elapsed } of results) {
      expect(r.status).toBe(503);
      expect(r.text).not.toContain('ALLOW_PAPER');
      expect(r.text).not.toMatch(/prazo|timeout|ECONN|postgres|password|at .*\(/i);
      expect(elapsed).toBeLessThan(bound());
    }
    await waitFor('app ready', async () => (await call(env.baseUrl, 'GET', '/health/ready', null)).status === 200, 90_000);
    // Nada foi gravado pelas propostas do período congelado (nem depois do unpause: conexões destruídas).
    expect(await accountCounts(admin, account)).toEqual(before);
    for (const p of proposals) expect((await admin.query('SELECT 1 FROM trade_proposals WHERE proposal_id = $1', [p['proposalId']])).rowCount).toBe(0);
    // Normal de novo: a mesma proposta (idempotência) agora é avaliada, e BLOCK (fontes Unconfigured), nunca ALLOW.
    const again = await call(env.baseUrl, 'POST', EVALUATE, env.agentToken, proposals[0]);
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ status: 'BLOCK', reservationId: null });
    expect(await integrityViolations(admin, account)).toEqual([]);
  });

  it('consume (executor da imagem) → 503 dentro do teto; a reserva segue ACTIVE e sem ordem; após unpause o consumo acontece uma única vez', async () => {
    // Aquece o pool com uma consulta autenticada (GET da decisão).
    expect((await call(env.baseUrl, 'GET', `/v1/risk/decisions/${decision.decisionId}`, env.executorToken)).status).toBe(200);
    const body = { accountId: account, paperOrderId: 'order-deadline-1', proposalHash: decision.proposalHash };
    const started = Date.now();
    const during = await withDatabasePaused(async () => {
      const r = await call(env.baseUrl, 'POST', consumePath(decision.decisionId), env.executorToken, body, bound() + 10_000);
      return { r, elapsed: Date.now() - started };
    });
    expect(during.r.status).toBe(503);
    expect(during.r.text).not.toMatch(/CONSUMED|prazo|timeout|ECONN|postgres|password/i);
    expect(during.elapsed).toBeLessThan(bound());
    await waitFor('app ready', async () => (await call(env.baseUrl, 'GET', '/health/ready', null)).status === 200, 90_000);
    const row = (await admin.query<{ status: string; paper_order_id: string | null }>('SELECT status, paper_order_id FROM risk_reservations WHERE reservation_id = $1', [decision.reservationId])).rows[0];
    expect(row).toEqual({ status: 'ACTIVE', paper_order_id: null });
    const ok = await call(env.baseUrl, 'POST', consumePath(decision.decisionId), env.executorToken, body);
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ status: 'CONSUMED' });
    // Reenvio da mesma ordem: idempotente; outra ordem: conflito (uma ordem por autorização).
    expect((await call(env.baseUrl, 'POST', consumePath(decision.decisionId), env.executorToken, body)).json).toMatchObject({ status: 'CONSUMED', replayed: true });
    expect((await call(env.baseUrl, 'POST', consumePath(decision.decisionId), env.executorToken, { ...body, paperOrderId: 'order-deadline-2' })).status).toBe(409);
    expect(await integrityViolations(admin, account)).toEqual([]);
  });

  it('a app não reiniciou, segue viva e registrou a falha de banco como métrica (dependencyFailure DATABASE)', () => {
    expect(docker(['inspect', '--format', '{{.State.Running}} {{.RestartCount}}', env.appContainer]).trim()).toBe('true 0');
    const logs = docker(['logs', '--since', '10m', env.appContainer]);
    expect(logs).toMatch(/"event":"metric\.dependency_failure"[^\n]*"kind":"DATABASE"/);
    expect(logs).not.toMatch(/postgres(ql)?:\/\/|password|\n\s+at .*\(/i);
  });
});

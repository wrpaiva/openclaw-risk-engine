import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { acquireSuiteLock, adminPool, call, consumePath, e2eEnv, EVALUATE, releasePath } from '../support/env.js';
import { accountCounts, asDecision, integrityViolations, proposalAt, seedAccountFor, uniqueAccount, type DecisionBody } from '../support/data.js';
import { agentAt, agentProposal, evaluateVia, startComposition, type Composition } from '../support/composition.js';

// Item §9.4 #4 — "Paper executor consome autorização uma única vez, cria ordem simulada e atualiza posição/P&L".
// Invariantes: I-01 (consumo só com ALLOW válido, não expirado, para a proposta exata), I-04 (uma autorização => uma
// execução; paper_order_id único), I-07 (autorização expira).
// Camadas: (b) composição (ALLOW) + stub de executor (cliente HTTP com token PAPER_EXECUTOR); (a) imagem para os erros
// de transporte do consume.
// LACUNA DECLARADA: ordem simulada, posição e P&L NÃO existem (D-05/D-09 em aberto; executor paper é fora da fase). O stub só
// chama /consume e registra o paperOrderId; "criar ordem" e "atualizar posição/P&L" ficam sem cobertura.
const env = e2eEnv();
let release: () => void;
let admin: pg.Pool;
let comp: Composition;
let account: string;
const agent = () => agentAt(comp, 0);
const executor = () => comp.identities.executor;
let seq = 0;

beforeAll(async () => {
  release = await acquireSuiteLock();
  admin = adminPool();
  comp = await startComposition();
  account = uniqueAccount();
  await seedAccountFor(admin, { accountId: account, agents: [agent().id], executors: [executor().id] });
});
afterAll(async () => {
  await comp.close();
  await admin.end();
  release();
});

const orderId = (): string => `order-e2e-${Date.now()}-${++seq}`;
const consume = (d: DecisionBody, paperOrderId: string, overrides: Record<string, unknown> = {}, token = executor().token) =>
  call(comp.url, 'POST', consumePath(d.decisionId), token, { accountId: d.accountId, paperOrderId, proposalHash: d.proposalHash, ...overrides });
async function allow(): Promise<DecisionBody> {
  const r = await evaluateVia(comp, agent(), agentProposal(comp, account, agent()));
  const d = asDecision(r.json);
  expect(d.status).toBe('ALLOW_PAPER');
  return d;
}
const reservation = async (id: string | null) => (await admin.query<{ status: string; paper_order_id: string | null }>('SELECT status, paper_order_id FROM risk_reservations WHERE reservation_id = $1', [id])).rows[0];

describe('stub de executor: consumo único', () => {
  it('consome uma vez (200), repete a mesma ordem (200 replayed), outra ordem → 409; reserva CONSUMED com o paper_order_id', async () => {
    const d = await allow();
    const order = orderId();
    const first = await consume(d, order);
    expect(first.status).toBe(200);
    expect(first.json).toEqual({ status: 'CONSUMED', reservationId: d.reservationId, replayed: false });
    expect((await consume(d, order)).json).toMatchObject({ status: 'CONSUMED', replayed: true });
    const second = await consume(d, orderId());
    expect(second.status).toBe(409);
    expect((second.json['error'] as { code: string }).code).toBe('CONFLICT');
    expect(await reservation(d.reservationId)).toEqual({ status: 'CONSUMED', paper_order_id: order });
    expect(await integrityViolations(admin, account)).toEqual([]);
  });

  it('paper_order_id é único entre autorizações: reutilizá-lo em outra decisão falha e não consome', async () => {
    const a = await allow();
    const b = await allow();
    const order = orderId();
    expect((await consume(a, order)).status).toBe(200);
    const reuse = await consume(b, order);
    expect(reuse.status).toBeGreaterThanOrEqual(400);
    expect(reuse.text).not.toContain('"CONSUMED"');
    expect((await reservation(b.reservationId))?.status).toBe('ACTIVE');
    const n = await admin.query<{ n: string }>('SELECT count(*)::text n FROM risk_reservations WHERE paper_order_id = $1', [order]);
    expect(n.rows[0]?.n).toBe('1');
  });

  it('10 consumos concorrentes com ordens distintas na MESMA autorização: exatamente um 200; os demais 409; uma ordem gravada', async () => {
    const d = await allow();
    const results = await Promise.all(Array.from({ length: 10 }, () => consume(d, orderId())));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(9);
    const stored = await reservation(d.reservationId);
    expect(stored?.status).toBe('CONSUMED');
    expect(stored?.paper_order_id).toEqual(expect.any(String));
  });

  it('10 consumos concorrentes com a MESMA ordem: todos 200, exatamente um não-replay', async () => {
    const d = await allow();
    const order = orderId();
    const results = await Promise.all(Array.from({ length: 10 }, () => consume(d, order)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.json['replayed'] === false)).toHaveLength(1);
  });

  it('UT-020 consumo após o TTL da autorização → 409 e a reserva NÃO fica CONSUMED (expira)', async () => {
    const d = await allow();
    comp.clock.advance(30_000); // exatamente no vencimento (autorização vale até < expiresAt)
    const late = await consume(d, orderId());
    comp.clock.advance(-30_000);
    expect(late.status).toBe(409);
    expect((late.json['error'] as { code: string }).code).toBe('NOT_AUTHORIZED');
    expect((await reservation(d.reservationId))?.status).not.toBe('CONSUMED');
  });

  it('consumo com hash de proposta errado, conta errada ou token de agente → nunca 200', async () => {
    const d = await allow();
    expect((await consume(d, orderId(), { proposalHash: `sha256:${'0'.repeat(64)}` })).status).not.toBe(200);
    expect((await consume(d, orderId(), { accountId: 'paper-e2e-outra-conta' })).status).not.toBe(200);
    expect((await consume(d, orderId(), {}, agent().token)).status).toBe(403);
    expect((await consume(d, orderId(), {}, 'tok-invalido-fixture')).status).toBe(401);
    expect((await reservation(d.reservationId))?.status).toBe('ACTIVE');
  });

  it('decisão BLOCK não é consumível; reserva liberada não é consumível', async () => {
    const blocked = asDecision((await evaluateVia(comp, agent(), agentProposal(comp, account, agent(), { stopLossPrice: '100.50' }))).json);
    expect(blocked.status).toBe('BLOCK');
    const c = await consume(blocked, orderId());
    expect(c.status).toBe(409);
    const d = await allow();
    expect((await call(comp.url, 'POST', releasePath(d.reservationId ?? ''), executor().token, { reason: 'cancelado' })).status).toBe(200);
    const after = await consume(d, orderId());
    expect(after.status).toBe(409);
    expect((await reservation(d.reservationId))?.status).toBe('RELEASED');
  });
});

describe('imagem real: erros de transporte do consume', () => {
  it('decisão BLOCK da imagem → 409 NOT_AUTHORIZED; executor sem grant → 403/404; agente → 403; id inexistente → 404', async () => {
    const acct = uniqueAccount();
    await seedAccountFor(admin, { accountId: acct, agents: [env.agentId], executors: [env.executorId] });
    const e = asDecision((await call(env.baseUrl, 'POST', EVALUATE, env.agentToken, proposalAt(Date.now(), { accountId: acct, agentId: env.agentId }))).json);
    expect(e.status).toBe('BLOCK');
    const body = { accountId: acct, paperOrderId: 'order-e2e-image-1', proposalHash: e.proposalHash };
    const blockConsume = await call(env.baseUrl, 'POST', consumePath(e.decisionId), env.executorToken, body);
    expect(blockConsume.status).toBe(409);
    expect((blockConsume.json['error'] as { code: string }).code).toBe('NOT_AUTHORIZED');
    expect((await call(env.baseUrl, 'POST', consumePath(e.decisionId), env.agentToken, body)).status).toBe(403);
    expect((await call(env.baseUrl, 'POST', consumePath('00000000-0000-4000-8000-000000000000'), env.executorToken, body)).status).toBe(404);
    expect((await call(env.baseUrl, 'POST', consumePath(e.decisionId), null, body)).status).toBe(401);
    expect(await accountCounts(admin, acct)).toMatchObject({ allow: 0, reservations: 0 });
    const consumed = await admin.query<{ n: string }>(`SELECT count(*)::text n FROM risk_reservations WHERE account_id = $1 AND paper_order_id IS NOT NULL`, [acct]);
    expect(consumed.rows[0]?.n).toBe('0');
  });
});

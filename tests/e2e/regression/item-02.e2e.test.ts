import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { acquireSuiteLock, adminPool, call, docker, e2eEnv, EVALUATE } from '../support/env.js';
import { accountCounts, asDecision, integrityViolations, proposalAt, seedAccountFor, uniqueAccount } from '../support/data.js';
import { agentAt, agentProposal, evaluateVia, startComposition, type Composition } from '../support/composition.js';

// Item §9.4 #2 — "Risk Engine bloqueia proposta inválida com auditoria".
// Invariantes: I-05 (timestamps, escala e dados velhos => nenhuma autorização), I-02 (decisão só com registro persistido),
// I-06 (BLOCK também vinculado a conta/agente/proposta/hash).
// Decisão do usuário: proposta com CONTRATO inválido (422) não é persistida e só aparece em LOG; BLOCK de DOMÍNIO (200) é
// persistido com auditoria (DECISION_RECORDED).
// Camadas: (b) composição para BLOCKs de regra e fronteiras (idade == limite); (a) imagem para 422 + log.
// LACUNA: a classificação 422 vs BLOCK segue o contrato atual; códigos de violação do 422 não são gravados em log (só
// http.request com status 422), apenas devolvidos no corpo ao agente autenticado.
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
  await seedAccountFor(admin, { accountId: account, agents: comp.identities.agents.map((a) => a.id), executors: [comp.identities.executor.id] });
});
afterAll(async () => {
  await comp.close();
  await admin.end();
  release();
});

const codes = (json: Record<string, unknown>): string[] => asDecision(json).violations.map((v) => v.code);

describe('BLOCK de domínio: persistido, auditado, sem reserva', () => {
  it.each([
    ['UT-001 BUY com stop igual à entrada', { stopLossPrice: '100.00' }, 'INVALID_STOP_LOSS'],
    ['UT-001 BUY com stop acima da entrada', { stopLossPrice: '100.01' }, 'INVALID_STOP_LOSS'],
    ['UT-002 SELL com stop igual à entrada', { side: 'SELL', stopLossPrice: '100.00' }, 'INVALID_STOP_LOSS'],
    ['UT-002 SELL com stop abaixo da entrada', { side: 'SELL', stopLossPrice: '99.99' }, 'INVALID_STOP_LOSS'],
    ['UT-003 escala proibida (5 casas > 4 do instrumento)', { quantity: '0.00001' }, 'ANY'],
    ['UT-020 proposta vencida (expiresAt no passado)', { expiresAt: '2020-01-01T00:00:00.000Z', createdAt: '2019-12-31T23:59:30.000Z' }, 'ANY'],
    ['createdAt no futuro além da tolerância de relógio', { createdAt: '2099-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:30.000Z' }, 'ANY'],
  ] as const)('%s → 200 BLOCK %s', async (_label, overrides, code) => {
    const before = await accountCounts(admin, account);
    const r = await evaluateVia(comp, agent(), agentProposal(comp, account, agent(), overrides));
    expect(r.status).toBe(200);
    expect(r.text).not.toContain('ALLOW_PAPER');
    const d = asDecision(r.json);
    expect(d.status).toBe('BLOCK');
    if (code === 'ANY') expect(codes(r.json).length).toBeGreaterThan(0);
    else expect(codes(r.json)).toContain(code);
    expect(d.reservationId).toBeNull();
    expect(d.authorizationExpiresAt).toBeNull();
    const after = await accountCounts(admin, account);
    expect(after).toMatchObject({ proposals: before.proposals + 1, decisions: before.decisions + 1, block: before.block + 1, reservations: before.reservations });
    // Auditoria: a decisão tem evento DECISION_RECORDED e a proposta está gravada com o hash.
    const audit = await admin.query<{ n: string }>(`SELECT count(*)::text n FROM risk_audit_events WHERE decision_id = $1 AND event_type = 'DECISION_RECORDED'`, [d.decisionId]);
    expect(audit.rows[0]?.n).toBe('1');
    const stored = await admin.query<{ proposal_hash: string }>('SELECT proposal_hash FROM trade_proposals WHERE proposal_id = $1', [d.proposalId]);
    expect(stored.rows[0]?.proposal_hash).toBe(d.proposalHash);
  });

  it('UT-005 fronteira: cotação com idade IGUAL ao limite é velha; 1 ms a menos autoriza', async () => {
    comp.sources.quoteAgeMs = 5000;
    const stale = await evaluateVia(comp, agent(), agentProposal(comp, account, agent()));
    expect(stale.status).toBe(200);
    expect(codes(stale.json)).toContain('MARKET_DATA_STALE');
    expect(asDecision(stale.json).status).toBe('BLOCK');
    comp.sources.quoteAgeMs = 4999;
    const fresh = await evaluateVia(comp, agent(), agentProposal(comp, account, agent()));
    expect(asDecision(fresh.json).status).toBe('ALLOW_PAPER');
    comp.sources.quoteAgeMs = 500;
  });

  it('UT-006 fronteira: snapshot com idade IGUAL ao limite → ACCOUNT_SNAPSHOT_STALE', async () => {
    comp.sources.snapshotAgeMs = 5000;
    const r = await evaluateVia(comp, agent(), agentProposal(comp, account, agent()));
    expect(codes(r.json)).toContain('ACCOUNT_SNAPSHOT_STALE');
    expect(asDecision(r.json).status).toBe('BLOCK');
    comp.sources.snapshotAgeMs = 1000;
  });

  it('UT-004 sem cotação confiável → BLOCK MARKET_DATA_UNAVAILABLE', async () => {
    comp.sources.quoteMissing = true;
    const r = await evaluateVia(comp, agent(), agentProposal(comp, account, agent()));
    comp.sources.quoteMissing = false;
    expect(codes(r.json)).toContain('MARKET_DATA_UNAVAILABLE');
    expect(asDecision(r.json).status).toBe('BLOCK');
  });

  it('UT-008 exposição global: limite exato permite, 0,01 acima bloqueia (MAX_GROSS_EXPOSURE)', async () => {
    // Notional de uma ordem de 0.01 a ask 100.01 = 1.0001. Conta própria com limite global exatamente igual a esse notional.
    const exact = uniqueAccount();
    await seedAccountFor(admin, { accountId: exact, agents: [agent().id], policyOverrides: { maxGrossExposureBase: '1.0001' } });
    const ok = await evaluateVia(comp, agent(), agentProposal(comp, exact, agent()));
    expect(asDecision(ok.json).status).toBe('ALLOW_PAPER');
    // A segunda ordem excede em 1.0001 > 0,01 o limite remanescente.
    const over = await evaluateVia(comp, agent(), agentProposal(comp, exact, agent()));
    expect(asDecision(over.json).status).toBe('BLOCK');
    expect(codes(over.json)).toContain('MAX_GROSS_EXPOSURE');
    expect(await integrityViolations(admin, exact, '1.0001')).toEqual([]);
  });

  it('fonte de snapshot lançando exceção → 503, rollback total, nada gravado e nenhum ALLOW', async () => {
    const before = await accountCounts(admin, account);
    comp.sources.failSnapshot = true;
    const r = await evaluateVia(comp, agent(), agentProposal(comp, account, agent()));
    comp.sources.failSnapshot = false;
    expect(r.status).toBe(503);
    expect(r.text).not.toContain('ALLOW_PAPER');
    expect(await accountCounts(admin, account)).toEqual(before);
  });
});

describe('contrato inválido: 422, sem persistência (decisão do usuário)', () => {
  const invalid: [string, Record<string, unknown>][] = [
    ['UT-003 quantidade zero', { quantity: '0' }],
    ['UT-003 quantidade negativa', { quantity: '-1' }],
    ['UT-003 notação exponencial', { quantity: '1e3' }],
    ['UT-016 ambiente LIVE', { environment: 'LIVE' }],
    ['campo extra não previsto', { orderTypeX: 'x' }],
  ];
  it.each(invalid)('%s → 422, nada gravado', async (_label, overrides) => {
    const before = await accountCounts(admin, account);
    const r = await evaluateVia(comp, agent(), agentProposal(comp, account, agent(), overrides));
    expect(r.status).toBe(422);
    expect(r.text).not.toContain('ALLOW_PAPER');
    expect(await accountCounts(admin, account)).toEqual(before);
  });

  it('JSON malformado → 400; corpo grande demais → 413; nada gravado', async () => {
    const before = await accountCounts(admin, account);
    const bad = await fetch(`${comp.url}${EVALUATE}`, { method: 'POST', headers: { Authorization: `Bearer ${agent().token}`, 'Content-Type': 'application/json' }, body: '{"schemaVersion":' });
    expect(bad.status).toBe(400);
    const big = await call(comp.url, 'POST', EVALUATE, agent().token, { pad: 'x'.repeat(70_000) });
    expect(big.status).toBe(413);
    expect(await accountCounts(admin, account)).toEqual(before);
  });
});

describe('imagem real: 422 só em log, sem linha no banco', () => {
  it('proposta com quantidade exponencial → 422; o log do contêiner registra http.request 422 sem token nem payload; banco inalterado', async () => {
    const acct = uniqueAccount();
    await seedAccountFor(admin, { accountId: acct, agents: [env.agentId] });
    const since = new Date().toISOString();
    const before = await accountCounts(admin, acct);
    const marker = `corr-e2e-422-${Date.now()}`;
    const r = await call(env.baseUrl, 'POST', EVALUATE, env.agentToken, proposalAt(Date.now(), { accountId: acct, agentId: env.agentId, quantity: '1e3', correlationId: marker }));
    expect(r.status).toBe(422);
    expect(await accountCounts(admin, acct)).toEqual(before);
    const log = docker(['logs', '--since', since, env.appContainer]);
    const lines = log.split('\n').filter((l) => l.includes('"http.request"') && l.includes('"httpStatus":422'));
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(log).not.toContain(env.agentToken);
    // Valor entre aspas / campo: '1e3' solto colidiria com hex aleatório do requestId (UUID), que é legítimo no log.
    expect(log).not.toContain('"1e3"');
    expect(log).not.toContain('"quantity"');
    expect(log).not.toContain(marker);
  });

  it('proposta válida pelo contrato → BLOCK de domínio persistido com auditoria (fontes Unconfigured), sem reserva', async () => {
    const acct = uniqueAccount();
    await seedAccountFor(admin, { accountId: acct, agents: [env.agentId] });
    const r = await call(env.baseUrl, 'POST', EVALUATE, env.agentToken, proposalAt(Date.now(), { accountId: acct, agentId: env.agentId }));
    expect(r.status).toBe(200);
    const d = asDecision(r.json);
    expect(d.status).toBe('BLOCK');
    expect(d.violations.length).toBeGreaterThan(0);
    expect(d.reservationId).toBeNull();
    expect(await accountCounts(admin, acct)).toMatchObject({ proposals: 1, decisions: 1, block: 1, allow: 0, reservations: 0 });
    const audit = await admin.query<{ n: string }>(`SELECT count(*)::text n FROM risk_audit_events WHERE decision_id = $1 AND event_type = 'DECISION_RECORDED'`, [d.decisionId]);
    expect(audit.rows[0]?.n).toBe('1');
  });
});

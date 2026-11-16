import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { acquireSuiteLock, adminPool, call, crashPostgresBackend, e2eEnv, EVALUATE, sleep, waitDatabaseUp, waitFor, withDatabaseRefusing } from '../support/env.js';
import { accountCounts, asDecision, integrityViolations, proposalAt, seedAccountFor, uniqueAccount } from '../support/data.js';
import { agentAt, agentProposal, evaluateVia, startComposition, type Composition } from '../support/composition.js';

// Item §9.4 #6 — "Falha de Postgres/market data/política impede aprovação".
// Invariantes: I-05 (falhas de dependência, escala e timestamps => nenhuma autorização), I-02 (sem política/registro não há
// decisão válida), I-01 (nenhum ALLOW devolvido que não esteja persistido).
// Camadas: (a) imagem com o banco recusando conexões / sofrendo crash de backend sob carga; (b) composição para market data,
// snapshot e política (fontes falsas) e para a prova "todo ALLOW devolvido está persistido" sob crash de backend.
// Observação: o banco E2E é tmpfs; `docker stop`/`start` apagaria os dados, por isso a queda é simulada por ALLOW_CONNECTIONS
// false + término de backends, `docker pause` (ver health.e2e) e SIGKILL de backend com crash recovery.
// LACUNA: market data real (D-03) e snapshot real (D-05) não existem; as falhas dessas fontes são injetadas na composição.
// A métrica dependencyFailure só cobre DATABASE (MARKET_DATA/INSTRUMENT_CATALOG/ACCOUNT_SNAPSHOT esperam D-02/03/05).
const env = e2eEnv();
let release: () => void;
let admin: pg.Pool;
let comp: Composition;
const agent = () => agentAt(comp, 0);

beforeAll(async () => {
  release = await acquireSuiteLock();
  admin = adminPool(6);
  comp = await startComposition();
});
afterAll(async () => {
  await comp.close();
  await admin.end();
  release();
});

const codes = (json: Record<string, unknown>): string[] => asDecision(json).violations.map((v) => v.code);

describe('política ausente ou inválida → BLOCK', () => {
  it('conta sem política (imagem e composição) → BLOCK POLICY_MISSING, nunca ALLOW', async () => {
    const acct = uniqueAccount();
    await seedAccountFor(admin, { accountId: acct, agents: [env.agentId, agent().id], policy: false });
    for (const r of [
      await call(env.baseUrl, 'POST', EVALUATE, env.agentToken, proposalAt(Date.now(), { accountId: acct, agentId: env.agentId })),
      await evaluateVia(comp, agent(), agentProposal(comp, acct, agent())),
    ]) {
      expect(r.status).toBe(200);
      expect(asDecision(r.json).status).toBe('BLOCK');
      expect(codes(r.json)).toContain('POLICY_MISSING');
      expect(r.text).not.toContain('ALLOW_PAPER');
    }
    expect(await accountCounts(admin, acct)).toMatchObject({ allow: 0, reservations: 0 });
  });

  it('política desativada, vencida ou ainda não vigente → BLOCK (UT-007)', async () => {
    const base = Date.now();
    const cases: [string, Record<string, unknown>][] = [
      ['vencida', { validFrom: new Date(base - 10 * 86_400_000).toISOString(), validUntil: new Date(base - 86_400_000).toISOString() }],
      ['futura', { validFrom: new Date(base + 86_400_000).toISOString(), validUntil: new Date(base + 5 * 86_400_000).toISOString() }],
      ['enabled=false', { enabled: false }],
    ];
    for (const [label, overrides] of cases) {
      const acct = uniqueAccount();
      await seedAccountFor(admin, { accountId: acct, agents: [agent().id], policyOverrides: overrides });
      const r = await evaluateVia(comp, agent(), agentProposal(comp, acct, agent()));
      expect(asDecision(r.json).status, label).toBe('BLOCK');
      expect(codes(r.json).some((c) => c.startsWith('POLICY_')), label).toBe(true);
    }
    // Desativada depois de avaliar: a próxima proposta bloqueia.
    const acct = uniqueAccount();
    await seedAccountFor(admin, { accountId: acct, agents: [agent().id] });
    expect(asDecision((await evaluateVia(comp, agent(), agentProposal(comp, acct, agent()))).json).status).toBe('ALLOW_PAPER');
    await admin.query('UPDATE risk_policies SET active = false WHERE account_id = $1', [acct]);
    const after = await evaluateVia(comp, agent(), agentProposal(comp, acct, agent()));
    expect(asDecision(after.json).status).toBe('BLOCK');
    expect(codes(after.json)).toContain('POLICY_MISSING');
  });
});

describe('market data e snapshot indisponíveis → sem autorização', () => {
  it('cotação ausente → BLOCK; cotação lançando exceção ou snapshot lançando exceção → 503 sem gravar nada', async () => {
    const acct = uniqueAccount();
    await seedAccountFor(admin, { accountId: acct, agents: [agent().id] });
    comp.sources.quoteMissing = true;
    const missing = await evaluateVia(comp, agent(), agentProposal(comp, acct, agent()));
    comp.sources.quoteMissing = false;
    expect(asDecision(missing.json).status).toBe('BLOCK');
    expect(codes(missing.json)).toContain('MARKET_DATA_UNAVAILABLE');
    const before = await accountCounts(admin, acct);
    for (const flag of ['failQuote', 'failSnapshot'] as const) {
      comp.sources[flag] = true;
      const r = await evaluateVia(comp, agent(), agentProposal(comp, acct, agent()));
      comp.sources[flag] = false;
      expect(r.status, flag).toBe(503);
      expect(r.text).not.toContain('ALLOW_PAPER');
    }
    expect(await accountCounts(admin, acct)).toEqual(before);
    expect(await integrityViolations(admin, acct)).toEqual([]);
  });

  it('instrumento desconhecido no catálogo → BLOCK (UT-017); câmbio ausente com moeda diferente → BLOCK', async () => {
    const acct = uniqueAccount();
    await seedAccountFor(admin, { accountId: acct, agents: [agent().id] });
    comp.sources.instrument = null;
    const r = await evaluateVia(comp, agent(), agentProposal(comp, acct, agent()));
    comp.sources.instrument = undefined;
    expect(asDecision(r.json).status).toBe('BLOCK');
    expect(r.text).not.toContain('ALLOW_PAPER');
    comp.sources.instrument = (await import('../../fixtures/instruments.js')).fixtureInstrument();
    await seedAccountFor(admin, { accountId: `${acct}-eur`, agents: [agent().id], policyOverrides: { baseCurrency: 'EUR' } });
    const fx = await evaluateVia(comp, agent(), agentProposal(comp, `${acct}-eur`, agent()));
    expect(asDecision(fx.json).status).toBe('BLOCK');
    expect(codes(fx.json)).toContain('FX_RATE_UNAVAILABLE');
  });
});

describe('Postgres indisponível → 503 e nenhuma autorização', () => {
  it('imagem: banco recusando conexões → evaluate 503 sem ALLOW, ready 503; ao voltar tudo normaliza; decisões anteriores intactas', async () => {
    const acct = uniqueAccount();
    await seedAccountFor(admin, { accountId: acct, agents: [env.agentId] });
    const body = proposalAt(Date.now(), { accountId: acct, agentId: env.agentId });
    const first = await call(env.baseUrl, 'POST', EVALUATE, env.agentToken, body);
    expect(first.status).toBe(200);
    const during: number[] = [];
    await withDatabaseRefusing(async () => {
      const r = await call(env.baseUrl, 'POST', EVALUATE, env.agentToken, proposalAt(Date.now(), { accountId: acct, agentId: env.agentId }));
      during.push(r.status);
      expect(r.status).toBe(503);
      expect(r.text).not.toContain('ALLOW_PAPER');
      expect(r.text).not.toMatch(/ECONNREFUSED|postgres|password|at .*\(/i);
      expect((await call(env.baseUrl, 'GET', '/health/ready', null)).status).toBe(503);
      expect((await call(env.baseUrl, 'GET', '/health/live', null)).status).toBe(200);
    });
    await waitDatabaseUp();
    await waitFor('ready', async () => (await call(env.baseUrl, 'GET', '/health/ready', null)).status === 200, 30_000);
    const replay = await call(env.baseUrl, 'POST', EVALUATE, env.agentToken, body);
    expect(replay.json).toEqual(first.json);
    expect(await accountCounts(admin, acct)).toMatchObject({ proposals: 1, decisions: 1, allow: 0 });
  });

  it('composição: banco recusando conexões → 503 sem ALLOW e nada gravado; depois volta a autorizar, uma vez', async () => {
    const acct = uniqueAccount();
    await seedAccountFor(admin, { accountId: acct, agents: [agent().id] });
    const proposal = agentProposal(comp, acct, agent());
    await withDatabaseRefusing(async () => {
      const r = await evaluateVia(comp, agent(), proposal);
      expect(r.status).toBe(503);
      expect(r.text).not.toContain('ALLOW_PAPER');
      expect((await call(comp.url, 'GET', '/health/ready', null)).status).toBe(503);
    });
    await waitDatabaseUp();
    expect(await accountCounts(admin, acct)).toMatchObject({ proposals: 0, decisions: 0, reservations: 0 });
    await waitFor('composição reconecta', async () => (await evaluateVia(comp, agent(), proposal)).status === 200, 30_000);
    expect(await accountCounts(admin, acct)).toMatchObject({ proposals: 1, allow: 1, reservations: 1 });
  });

  it('crash de backend (SIGKILL) sob carga: nenhum ALLOW devolvido fora do banco, nenhum persistido sem reserva, só 200/503/sem resposta', async () => {
    const acct = uniqueAccount();
    const imageAcct = uniqueAccount();
    await seedAccountFor(admin, { accountId: acct, agents: comp.identities.agents.map((a) => a.id) });
    await seedAccountFor(admin, { accountId: imageAcct, agents: [env.agentId] });
    const seenAllow: string[] = [];
    const statuses: number[] = [];
    const imageStatuses: number[] = [];
    let stop = false;
    const worker = async (i: number): Promise<void> => {
      const a = agentAt(comp, i % 7);
      while (!stop) {
        const r = await evaluateVia(comp, a, agentProposal(comp, acct, a));
        statuses.push(r.status);
        if (r.status === 200 && r.text.includes('ALLOW_PAPER')) seenAllow.push(asDecision(r.json).decisionId);
        const ri = await call(env.baseUrl, 'POST', EVALUATE, env.agentToken, proposalAt(Date.now(), { accountId: imageAcct, agentId: env.agentId }), 10_000);
        imageStatuses.push(ri.status);
        expect(ri.text).not.toContain('ALLOW_PAPER');
      }
    };
    const workers = Array.from({ length: 6 }, (_v, i) => worker(i));
    await sleep(1200);
    await crashPostgresBackend();
    await sleep(2500);
    stop = true;
    await Promise.all(workers);
    await waitDatabaseUp();
    await waitFor('ready volta', async () => (await call(env.baseUrl, 'GET', '/health/ready', null)).status === 200, 60_000);

    expect(statuses.length).toBeGreaterThan(10);
    // O crash realmente interrompeu requisições em andamento (senão o teste não provaria nada).
    expect([...statuses, ...imageStatuses].some((s) => s !== 200)).toBe(true);
    expect(statuses.every((s) => s === 200 || s === 503 || s === 0), `composição: ${[...new Set(statuses)].join(',')}`).toBe(true);
    expect(imageStatuses.every((s) => s === 200 || s === 503 || s === 0), `imagem: ${[...new Set(imageStatuses)].join(',')}`).toBe(true);
    // Todo ALLOW que o cliente viu existe no banco com reserva.
    if (seenAllow.length > 0) {
      const persisted = await admin.query<{ n: string }>(
        `SELECT count(*)::text n FROM risk_decisions d JOIN risk_reservations r ON r.reservation_id = d.reservation_id WHERE d.decision_id = ANY($1::uuid[]) AND d.status = 'ALLOW_PAPER'`,
        [seenAllow],
      );
      expect(Number(persisted.rows[0]?.n)).toBe(seenAllow.length);
    }
    expect(await integrityViolations(admin, acct)).toEqual([]);
    expect(await integrityViolations(admin, imageAcct)).toEqual([]);
    expect(await accountCounts(admin, imageAcct)).toMatchObject({ allow: 0, reservations: 0 });
    // Depois da recuperação, o serviço volta a decidir normalmente.
    const after = await call(env.baseUrl, 'POST', EVALUATE, env.agentToken, proposalAt(Date.now(), { accountId: imageAcct, agentId: env.agentId }));
    expect(after.status).toBe(200);
  });
});

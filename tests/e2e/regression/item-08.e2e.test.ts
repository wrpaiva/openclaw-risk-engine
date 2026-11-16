import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { acquireSuiteLock, adminPool, assertOwnedContainer, call, consumePath, docker, e2eEnv, EVALUATE, sleep, startApp, waitFor } from '../support/env.js';
import { accountCounts, asDecision, integrityViolations, proposalAt, seedAccountFor, uniqueAccount, type DecisionBody } from '../support/data.js';
import { agentAt, agentProposal, evaluateVia, startComposition, type Composition } from '../support/composition.js';

// Item §9.4 #8 — "Reinício de componentes não perde decisões persistidas nem gera duplicatas".
// Invariantes: I-04 (nenhuma duplicata após reinício/replay), I-02 (decisão persistida sobrevive), I-01 (ALLOW persistido
// continua consumível uma única vez), I-05 (requisição em voo no kill => sem resposta/503, nunca autorização fantasma).
// Camadas: (a) imagem: `docker kill -s KILL` da app sob carga, depois `docker start`; (b) composição: ALLOW persistidos
// (a imagem só dá BLOCK) reaparecem idênticos após reiniciar a composição E após o kill/restart da imagem.
// LACUNA: reinício do Postgres (tmpfs) não é viável com `docker stop/start` (apaga os dados); o crash de backend com
// crash recovery está no item 6. Reinício do OpenClaw/receiver/executor reais não é exercitado.
const env = e2eEnv();
let release: () => void;
let admin: pg.Pool;
let comp: Composition;
let allowAccount: string;
const allowed: DecisionBody[] = [];
const allowedProposals: Record<string, unknown>[] = [];
let consumed: DecisionBody;
let consumedOrder: string;

beforeAll(async () => {
  release = await acquireSuiteLock();
  admin = adminPool(6);
  await startApp();
  comp = await startComposition();
  allowAccount = uniqueAccount();
  await seedAccountFor(admin, { accountId: allowAccount, agents: [agentAt(comp, 0).id], executors: [comp.identities.executor.id] });
});
afterAll(async () => {
  await comp.close();
  await admin.end();
  await startApp().catch(() => undefined);
  release();
});

interface Sent {
  readonly proposal: Record<string, unknown>;
  readonly status: number;
  readonly json: Record<string, unknown>;
}

describe('reinício da imagem sob carga', () => {
  it('antes: ALLOW persistidos pela composição (3, um já consumido)', async () => {
    const agent = agentAt(comp, 0);
    for (let i = 0; i < 3; i += 1) {
      const proposal = agentProposal(comp, allowAccount, agent);
      allowedProposals.push(proposal);
      allowed.push(asDecision((await evaluateVia(comp, agent, proposal)).json));
    }
    expect(allowed.every((d) => d.status === 'ALLOW_PAPER')).toBe(true);
    consumed = allowed[0] as DecisionBody;
    consumedOrder = `order-restart-${consumed.decisionId}`;
    const c = await call(comp.url, 'POST', consumePath(consumed.decisionId), comp.identities.executor.token, { accountId: allowAccount, paperOrderId: consumedOrder, proposalHash: consumed.proposalHash });
    expect(c.status).toBe(200);
  });

  it('SIGKILL da app durante carga: depois do start, replays devolvem a decisão original; contagens batem; sem duplicatas', async () => {
    const account = uniqueAccount();
    await seedAccountFor(admin, { accountId: account, agents: [env.agentId] });
    const sent: Sent[] = [];
    let stop = false;
    const worker = async (): Promise<void> => {
      while (!stop) {
        const proposal = proposalAt(Date.now(), { accountId: account, agentId: env.agentId });
        const r = await call(env.baseUrl, 'POST', EVALUATE, env.agentToken, proposal, 8000);
        sent.push({ proposal, status: r.status, json: r.json });
        expect(r.text).not.toContain('ALLOW_PAPER');
        if (r.status === 0) await sleep(50);
      }
    };
    const workers = Array.from({ length: 6 }, () => worker());
    await sleep(1500);
    assertOwnedContainer(env.appContainer);
    docker(['kill', '-s', 'KILL', env.appContainer]);
    expect(docker(['inspect', '--format', '{{.State.Running}}', env.appContainer]).trim()).toBe('false');
    await sleep(800);
    stop = true;
    await Promise.all(workers);
    expect(docker(['inspect', '--format', '{{.State.ExitCode}}', env.appContainer]).trim()).toBe('137');
    // Com a app fora, nada é respondido (e nada é autorizado).
    expect((await call(env.baseUrl, 'GET', '/health/live', null, undefined, 3000)).status).toBe(0);

    docker(['start', env.appContainer]);
    await waitFor('app ready após start', async () => (await call(env.baseUrl, 'GET', '/health/ready', null)).status === 200, 60_000);

    const answered = sent.filter((s) => s.status === 200);
    expect(answered.length).toBeGreaterThan(5);
    expect(sent.some((s) => s.status === 0)).toBe(true);
    expect(sent.every((s) => s.status === 200 || s.status === 0 || s.status === 503)).toBe(true);
    // Replay de cada resposta recebida antes do kill: mesma decisão, marcada como replay, sem nova linha.
    const before = await accountCounts(admin, account);
    for (const s of answered) {
      const again = await call(env.baseUrl, 'POST', EVALUATE, env.agentToken, s.proposal);
      expect(again.status).toBe(200);
      expect(again.json).toEqual(s.json);
      expect(again.headers.get('idempotent-replayed')).toBe('true');
    }
    expect(await accountCounts(admin, account)).toEqual(before);
    // Requisições sem resposta (em voo no kill): reenvio é seguro — cria no máximo uma decisão por proposta.
    const unanswered = sent.filter((s) => s.status !== 200);
    for (const s of unanswered) {
      const retry = await call(env.baseUrl, 'POST', EVALUATE, env.agentToken, s.proposal);
      expect(retry.status).toBe(200);
      expect(asDecision(retry.json).status).toBe('BLOCK');
    }
    const after = await accountCounts(admin, account);
    expect(after.proposals).toBe(sent.length);
    expect(after.decisions).toBe(after.proposals);
    expect(after).toMatchObject({ allow: 0, reservations: 0 });
    const distinct = await admin.query<{ n: string }>('SELECT count(DISTINCT proposal_id)::text n FROM risk_decisions WHERE account_id = $1', [account]);
    expect(Number(distinct.rows[0]?.n)).toBe(after.decisions);
    expect(await integrityViolations(admin, account)).toEqual([]);
  });

  it('sem travas órfãs: nenhuma transação ociosa do runtime após o kill e a conta processa normalmente', async () => {
    await waitFor('sem idle in transaction', async () => {
      const r = await admin.query<{ n: string }>(`SELECT count(*)::text n FROM pg_stat_activity WHERE usename = 'e2e_runtime' AND state LIKE 'idle in transaction%'`);
      return r.rows[0]?.n === '0';
    }, 15_000);
    const account = uniqueAccount();
    await seedAccountFor(admin, { accountId: account, agents: [env.agentId] });
    expect((await call(env.baseUrl, 'POST', EVALUATE, env.agentToken, proposalAt(Date.now(), { accountId: account, agentId: env.agentId }))).status).toBe(200);
  });
});

describe('reinício da composição: ALLOW persistidos sobrevivem', () => {
  it('nova composição (novo pool/servidor) com as mesmas identidades: replays idênticos, reservas no mesmo estado, consumo continua único', async () => {
    const before = await accountCounts(admin, allowAccount);
    const identities = comp.identities;
    const originals = new Map<string, Record<string, unknown>>();
    for (const d of allowed) originals.set(d.decisionId, d as unknown as Record<string, unknown>);
    const clockMs = comp.clock.nowMs();
    await comp.close();
    comp = await startComposition({ identities });
    comp.clock.set(clockMs);

    // Replay da proposta original: mesma decisão ALLOW, marcada como replay (sem nova reserva) — e leitura por id.
    for (const [i, proposal] of allowedProposals.entries()) {
      const replay = await evaluateVia(comp, agentAt(comp, 0), proposal);
      expect(replay.status).toBe(200);
      expect(replay.json).toEqual(allowed[i]);
      expect(replay.headers.get('idempotent-replayed')).toBe('true');
    }
    for (const d of allowed) {
      const got = await call(comp.url, 'GET', `/v1/risk/decisions/${d.decisionId}`, identities.executor.token);
      expect(got.status).toBe(200);
      expect(got.json).toEqual(originals.get(d.decisionId));
    }
    const states = await admin.query<{ decision_id: string; status: string }>('SELECT decision_id, status FROM risk_reservations WHERE account_id = $1 ORDER BY created_at, decision_id', [allowAccount]);
    expect(states.rows.filter((r) => r.status === 'CONSUMED')).toHaveLength(1);
    expect(states.rows.filter((r) => r.status === 'ACTIVE')).toHaveLength(2);
    // Consumo: o já consumido repete (mesma ordem) e não aceita outra; o ativo consome uma única vez.
    const exec = identities.executor.token;
    const same = await call(comp.url, 'POST', consumePath(consumed.decisionId), exec, { accountId: allowAccount, paperOrderId: consumedOrder, proposalHash: consumed.proposalHash });
    expect(same.json).toMatchObject({ status: 'CONSUMED', replayed: true });
    expect((await call(comp.url, 'POST', consumePath(consumed.decisionId), exec, { accountId: allowAccount, paperOrderId: 'order-outra', proposalHash: consumed.proposalHash })).status).toBe(409);
    const active = allowed[1] as DecisionBody;
    expect((await call(comp.url, 'POST', consumePath(active.decisionId), exec, { accountId: allowAccount, paperOrderId: `order-after-${active.decisionId}`, proposalHash: active.proposalHash })).status).toBe(200);
    const after = await accountCounts(admin, allowAccount);
    expect(after).toMatchObject({ proposals: before.proposals, decisions: before.decisions, allow: before.allow, reservations: before.reservations });
    expect(await integrityViolations(admin, allowAccount)).toEqual([]);
  });
});

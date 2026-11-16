import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgPrivilegeInspector } from '../../src/infrastructure/postgres/PgPrivilegeInspector.js';
import { count, createIsolatedDatabase, createRuntimeLogin, createTestLogin, seedAccount, seedPolicy, type IsolatedDatabase, type RuntimeLogin } from './support/database.js';
import { AGENT, executorPrincipal, harness, uniqueProposal } from './support/harness.js';

// Migração 0004 (estado operacional) e RestorePendingError. Tudo FICTÍCIO; banco descartável *_test.
let db: IsolatedDatabase;
let rt: RuntimeLogin;

beforeAll(async () => {
  db = await createIsolatedDatabase();
  await seedAccount(db.pool);
  await seedPolicy(db.pool);
  rt = await createRuntimeLogin(db);
});
afterAll(async () => {
  await rt.drop();
  await db.drop();
});
beforeEach(async () => {
  await clear();
});

const clear = () => db.pool.query(`UPDATE risk_operational_state SET restore_pending = FALSE, restore_marked_at = NULL WHERE singleton`);
const mark = () => db.pool.query(`UPDATE risk_operational_state SET restore_pending = TRUE, restore_marked_at = now() WHERE singleton`);

async function sqlState(pool: pg.Pool, sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await pool.query(sql, params);
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? 'sem-codigo';
  }
}

describe('0004: linha única', () => {
  it('nasce com exatamente 1 linha, restore_pending=false', async () => {
    const { rows } = await db.pool.query<{ singleton: boolean; restore_pending: boolean }>('SELECT singleton, restore_pending FROM risk_operational_state');
    expect(rows).toEqual([{ singleton: true, restore_pending: false }]);
  });

  it('segunda linha: INSERT com singleton=TRUE (23505), FALSE (23514) e NULL (23502) falham; segue 1 linha', async () => {
    expect(await sqlState(db.pool, `INSERT INTO risk_operational_state (singleton, restore_pending) VALUES (TRUE, FALSE)`)).toBe('23505');
    expect(await sqlState(db.pool, `INSERT INTO risk_operational_state (singleton, restore_pending) VALUES (FALSE, FALSE)`)).toBe('23514');
    expect(await sqlState(db.pool, `INSERT INTO risk_operational_state (singleton, restore_pending) VALUES (NULL, FALSE)`)).toBe('23502');
    expect(await count(db.pool, 'risk_operational_state')).toBe(1);
  });

  it('restore_pending=true sem restore_marked_at viola o CHECK (23514)', async () => {
    expect(await sqlState(db.pool, `UPDATE risk_operational_state SET restore_pending = TRUE, restore_marked_at = NULL WHERE singleton`)).toBe('23514');
    expect((await db.pool.query('SELECT restore_pending FROM risk_operational_state')).rows[0]).toEqual({ restore_pending: false });
  });

  it('restore_pending NULL é rejeitado (NOT NULL)', async () => {
    expect(await sqlState(db.pool, `UPDATE risk_operational_state SET restore_pending = NULL WHERE singleton`)).toBe('23502');
  });
});

describe('0004: DELETE e TRUNCATE barrados (até para o superuser)', () => {
  it('DELETE (com e sem WHERE) → 23000 e a linha permanece', async () => {
    expect(await sqlState(db.pool, 'DELETE FROM risk_operational_state')).toBe('23000');
    expect(await sqlState(db.pool, 'DELETE FROM risk_operational_state WHERE singleton')).toBe('23000');
    expect(await count(db.pool, 'risk_operational_state')).toBe(1);
  });

  it('DELETE com restore_pending=true também é barrado (a pendência não some)', async () => {
    await mark();
    expect(await sqlState(db.pool, 'DELETE FROM risk_operational_state')).toBe('23000');
    expect((await db.pool.query('SELECT restore_pending FROM risk_operational_state')).rows[0]).toEqual({ restore_pending: true });
  });

  it('TRUNCATE (inclusive CASCADE) da tabela e do histórico → 23000 e nada some', async () => {
    const before = await count(db.pool, 'risk_operational_state_history');
    expect(await sqlState(db.pool, 'TRUNCATE risk_operational_state')).toBe('23000');
    expect(await sqlState(db.pool, 'TRUNCATE risk_operational_state CASCADE')).toBe('23000');
    expect(await sqlState(db.pool, 'TRUNCATE risk_operational_state_history')).toBe('23000');
    expect(await sqlState(db.pool, 'TRUNCATE risk_operational_state_history RESTART IDENTITY')).toBe('23000');
    expect(await count(db.pool, 'risk_operational_state')).toBe(1);
    expect(await count(db.pool, 'risk_operational_state_history')).toBe(before);
  });
});

describe('0004: privilégios do runtime', () => {
  it('runtime lê risk_operational_state', async () => {
    const { rows } = await rt.pool.query('SELECT restore_pending FROM risk_operational_state');
    expect(rows).toEqual([{ restore_pending: false }]);
  });

  it('runtime não escreve: UPDATE, INSERT, DELETE e TRUNCATE → 42501 (e o estado não muda)', async () => {
    expect(await sqlState(rt.pool, 'UPDATE risk_operational_state SET restore_pending = FALSE')).toBe('42501');
    expect(await sqlState(rt.pool, 'UPDATE risk_operational_state SET restore_pending = TRUE, restore_marked_at = now()')).toBe('42501');
    expect(await sqlState(rt.pool, 'UPDATE risk_operational_state SET restore_pending = restore_pending WHERE FALSE')).toBe('42501');
    expect(await sqlState(rt.pool, 'INSERT INTO risk_operational_state (singleton, restore_pending) VALUES (TRUE, FALSE)')).toBe('42501');
    expect(await sqlState(rt.pool, 'DELETE FROM risk_operational_state')).toBe('42501');
    expect(await sqlState(rt.pool, 'TRUNCATE risk_operational_state')).toBe('42501');
    expect((await db.pool.query('SELECT restore_pending FROM risk_operational_state')).rows[0]).toEqual({ restore_pending: false });
  });

  it('runtime sem acesso ao histórico: SELECT, INSERT, UPDATE, DELETE, TRUNCATE → 42501; sem a sequência', async () => {
    const t = 'risk_operational_state_history';
    expect(await sqlState(rt.pool, `SELECT 1 FROM ${t}`)).toBe('42501');
    expect(await sqlState(rt.pool, `INSERT INTO ${t} (restore_pending) VALUES (FALSE)`)).toBe('42501');
    expect(await sqlState(rt.pool, `UPDATE ${t} SET restore_pending = TRUE`)).toBe('42501');
    expect(await sqlState(rt.pool, `DELETE FROM ${t}`)).toBe('42501');
    expect(await sqlState(rt.pool, `TRUNCATE ${t}`)).toBe('42501');
    expect(await sqlState(rt.pool, `SELECT nextval('${t}_history_id_seq')`)).toBe('42501');
  });

  it('o gatilho de auditoria do histórico não depende do runtime: a mudança feita pelo dono é registrada mesmo assim', async () => {
    const before = await count(db.pool, 'risk_operational_state_history');
    await mark();
    expect(await count(db.pool, 'risk_operational_state_history')).toBe(before + 1);
  });

  it('PgPrivilegeInspector reprova runtime com UPDATE (ou INSERT/DELETE) em risk_operational_state; aprova após a revogação', async () => {
    const inspect = (pool: pg.Pool) => new PgPrivilegeInspector(pool, { statementTimeoutMs: 10_000 }).inspect();
    for (const priv of ['UPDATE', 'INSERT', 'DELETE', 'TRUNCATE']) {
      const l = await createTestLogin(db);
      try {
        expect((await inspect(l.pool)).ok, 'baseline').toBe(true);
        await db.pool.query(`GRANT ${priv} ON risk_operational_state TO ${l.role}`);
        const r = await inspect(l.pool);
        expect(r.ok, priv).toBe(false);
        expect(r.violations, priv).toContain('EXCESS_TABLE_PRIVILEGE');
        await db.pool.query(`REVOKE ${priv} ON risk_operational_state FROM ${l.role}`);
        expect((await inspect(l.pool)).ok, `${priv} revogado`).toBe(true);
      } finally {
        await l.drop();
      }
    }
  });

  it('PgPrivilegeInspector reprova runtime com qualquer acesso ao histórico', async () => {
    const l = await createTestLogin(db);
    try {
      await db.pool.query(`GRANT UPDATE ON risk_operational_state_history TO ${l.role}`);
      expect((await new PgPrivilegeInspector(l.pool, { statementTimeoutMs: 10_000 }).inspect()).ok).toBe(false);
    } finally {
      await l.drop();
    }
  });
});

describe('0004: histórico append-only', () => {
  const hist = async () => (await db.pool.query<{ restore_pending: boolean; changed_by: string }>('SELECT restore_pending, changed_by FROM risk_operational_state_history ORDER BY history_id')).rows;

  it('registra o estado de partida e cada mudança, em ordem, com quem mudou', async () => {
    const own = await createIsolatedDatabase(2);
    try {
      expect((await own.pool.query('SELECT restore_pending FROM risk_operational_state_history ORDER BY history_id')).rows).toEqual([{ restore_pending: false }]);
      await own.pool.query(`UPDATE risk_operational_state SET restore_pending = TRUE, restore_marked_at = now() WHERE singleton`);
      await own.pool.query(`UPDATE risk_operational_state SET restore_pending = FALSE, restore_cleared_at = now() WHERE singleton`);
      const rows = (await own.pool.query<{ restore_pending: boolean; changed_by: string }>('SELECT restore_pending, changed_by FROM risk_operational_state_history ORDER BY history_id')).rows;
      expect(rows.map((r) => r.restore_pending)).toEqual([false, true, false]);
      const who = (await own.pool.query<{ u: string }>('SELECT current_user AS u')).rows[0]?.u;
      for (const r of rows.slice(1)) expect(r.changed_by).toBe(who);
    } finally {
      await own.drop();
    }
  });

  it('UPDATE e DELETE do histórico são barrados (23000), inclusive para o superuser', async () => {
    await mark();
    const before = await hist();
    expect(before.length).toBeGreaterThanOrEqual(2);
    expect(await sqlState(db.pool, 'UPDATE risk_operational_state_history SET restore_pending = NOT restore_pending')).toBe('23000');
    expect(await sqlState(db.pool, `UPDATE risk_operational_state_history SET changed_by = 'outro'`)).toBe('23000');
    expect(await sqlState(db.pool, 'DELETE FROM risk_operational_state_history')).toBe('23000');
    expect(await sqlState(db.pool, 'DELETE FROM risk_operational_state_history WHERE history_id = 1')).toBe('23000');
    expect(await hist()).toEqual(before);
  });

  it('transação revertida não deixa histórico', async () => {
    const before = await count(db.pool, 'risk_operational_state_history');
    const c = await db.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`UPDATE risk_operational_state SET restore_pending = TRUE, restore_marked_at = now() WHERE singleton`);
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
    expect(await count(db.pool, 'risk_operational_state_history')).toBe(before);
    expect((await db.pool.query('SELECT restore_pending FROM risk_operational_state')).rows[0]).toEqual({ restore_pending: false });
  });
});

describe('RestorePendingError: evaluate, consume e release → UNAVAILABLE com rollback', () => {
  const tables = ['trade_proposals', 'risk_decisions', 'risk_reservations', 'risk_audit_events', 'risk_outbox'] as const;
  const snapshot = async () => Object.fromEntries(await Promise.all(tables.map(async (t) => [t, await count(db.pool, t)] as const)));

  it('evaluate com restore_pending=true: UNAVAILABLE, nada gravado (nem proposta, decisão, reserva, auditoria, outbox)', async () => {
    const h = harness(rt.pool);
    await mark();
    const before = await snapshot();
    const r = await h.evaluate.execute({ proposal: uniqueProposal(), authenticatedAgentId: AGENT });
    expect(r).toEqual({ kind: 'UNAVAILABLE' });
    expect(await snapshot()).toEqual(before);
    expect(JSON.stringify(h.logger.entries)).not.toContain('ALLOW_PAPER');
  });

  it('com a flag ligada, a mesma proposta é aceita depois de limpar (nada foi gravado: não há replay de BLOCK)', async () => {
    const h = harness(rt.pool);
    const proposal = uniqueProposal();
    await mark();
    expect(await h.evaluate.execute({ proposal, authenticatedAgentId: AGENT })).toEqual({ kind: 'UNAVAILABLE' });
    await clear();
    const r = await h.evaluate.execute({ proposal, authenticatedAgentId: AGENT });
    expect(r.kind === 'DECISION' && r.decision.status).toBe('ALLOW_PAPER');
  });

  it('consume e release de reserva ACTIVE existente com a flag ligada: UNAVAILABLE e a reserva continua ACTIVE', async () => {
    const h = harness(rt.pool);
    const ok = await h.evaluate.execute({ proposal: uniqueProposal(), authenticatedAgentId: AGENT });
    if (ok.kind !== 'DECISION' || ok.decision.status !== 'ALLOW_PAPER') throw new Error('esperava ALLOW_PAPER');
    const d = ok.decision;
    await mark();
    const before = await snapshot();
    const consumed = await h.consume.execute({ principal: executorPrincipal(), decisionId: d.decisionId, accountId: d.accountId, paperOrderId: `order-${randomUUID()}`, proposalHash: d.proposalHash });
    const released = await h.release.execute({ principal: executorPrincipal(), reservationId: d.reservationId ?? '', reason: 'x' });
    expect(consumed).toEqual({ kind: 'UNAVAILABLE' });
    expect(released).toEqual({ kind: 'UNAVAILABLE' });
    expect(await snapshot()).toEqual(before);
    expect((await db.pool.query('SELECT status, paper_order_id FROM risk_reservations WHERE reservation_id = $1', [d.reservationId])).rows[0]).toEqual({ status: 'ACTIVE', paper_order_id: null });
    await clear();
    const after = await h.consume.execute({ principal: executorPrincipal(), decisionId: d.decisionId, accountId: d.accountId, paperOrderId: `order-${randomUUID()}`, proposalHash: d.proposalHash });
    expect(after.kind).toBe('CONSUMED');
  });

  it('expire (varredura) com a flag ligada: rejeita e nada expira', async () => {
    const h = harness(rt.pool);
    const ok = await h.evaluate.execute({ proposal: uniqueProposal(), authenticatedAgentId: AGENT });
    if (ok.kind !== 'DECISION' || ok.decision.status !== 'ALLOW_PAPER') throw new Error('esperava ALLOW_PAPER');
    h.clock.set('2026-11-14T23:59:00.000Z'); // bem depois do vencimento da autorização fictícia
    await mark();
    await expect(h.expire.execute()).rejects.toThrow();
    expect((await db.pool.query('SELECT status FROM risk_reservations WHERE reservation_id = $1', [ok.decision.reservationId])).rows[0]).toEqual({ status: 'ACTIVE' });
  });

  it('expire com a flag ligada e NENHUMA reserva (nem vencida): ainda rejeita; sem a flag devolve 0', async () => {
    const own = await createIsolatedDatabase(3);
    const login = await createRuntimeLogin(own);
    try {
      await seedAccount(own.pool);
      await seedPolicy(own.pool);
      const h = harness(login.pool);
      expect(await h.expire.execute()).toBe(0);
      await own.pool.query(`UPDATE risk_operational_state SET restore_pending = TRUE, restore_marked_at = now() WHERE singleton`);
      const auditBefore = await count(own.pool, 'risk_audit_events');
      await expect(h.expire.execute()).rejects.toThrow();
      await expect(h.expire.execute()).rejects.toThrow(); // determinístico: nunca "0 expiradas"
      expect(await count(own.pool, 'risk_audit_events')).toBe(auditBefore);
      expect(await count(own.pool, 'risk_reservations')).toBe(0);
      await own.pool.query(`UPDATE risk_operational_state SET restore_pending = FALSE, restore_marked_at = NULL WHERE singleton`);
      expect(await h.expire.execute()).toBe(0);
    } finally {
      await login.drop();
      await own.drop();
    }
  });

  it('expire com a flag ligada e só reservas VIGENTES (nenhuma vencida): rejeita e nada muda', async () => {
    const h = harness(rt.pool);
    const ok = await h.evaluate.execute({ proposal: uniqueProposal(), authenticatedAgentId: AGENT });
    if (ok.kind !== 'DECISION' || ok.decision.status !== 'ALLOW_PAPER') throw new Error('esperava ALLOW_PAPER');
    await mark();
    await expect(h.expire.execute()).rejects.toThrow(); // relógio de teste ainda antes do vencimento
    expect((await db.pool.query('SELECT status FROM risk_reservations WHERE reservation_id = $1', [ok.decision.reservationId])).rows[0]).toEqual({ status: 'ACTIVE' });
  });

  it('linha de estado ausente: fail-closed (UNAVAILABLE), nunca ALLOW', async () => {
    const own = await createIsolatedDatabase(3);
    const login = await createRuntimeLogin(own);
    try {
      await seedAccount(own.pool);
      await seedPolicy(own.pool);
      await own.pool.query('ALTER TABLE risk_operational_state DISABLE TRIGGER risk_operational_state_no_delete');
      await own.pool.query('DELETE FROM risk_operational_state');
      const h = harness(login.pool);
      expect(await h.evaluate.execute({ proposal: uniqueProposal(), authenticatedAgentId: AGENT })).toEqual({ kind: 'UNAVAILABLE' });
      expect(await count(own.pool, 'trade_proposals')).toBe(0);
      expect(await count(own.pool, 'risk_reservations')).toBe(0);
    } finally {
      await login.drop();
      await own.drop();
    }
  });

  it('o lock da conta é liberado: depois de UNAVAILABLE, o lock está livre (nenhuma transação pendurada)', async () => {
    const h = harness(rt.pool);
    await mark();
    for (let i = 0; i < 5; i++) expect(await h.evaluate.execute({ proposal: uniqueProposal(), authenticatedAgentId: AGENT })).toEqual({ kind: 'UNAVAILABLE' });
    const { rows } = await db.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM pg_stat_activity WHERE usename = $1 AND state LIKE 'idle in transaction%'`, [rt.role]);
    expect(rows[0]?.n).toBe('0');
    expect(rt.pool.idleCount).toBe(rt.pool.totalCount);
  });

  it('a pendência ligada durante a espera pelo lock vale: evaluate concorrente vê a flag sob o lock e não autoriza', async () => {
    const h = harness(rt.pool);
    const holder = await db.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['paper-fixture']);
      const pending = h.evaluate.execute({ proposal: uniqueProposal(), authenticatedAgentId: AGENT });
      await new Promise((r) => setTimeout(r, 300)); // o evaluate já está esperando o lock
      await holder.query(`UPDATE risk_operational_state SET restore_pending = TRUE, restore_marked_at = now() WHERE singleton`);
      await holder.query('COMMIT');
      expect(await pending).toEqual({ kind: 'UNAVAILABLE' });
    } finally {
      holder.release();
    }
  });
});

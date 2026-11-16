import { EventEmitter } from 'node:events';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExpireRiskReservations } from '../../src/application/ExpireRiskReservations.js';
import type { TransactionManager } from '../../src/application/ports/TransactionManager.js';
import { PgTransactionManager } from '../../src/infrastructure/postgres/PgTransactionManager.js';
import { CryptoIdGenerator } from '../../src/infrastructure/system/CryptoIdGenerator.js';
import { createIsolatedDatabase, seedAccount, seedPolicy, type IsolatedDatabase } from './support/database.js';
import { AGENT, harness, MutableClock, TEST_DB_TIMEOUTS, uniqueProposal } from './support/harness.js';
import { RecordingMetrics } from './support/metrics.js';

let db: IsolatedDatabase;
beforeAll(async () => {
  db = await createIsolatedDatabase();
  await seedAccount(db.pool);
  await seedPolicy(db.pool);
});
afterAll(async () => db.drop());

describe('ExpireRiskReservations: métricas (PostgreSQL real)', () => {
  it('EXPIRE OK uma vez por reserva expirada, só após COMMIT; varredura vazia não emite', async () => {
    const metrics = new RecordingMetrics();
    const h = harness(db.pool);
    const expire = new ExpireRiskReservations({ transactions: new PgTransactionManager(db.pool, TEST_DB_TIMEOUTS), clock: h.clock, ids: new CryptoIdGenerator(), metrics });
    let expiresAt = '';
    for (let i = 0; i < 3; i++) {
      const r = await h.evaluate.execute({ proposal: uniqueProposal(), authenticatedAgentId: AGENT });
      if (r.kind !== 'DECISION' || r.decision.status !== 'ALLOW_PAPER') throw new Error('esperava ALLOW_PAPER');
      expiresAt = r.decision.authorizationExpiresAt ?? '';
    }
    expect(await expire.execute()).toBe(0); // ainda vigentes
    expect(metrics.calls).toEqual([]);
    h.clock.set(expiresAt);
    expect(await expire.execute()).toBe(3);
    expect(metrics.calls).toEqual(['reservationOp:EXPIRE:OK', 'reservationOp:EXPIRE:OK', 'reservationOp:EXPIRE:OK']);
    expect(await expire.execute()).toBe(0);
    expect(metrics.calls).toHaveLength(3);
  });

  it('falha do gerenciador de transação → EXPIRE UNAVAILABLE (uma vez), nenhum OK, erro propagado', async () => {
    const metrics = new RecordingMetrics();
    const failing: TransactionManager = { run: () => Promise.reject(new Error('db down')) };
    const expire = new ExpireRiskReservations({ transactions: failing, clock: new MutableClock(), ids: new CryptoIdGenerator(), metrics });
    await expect(expire.execute()).rejects.toThrow('db down');
    expect(metrics.calls).toEqual(['reservationOp:EXPIRE:UNAVAILABLE']);
  });

  it('COMMIT falho na varredura → UNAVAILABLE, nenhum OK e reservas continuam ACTIVE', async () => {
    const h = harness(db.pool);
    const r = await h.evaluate.execute({ proposal: uniqueProposal(), authenticatedAgentId: AGENT });
    if (r.kind !== 'DECISION' || r.decision.status !== 'ALLOW_PAPER') throw new Error('esperava ALLOW_PAPER');
    const metrics = new RecordingMetrics();
    const realConnect = db.pool.connect.bind(db.pool) as () => Promise<pg.PoolClient>;
    const pool = {
      connect: async () => {
        const c = await realConnect();
        const q = c.query.bind(c) as (...a: unknown[]) => Promise<unknown>;
        (c as unknown as { query: (...a: unknown[]) => Promise<unknown> }).query = (...a: unknown[]) =>
          a[0] === 'COMMIT' ? q('ROLLBACK').then(() => Promise.reject(new Error('commit falhou'))) : q(...a);
        return c;
      },
    } as unknown as pg.Pool;
    h.clock.set(r.decision.authorizationExpiresAt ?? '');
    const expire = new ExpireRiskReservations({ transactions: new PgTransactionManager(pool, TEST_DB_TIMEOUTS, { metrics }), clock: h.clock, ids: new CryptoIdGenerator(), metrics });
    await expect(expire.execute()).rejects.toThrow('commit falhou');
    expect(metrics.calls.filter((c) => c === 'reservationOp:EXPIRE:OK')).toHaveLength(0);
    expect(metrics.calls.filter((c) => c === 'reservationOp:EXPIRE:UNAVAILABLE')).toHaveLength(1);
    expect(metrics.calls.filter((c) => c === 'dependencyFailure:DATABASE')).toHaveLength(1);
    const { rows } = await db.pool.query(`SELECT 1 FROM risk_reservations WHERE reservation_id = $1 AND status = 'ACTIVE'`, [r.decision.reservationId]);
    expect(rows).toHaveLength(1);
  });
});

class FakeClient extends EventEmitter {
  readonly statements: string[] = [];
  released: unknown[] = [];
  constructor(private readonly onQuery: (sql: string, client: FakeClient) => Promise<unknown> | undefined = () => undefined) {
    super();
  }
  query(sql: string): Promise<unknown> {
    this.statements.push(sql);
    return Promise.resolve(this.onQuery(sql, this)).then(() => ({ rows: [], rowCount: 0 }));
  }
  release(arg?: unknown): void {
    this.released.push(arg);
  }
}
const poolOf = (connect: () => Promise<unknown>) => ({ connect }) as unknown as pg.Pool;
const noWork = () => Promise.resolve('ok');

describe('PgTransactionManager: dependencyFailure(DATABASE) (pool fake)', () => {
  it('connect rejeitado → 1 emissão e erro propagado', async () => {
    const metrics = new RecordingMetrics();
    const tm = new PgTransactionManager(poolOf(() => Promise.reject(new Error('sem conexão'))), TEST_DB_TIMEOUTS, { metrics });
    await expect(tm.run(noWork)).rejects.toThrow('sem conexão');
    expect(metrics.calls).toEqual(['dependencyFailure:DATABASE']);
  });

  it('BEGIN falho → 1 emissão; set_config falho → 1 emissão; work nunca roda', async () => {
    for (const failOn of [/^BEGIN/, /set_config/]) {
      const metrics = new RecordingMetrics();
      const client = new FakeClient((sql) => (failOn.test(sql) ? Promise.reject(new Error('falha')) : undefined));
      let ran = false;
      const tm = new PgTransactionManager(poolOf(() => Promise.resolve(client)), TEST_DB_TIMEOUTS, { metrics });
      await expect(tm.run(() => ((ran = true), noWork()))).rejects.toThrow('falha');
      expect(ran).toBe(false);
      expect(metrics.calls).toEqual(['dependencyFailure:DATABASE']);
      expect(client.released).toEqual([true]);
    }
  });

  it('COMMIT falho → 1 emissão, resultado não devolvido, cliente destruído', async () => {
    const metrics = new RecordingMetrics();
    const client = new FakeClient((sql) => (sql === 'COMMIT' ? Promise.reject(new Error('commit falhou')) : undefined));
    const tm = new PgTransactionManager(poolOf(() => Promise.resolve(client)), TEST_DB_TIMEOUTS, { metrics });
    await expect(tm.run(noWork)).rejects.toThrow('commit falhou');
    expect(metrics.calls).toEqual(['dependencyFailure:DATABASE']);
    expect(client.released).toEqual([true]);
  });

  it('conexão derrubada em uso (evento error, várias vezes) → no máximo 1 emissão, sem uncaught, destruído', async () => {
    const metrics = new RecordingMetrics();
    const client = new FakeClient();
    const tm = new PgTransactionManager(poolOf(() => Promise.resolve(client)), TEST_DB_TIMEOUTS, { metrics });
    await expect(
      tm.run(() => {
        client.emit('error', new Error('terminated'));
        client.emit('error', new Error('terminated 2'));
        return Promise.reject(new Error('query rejeitada'));
      }),
    ).rejects.toThrow('query rejeitada');
    expect(metrics.calls).toEqual(['dependencyFailure:DATABASE']);
    expect(client.released).toEqual([true]);
  });

  it('conexão derrubada E COMMIT falho no mesmo run → ainda 1 emissão', async () => {
    const metrics = new RecordingMetrics();
    const client = new FakeClient((sql, c) => {
      if (sql === 'COMMIT') {
        c.emit('error', new Error('terminated'));
        return Promise.reject(new Error('commit falhou'));
      }
    });
    const tm = new PgTransactionManager(poolOf(() => Promise.resolve(client)), TEST_DB_TIMEOUTS, { metrics });
    await expect(tm.run(noWork)).rejects.toThrow('commit falhou');
    expect(metrics.calls).toEqual(['dependencyFailure:DATABASE']);
  });

  it('erro de domínio lançado pelo work → ROLLBACK, nenhuma emissão', async () => {
    const metrics = new RecordingMetrics();
    const client = new FakeClient();
    const tm = new PgTransactionManager(poolOf(() => Promise.resolve(client)), TEST_DB_TIMEOUTS, { metrics });
    await expect(tm.run(() => Promise.reject(new Error('regra de domínio')))).rejects.toThrow('regra de domínio');
    expect(metrics.calls).toEqual([]);
    expect(client.statements).toContain('ROLLBACK');
    expect(client.statements).not.toContain('COMMIT');
  });

  it('sucesso → nenhuma emissão, COMMIT, cliente devolvido sem destruir', async () => {
    const metrics = new RecordingMetrics();
    const client = new FakeClient();
    const tm = new PgTransactionManager(poolOf(() => Promise.resolve(client)), TEST_DB_TIMEOUTS, { metrics });
    await expect(tm.run(noWork)).resolves.toBe('ok');
    expect(metrics.calls).toEqual([]);
    expect(client.released).toEqual([false]);
  });

  it('sem metrics configurado não quebra; metrics que lança não altera o erro original', async () => {
    const throwing = new Proxy({}, { get: () => () => { throw new Error('métrica quebrou'); } }) as never;
    const tm = new PgTransactionManager(poolOf(() => Promise.reject(new Error('sem conexão'))), TEST_DB_TIMEOUTS, { metrics: throwing });
    await expect(tm.run(noWork)).rejects.toThrow('sem conexão');
    await expect(new PgTransactionManager(poolOf(() => Promise.reject(new Error('x'))), TEST_DB_TIMEOUTS).run(noWork)).rejects.toThrow('x');
  });
});

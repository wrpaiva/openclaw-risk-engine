import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/infrastructure/postgres/migrate.js';
import { createIsolatedDatabase, MIGRATIONS_DIR, seedAccount, seedPolicy, type IsolatedDatabase } from './support/database.js';

let db: IsolatedDatabase;
beforeAll(async () => {
  db = await createIsolatedDatabase();
  await seedAccount(db.pool);
});
afterAll(async () => db.drop());

const q = (sql: string, params: unknown[] = []) => db.pool.query(sql, params);

describe('migrações', () => {
  it('são idempotentes: reaplicar não altera nada', async () => {
    expect(await migrate(db.pool, MIGRATIONS_DIR)).toEqual([]);
  });

  it('detectam migração alterada depois de aplicada', async () => {
    await q(`UPDATE schema_migrations SET checksum = 'adulterado' WHERE version = '0001_initial.sql'`);
    await expect(migrate(db.pool, MIGRATIONS_DIR)).rejects.toThrow(/alterada/);
  });
});

describe('constraints de segurança', () => {
  it('conta não-PAPER não pode existir (ADR-0003)', async () => {
    await expect(q(`INSERT INTO risk_accounts VALUES ('live-1', 'LIVE')`)).rejects.toThrow(/check/i);
  });

  it('no máximo uma política ativa por conta', async () => {
    await seedPolicy(db.pool, { version: 'v-a' });
    await expect(seedPolicy(db.pool, { version: 'v-b' })).rejects.toThrow(/one_active/);
  });

  it('versão de política é imutável e não pode ser apagada nem reativada', async () => {
    await expect(q(`UPDATE risk_policies SET policy_json = '{}' WHERE version = 'v-a'`)).rejects.toThrow(/imutável/);
    await expect(q(`DELETE FROM risk_policies WHERE version = 'v-a'`)).rejects.toThrow(/apagadas/);
    await q(`UPDATE risk_policies SET active = false WHERE version = 'v-a'`);
    await expect(q(`UPDATE risk_policies SET active = true WHERE version = 'v-a'`)).rejects.toThrow(/imutável/);
  });

  it('ALLOW_PAPER sem reserva é rejeitado pelo banco', async () => {
    await q(
      `INSERT INTO trade_proposals VALUES ('11111111-1111-4111-8111-111111111111', 'paper-fixture', 'a', 'k-1',
        'sha256:${'0'.repeat(64)}', '{}', 'c', now())`,
    );
    await expect(
      q(`INSERT INTO risk_decisions (decision_id, proposal_id, account_id, agent_id, status, violations_json, evaluated_at, decision_json)
         VALUES ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'paper-fixture', 'a',
                 'ALLOW_PAPER', '[]', now(), '{}')`),
    ).rejects.toThrow(/check/i);
  });

  it('BLOCK sem violação é rejeitado pelo banco', async () => {
    await expect(
      q(`INSERT INTO risk_decisions (decision_id, proposal_id, account_id, agent_id, status, violations_json, evaluated_at, decision_json)
         VALUES ('33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', 'paper-fixture', 'a',
                 'BLOCK', '[]', now(), '{}')`),
    ).rejects.toThrow(/check/i);
  });

  it('propostas e auditoria são imutáveis', async () => {
    await expect(q(`UPDATE trade_proposals SET agent_id = 'x'`)).rejects.toThrow(/imutável/);
    await expect(q(`DELETE FROM trade_proposals`)).rejects.toThrow(/imutável/);
    await q(`INSERT INTO risk_audit_events (event_id, event_type, details_json, created_at)
             VALUES ('44444444-4444-4444-8444-444444444444', 'DECISION_RECORDED', '{}', now())`);
    await expect(q(`DELETE FROM risk_audit_events`)).rejects.toThrow(/imutável/);
  });
});

describe('migração 0002 (grants de acesso)', () => {
  it('0001 e 0002 aplicam em base limpa e a tabela de grants existe', async () => {
    const fresh = await createIsolatedDatabase();
    try {
      const { rows } = await fresh.pool.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version');
      const versions = rows.map((r) => r.version);
      expect(versions[0]).toBe('0001_initial.sql');
      expect(versions[1]).toMatch(/^0002_/);
      expect((await fresh.pool.query(`SELECT to_regclass('risk_access_grants') AS t`)).rows[0]).toEqual({ t: 'risk_access_grants' });
      // Reaplicar é idempotente e não duplica o registro das migrações.
      expect(await migrate(fresh.pool, MIGRATIONS_DIR)).toEqual([]);
      expect((await fresh.pool.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0]).toEqual({ n: rows.length });
    } finally {
      await fresh.drop();
    }
  });
});

describe('imutabilidade das migrações aplicadas', () => {
  it('0001_initial.sql mantém o checksum fixado (migração aplicada não pode mudar)', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '0001_initial.sql'), 'utf8');
    expect(createHash('sha256').update(sql, 'utf8').digest('hex')).toBe('0b78024635b4552ba6d04972afeb88b5c0406f06ec1fa450847d8fdd1e8c14f4');
  });
});

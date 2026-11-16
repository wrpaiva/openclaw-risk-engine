import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import pg from 'pg';
import { migrate } from '../../../src/infrastructure/postgres/migrate.js';
import { computePolicyHash, type RiskPolicyV1 } from '../../../src/domain/RiskPolicy.js';
import { unhashedPolicy } from '../../fixtures/policies.js';

export const MIGRATIONS_DIR = join(import.meta.dirname, '../../../migrations');

/**
 * Trava de segurança: só aceita PostgreSQL local cujo banco termina em `_test`.
 * Impede que um RISK_TEST_DATABASE_URL errado aponte para produção (SPEC §9.2).
 */
export function testDatabaseUrl(): URL {
  const raw = process.env['RISK_TEST_DATABASE_URL'];
  if (!raw) throw new Error('RISK_TEST_DATABASE_URL ausente: use `npm run test:integration`');
  const url = new URL(raw);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_test')) {
    throw new Error('banco de teste deve ser local e terminar em _test; recusando executar');
  }
  return url;
}

async function connectWithRetry(url: string): Promise<pg.Client> {
  for (let attempt = 0; ; attempt++) {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      return client;
    } catch (error) {
      await client.end().catch(() => undefined);
      if (attempt >= 30) throw error;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

export const RUNTIME_GROUP = 'openclaw_risk_runtime';

/**
 * Cria o grupo de runtime (NOLOGIN) de forma idempotente. Roles são cluster-wide e arquivos de teste
 * rodam em paralelo: a corrida entre dois CREATE ROLE aparece como duplicate_object ou unique_violation.
 */
export async function ensureRuntimeGroup(admin: pg.Client | pg.Pool): Promise<void> {
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RUNTIME_GROUP}') THEN
      CREATE ROLE ${RUNTIME_GROUP} NOLOGIN;
    END IF;
  EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
  END $$`);
}

export interface RuntimeLogin {
  readonly role: string;
  readonly pool: pg.Pool;
  /** URL de conexão do login (contém a senha gerada para o teste; nunca logar). */
  readonly url: string;
  drop(): Promise<void>;
}

export const OWNER_GROUP = 'openclaw_risk_owner';

/** Cria o grupo de dono (NOLOGIN, sem poderes) de forma idempotente; mesma corrida de ensureRuntimeGroup. */
export async function ensureOwnerGroup(admin: pg.Client | pg.Pool): Promise<void> {
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${OWNER_GROUP}') THEN
      CREATE ROLE ${OWNER_GROUP} NOLOGIN;
    END IF;
  EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
  END $$`);
}

/**
 * Equivalente em SQL puro do que scripts/provision/roles.sql faz no banco isolado (o psql não está no host de teste):
 * PUBLIC perde CREATE no schema public e TEMP no banco. (CONNECT já é de PUBLIC nos bancos descartáveis; o REVOKE CONNECT do
 * roles.sql não é replicado porque os logins de teste herdam o grupo, que recebe CONNECT abaixo.)
 * Idempotente; só no banco isolado, via conexão administrativa do próprio teste.
 */
export async function provisionIsolatedRoles(db: IsolatedDatabase): Promise<void> {
  await ensureRuntimeGroup(db.pool);
  await ensureOwnerGroup(db.pool);
  const name = new URL(db.url).pathname.slice(1);
  if (!/^openclaw_risk_[0-9a-f]{12}_test$/.test(name)) throw new Error('provisionIsolatedRoles: recusado fora de banco isolado de teste');
  await db.pool.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  // Equivalente do `REVOKE CONNECT, TEMP ON DATABASE ... FROM PUBLIC` do roles.sql (o inspetor reprova TEMP_ON_DATABASE).
  await db.pool.query(`REVOKE TEMP ON DATABASE ${name} FROM PUBLIC`);
  await db.pool.query(`GRANT CONNECT ON DATABASE ${name} TO ${RUNTIME_GROUP}, ${OWNER_GROUP}`);
}

export interface LoginOptions {
  /** Atributos extras da role (ex.: 'SUPERUSER'); padrão: nenhum poder. */
  readonly attributes?: string;
  /** Grupos dos quais o login é membro; padrão: só o grupo de runtime. */
  readonly inRoles?: readonly string[];
}

export interface TestLogin {
  readonly role: string;
  readonly pool: pg.Pool;
  readonly url: string;
  drop(): Promise<void>;
}

/** Login FICTÍCIO de teste com nome exclusivo (`risk_rt_*_test`); senha gerada na hora. */
export async function createTestLogin(db: IsolatedDatabase, options: LoginOptions = {}): Promise<TestLogin> {
  const base = testDatabaseUrl();
  const role = `risk_rt_${randomUUID().replaceAll('-', '').slice(0, 12)}_test`;
  const password = randomUUID();
  const inRoles = options.inRoles ?? [RUNTIME_GROUP];
  const attributes = options.attributes ?? 'NOSUPERUSER NOCREATEDB NOCREATEROLE';
  const admin = await connectWithRetry(base.toString());
  try {
    await admin.query(
      `CREATE ROLE ${role} LOGIN INHERIT ${attributes} PASSWORD '${password}'${inRoles.length > 0 ? ` IN ROLE ${inRoles.join(', ')}` : ''}`,
    );
  } finally {
    await admin.end();
  }
  const url = new URL(db.url);
  url.username = role;
  url.password = password;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 3 });
  pool.on('error', () => undefined);
  return {
    role,
    pool,
    url: url.toString(),
    async drop() {
      await pool.end().catch(() => undefined);
      // Grants/objetos do login no banco isolado (GRANT de teste, tabelas criadas) impedem o DROP ROLE.
      await db.pool.query(`DROP OWNED BY ${role}`).catch(() => undefined);
      const cleanup = await connectWithRetry(base.toString());
      try {
        await cleanup.query(`DROP ROLE IF EXISTS ${role}`);
      } finally {
        await cleanup.end();
      }
    },
  };
}

/**
 * Login de teste, membro (INHERIT) do grupo de runtime, sem ser owner nem superuser.
 * A senha é gerada na hora e só existe neste processo de teste. Aplica o equivalente de roles.sql ao banco isolado.
 */
export async function createRuntimeLogin(db: IsolatedDatabase): Promise<RuntimeLogin> {
  await provisionIsolatedRoles(db);
  return createTestLogin(db);
}

export interface IsolatedDatabase {
  readonly url: string;
  readonly pool: pg.Pool;
  drop(): Promise<void>;
}

/** Banco novo por arquivo de teste, migrado do zero; removido no final. */
export async function createIsolatedDatabase(poolSize = 10, options: { readonly migrate?: boolean } = {}): Promise<IsolatedDatabase> {
  const base = testDatabaseUrl();
  const name = `openclaw_risk_${randomUUID().replaceAll('-', '').slice(0, 12)}_test`;
  const admin = await connectWithRetry(base.toString());
  try {
    await ensureRuntimeGroup(admin);
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const url = new URL(base);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: poolSize });
  // Sem listener, um erro em cliente ocioso vira exceção não tratada em outro ponto do processo (flaky 57P01).
  // Erros são coletados e relançados em drop(); só 57P01 DURANTE o teardown é esperado e ignorado.
  let tearingDown = false;
  const poolErrors: Error[] = [];
  pool.on('error', (error) => {
    if (tearingDown && (error as { code?: string }).code === '57P01') return;
    poolErrors.push(error);
  });
  // `migrate: false` entrega um banco vazio, para testar o próprio comando de migração.
  if (options.migrate !== false) await migrate(pool, MIGRATIONS_DIR);
  return {
    url: url.toString(),
    pool,
    async drop() {
      // Erros de pool ocorridos ANTES do teardown são reais e não podem ser mascarados.
      const early = poolErrors.splice(0);
      tearingDown = true;
      await pool.end();
      const cleanup = await connectWithRetry(base.toString());
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await cleanup.end();
      }
      const late = [...early, ...poolErrors.splice(0)];
      if (late.length > 0) throw new AggregateError(late, `erro(s) no pool de teste: ${late.map((e) => e.message).join('; ')}`);
    },
  };
}

/** Concessão FICTÍCIA ativa (ou já revogada, se `revokedAt` for informado). */
export async function seedGrant(
  pool: pg.Pool,
  grant: { principalId: string; role: 'AGENT' | 'PAPER_EXECUTOR'; accountId: string; revokedAt?: string },
): Promise<string> {
  const grantId = randomUUID();
  await pool.query(
    `INSERT INTO risk_access_grants (grant_id, principal_id, role, account_id, granted_at, granted_by)
     VALUES ($1, $2, $3, $4, '2026-01-01T00:00:00Z', 'fixture-admin')`,
    [grantId, grant.principalId, grant.role, grant.accountId],
  );
  if (grant.revokedAt) {
    await pool.query(`UPDATE risk_access_grants SET revoked_at = $2, revoked_by = 'fixture-admin' WHERE grant_id = $1`, [grantId, grant.revokedAt]);
  }
  return grantId;
}

/** Cria conta PAPER; por padrão concede ao agente e ao executor das fixtures (desligue com `grants = false`). */
export async function seedAccount(pool: pg.Pool, accountId = 'paper-fixture', grants = true): Promise<void> {
  await pool.query(`INSERT INTO risk_accounts (account_id, environment) VALUES ($1, 'PAPER')`, [accountId]);
  if (!grants) return;
  await seedGrant(pool, { principalId: 'agent-fixture-crypto', role: 'AGENT', accountId });
  await seedGrant(pool, { principalId: 'executor-fixture', role: 'PAPER_EXECUTOR', accountId });
}

/** Insere política FICTÍCIA com hash íntegro; `active` controla a versão vigente. */
export async function seedPolicy(
  pool: pg.Pool,
  overrides: Record<string, unknown> = {},
  active = true,
): Promise<RiskPolicyV1> {
  const doc = unhashedPolicy(overrides) as unknown as Omit<RiskPolicyV1, 'policyHash'>;
  const policy: RiskPolicyV1 = { ...doc, policyHash: computePolicyHash(doc) };
  await pool.query(
    `INSERT INTO risk_policies (policy_id, version, account_id, policy_json, policy_hash, valid_from, valid_until, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [policy.policyId, policy.version, policy.accountId, JSON.stringify(policy), policy.policyHash, policy.validFrom, policy.validUntil ?? null, active],
  );
  return policy;
}

export async function count(pool: pg.Pool, table: string, where = 'TRUE', params: unknown[] = []): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} WHERE ${where}`, params);
  return Number(rows[0]?.n ?? '0');
}

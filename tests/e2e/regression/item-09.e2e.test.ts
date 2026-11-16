import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { acquireSuiteLock, adminPool, call, consumePath, docker, e2eEnv, releasePath, runImageCli, withDatabase } from '../support/env.js';
import { accountCounts, asDecision, integrityViolations, seedAccountFor, uniqueAccount, type DecisionBody } from '../support/data.js';
import { agentAt, agentProposal, evaluateVia, startComposition, type Composition } from '../support/composition.js';

// Item §9.4 #9 — "Verificar comportamento de rollback e restauração".
// Invariantes: I-04 (restaurado não duplica nem reabre consumo), I-01 (ACTIVE anterior ao ponto de restauração não pode
// autorizar consumo depois da reconciliação), I-02 (decisões e política íntegras), I-05 (checksum divergente => not ready).
// Camadas: scripts/backup-local.sh e scripts/restore-local.sh REAIS (pg_dump/pg_restore 14 em contêiner descartável com label)
// sobre o banco E2E, restaurando em OUTRO banco *_test do mesmo contêiner; app como LOGIN DE RUNTIME no banco restaurado
// (composição com HTTP real) e CLI da IMAGEM (verify-runtime-privileges, expire-reservations).
// Procedimento decidido pelo usuário: após restaurar, o serviço fica NOT READY até reconciliar e as reservas ACTIVE anteriores
// ao ponto de restauração são expiradas antes de voltar. O restore-local.sh deixa o banco restaurado com restore_pending=true;
// a reconciliação é `reconcile-after-restore` (CLI da imagem, credencial de MIGRAÇÃO = login do grupo openclaw_risk_owner).
const env = e2eEnv();
const ROOT = join(import.meta.dirname, '../../..');
let release: () => void;
let admin: pg.Pool;
let comp: Composition; // fonte (banco E2E)
let restored: Composition | undefined;
let workDir: string;
let restoredDb: string | undefined;
let restoredAdminUrl: string;
let restoredRuntimeUrl: string;
let restoredAdmin: pg.Pool;
let migratorRole: string | undefined;
let migratorUrl = '';

const account = uniqueAccount(); // ALLOW vencidos + consumido
const freshAccount = uniqueAccount(); // ALLOW com TTL longo (não vencido no restore)
const old: DecisionBody[] = [];
const oldProposals: Record<string, unknown>[] = [];
let consumedDecision: DecisionBody;
let freshDecision: DecisionBody;
let blockDecisionId = '';
const ORDER = 'order-restore-1';

beforeAll(async () => {
  release = await acquireSuiteLock();
  admin = adminPool(4);
  workDir = mkdtempSync(join(tmpdir(), 'openclaw-risk-e2e-backup-'));
  comp = await startComposition();
  const agent = agentAt(comp, 0);
  const exec = comp.identities.executor;
  await seedAccountFor(admin, { accountId: account, agents: [agent.id], executors: [exec.id] });
  await seedAccountFor(admin, { accountId: freshAccount, agents: [agent.id], executors: [exec.id], policyOverrides: { maxAuthorizationTtlMs: 600_000 } });

  // Autorizações "antigas": relógio da composição 10 min atrás => já vencidas para o relógio real da CLI.
  comp.clock.set(Date.now() - 600_000);
  for (let i = 0; i < 3; i += 1) {
    const proposal = agentProposal(comp, account, agent);
    oldProposals.push(proposal);
    old.push(asDecision((await evaluateVia(comp, agent, proposal)).json));
  }
  consumedDecision = old[0] as DecisionBody;
  const consumedRes = await call(comp.url, 'POST', consumePath(consumedDecision.decisionId), exec.token, { accountId: account, paperOrderId: ORDER, proposalHash: consumedDecision.proposalHash });
  expect(consumedRes.status).toBe(200);
  const block = asDecision((await evaluateVia(comp, agent, agentProposal(comp, account, agent, { stopLossPrice: '100.50' }))).json);
  blockDecisionId = block.decisionId;
  // Autorização "fresca": relógio real, TTL de 10 min (política de teste) => ainda ACTIVE e não vencida no restore.
  comp.clock.set(Date.now());
  freshDecision = asDecision((await evaluateVia(comp, agent, agentProposal(comp, freshAccount, agent))).json);
  expect(old.every((d) => d.status === 'ALLOW_PAPER') && freshDecision.status === 'ALLOW_PAPER' && block.status === 'BLOCK').toBe(true);
});

afterAll(async () => {
  await restored?.close();
  await (restoredAdmin as pg.Pool | undefined)?.end().catch(() => undefined);
  await comp.close();
  if (restoredDb !== undefined) await admin.query(`DROP DATABASE IF EXISTS ${restoredDb} WITH (FORCE)`).catch(() => undefined);
  if (migratorRole !== undefined) await admin.query(`DROP ROLE IF EXISTS ${migratorRole}`).catch(() => undefined);
  await admin.end();
  rmSync(workDir, { recursive: true, force: true });
  release();
});

const cliEnv = (url: string): Record<string, string> => ({
  RISK_ENVIRONMENT: 'PAPER',
  RISK_DATABASE_URL: url,
  RISK_LOG_LEVEL: 'error',
  RISK_HTTP_ENABLED: 'false',
  RISK_CLOCK_SKEW_TOLERANCE_MS: '1000',
  RISK_DB_CONNECTION_TIMEOUT_MS: '3000',
  RISK_DB_STATEMENT_TIMEOUT_MS: '10000',
  RISK_DB_LOCK_TIMEOUT_MS: '5000',
});

const DB_DEADLINES = { RISK_DB_CONNECTION_TIMEOUT_MS: '3000', RISK_DB_STATEMENT_TIMEOUT_MS: '10000', RISK_DB_LOCK_TIMEOUT_MS: '5000' };
const migrationEnv = (): Record<string, string> => ({ RISK_ENVIRONMENT: 'PAPER', RISK_MIGRATION_DATABASE_URL: migratorUrl, ...DB_DEADLINES });
const reconcileCli = () => runImageCli(['reconcile-after-restore'], migrationEnv());
const auditCount = async (pool: pg.Pool, where = 'TRUE'): Promise<number> => Number((await pool.query<{ n: string }>(`SELECT count(*)::text n FROM risk_audit_events WHERE ${where}`)).rows[0]?.n);
const RESTORE_EVENTS = `event_type NOT IN ('RESTORE_PENDING_MARKED', 'RESTORE_RECONCILED') AND NOT (event_type = 'RESERVATION_EXPIRED' AND details_json->>'trigger' = 'post-restore-reconciliation')`;
const MIGRATIONS_QUERY = 'SELECT version, checksum FROM schema_migrations ORDER BY version';
const TABLES = ['risk_accounts', 'risk_policies', 'trade_proposals', 'risk_decisions', 'risk_reservations', 'risk_audit_events', 'risk_outbox', 'risk_access_grants', 'schema_migrations'];
const GRANTS_QUERY = `SELECT table_name, privilege_type FROM information_schema.role_table_grants WHERE grantee = 'openclaw_risk_runtime' ORDER BY 1, 2`;
const COLUMN_GRANTS_QUERY = `SELECT table_name, column_name, privilege_type FROM information_schema.column_privileges WHERE grantee = 'openclaw_risk_runtime' AND table_schema = 'public' ORDER BY 1, 2, 3`;
const TRIGGERS_QUERY = `SELECT tgrelid::regclass::text AS tbl, tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1, 2`;

describe('backup e restauração pelos scripts locais', { timeout: 240_000 }, () => {
  it('backup-local.sh grava o dump; recusa banco que não seja *_test, host remoto e sobrescrita', () => {
    const dump = join(workDir, 'risk.dump');
    execFileSync('sh', [join(ROOT, 'scripts/backup-local.sh'), dump], { env: { ...process.env, RISK_BACKUP_URL: env.databaseUrl }, stdio: 'pipe', timeout: 120_000 });
    expect(existsSync(dump)).toBe(true);
    expect(statSync(dump).size).toBeGreaterThan(1000);
    const refuse = (url: string, out: string): string => {
      try {
        execFileSync('sh', [join(ROOT, 'scripts/backup-local.sh'), out], { env: { ...process.env, RISK_BACKUP_URL: url }, stdio: 'pipe', timeout: 30_000 });
        return 'EXECUTOU';
      } catch (e) {
        return (e as { stderr: Buffer }).stderr.toString();
      }
    };
    expect(refuse(withDatabaseUnsafe(env.databaseUrl, 'postgres'), join(workDir, 'x1.dump'))).toMatch(/_test/);
    expect(refuse(env.databaseUrl.replace('127.0.0.1', 'db.example.invalid'), join(workDir, 'x2.dump'))).toMatch(/local/);
    expect(refuse(env.databaseUrl, dump)).toMatch(/já existe/);
    expect(existsSync(join(workDir, 'x1.dump')) || existsSync(join(workDir, 'x2.dump'))).toBe(false);
  });

  it('restore-local.sh restaura em banco NOVO *_test; recusa banco com tabelas, banco não *_test e host remoto', async () => {
    restoredDb = `openclaw_risk_restore_${uniqueAccount().slice(-10).replace('-', '')}_test`;
    await admin.query(`CREATE DATABASE ${restoredDb}`);
    restoredAdminUrl = withDatabase(env.databaseUrl, restoredDb);
    restoredRuntimeUrl = withDatabase(env.runtimeDatabaseUrl, restoredDb);
    const run = (url: string): void => {
      execFileSync('sh', [join(ROOT, 'scripts/restore-local.sh'), join(workDir, 'risk.dump')], { env: { ...process.env, RISK_RESTORE_URL: url }, stdio: 'pipe', timeout: 180_000 });
    };
    const refuse = (url: string): string => {
      try {
        run(url);
        return 'EXECUTOU';
      } catch (e) {
        return (e as { stderr: Buffer }).stderr.toString();
      }
    };
    expect(refuse(withDatabaseUnsafe(env.databaseUrl, 'postgres'))).toMatch(/_test/);
    expect(refuse(env.databaseUrl.replace('127.0.0.1', 'db.example.invalid'))).toMatch(/local/);
    run(restoredAdminUrl);
    const rp = new pg.Pool({ connectionString: restoredAdminUrl, max: 3 });
    rp.on('error', () => undefined);
    restoredAdmin = rp;
    // Segunda restauração sobre banco já restaurado: recusada (não sobrescreve dados).
    expect(refuse(restoredAdminUrl)).toMatch(/não está vazio/);
    // Provisionamento do banco restaurado (CONNECT/CREATE do schema public): idempotente, pelo próprio roles.sql do projeto.
    docker(['exec', '-i', env.dbContainer, 'psql', '-h', '127.0.0.1', '-U', 'risk_e2e_admin', '-d', restoredDb, '-v', 'ON_ERROR_STOP=1', '-q', '-v', `dbname=${restoredDb}`], {
      input: readFileSync(join(ROOT, 'scripts/provision/roles.sql'), 'utf8'),
    });
  });

  it('checksums de migração, contagens por tabela, grants (tabela e coluna) e triggers idênticos aos da origem', async () => {
    const q = async (pool: pg.Pool, sql: string): Promise<unknown[]> => (await pool.query(sql)).rows as unknown[];
    expect(await q(restoredAdmin, MIGRATIONS_QUERY)).toEqual(await q(admin, MIGRATIONS_QUERY));
    for (const t of TABLES) {
      // Auditoria: o restaurado tem a marcação RESTORE_PENDING_MARKED (e, depois, RESTORE_RECONCILED/RESERVATION_EXPIRED da reconciliação) a mais.
      const where = t === 'risk_audit_events' ? ` WHERE ${RESTORE_EVENTS}` : '';
      const [a, b] = await Promise.all([q(admin, `SELECT count(*)::text n FROM ${t}${where}`), q(restoredAdmin, `SELECT count(*)::text n FROM ${t}${where}`)]);
      // A origem pode ter recebido linhas depois do dump (outros arquivos em paralelo são serializados pelo lock): igualdade exata.
      expect(b, t).toEqual(a);
    }
    expect(await q(restoredAdmin, GRANTS_QUERY)).toEqual(await q(admin, GRANTS_QUERY));
    expect((await q(restoredAdmin, GRANTS_QUERY)).length).toBeGreaterThan(0);
    expect(await q(restoredAdmin, COLUMN_GRANTS_QUERY)).toEqual(await q(admin, COLUMN_GRANTS_QUERY));
    expect(await q(restoredAdmin, TRIGGERS_QUERY)).toEqual(await q(admin, TRIGGERS_QUERY));
    // Nenhum DELETE/TRUNCATE/UPDATE amplo para o runtime no restaurado.
    const grants = (await q(restoredAdmin, GRANTS_QUERY)) as { table_name: string; privilege_type: string }[];
    expect(grants.filter((g) => ['DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'].includes(g.privilege_type))).toEqual([]);
  });

  it('CLI da imagem: verify-runtime-privileges no banco restaurado → 0 (privilégios no mínimo)', () => {
    const r = runImageCli(['verify-runtime-privileges'], cliEnv(restoredRuntimeUrl));
    expect({ code: r.code, out: r.stdout.trim() }).toEqual({ code: 0, out: 'privilégios de runtime no mínimo' });
  });
});

describe('banco restaurado nasce restore_pending=true: indisponível até reconciliar', { timeout: 240_000 }, () => {
  let before: Awaited<ReturnType<typeof accountCounts>>;
  let activeBefore: { reservation_id: string; status: string }[];

  it('restore-local.sh marcou restore_pending=true, auditou RESTORE_PENDING_MARKED (1) e o histórico registra a marcação; ownership é do dono', async () => {
    const st = await restoredAdmin.query<{ restore_pending: boolean; restore_marked_at: Date | null; restore_cleared_at: Date | null }>('SELECT restore_pending, restore_marked_at, restore_cleared_at FROM risk_operational_state');
    expect(st.rows).toHaveLength(1);
    expect(st.rows[0]?.restore_pending).toBe(true);
    expect(st.rows[0]?.restore_marked_at).toBeInstanceOf(Date);
    expect(st.rows[0]?.restore_cleared_at).toBeNull();
    expect(await auditCount(restoredAdmin, `event_type = 'RESTORE_PENDING_MARKED'`)).toBe(1);
    expect(await auditCount(admin, `event_type = 'RESTORE_PENDING_MARKED'`)).toBe(0); // a origem segue intocada
    const hSrc = Number((await admin.query<{ n: string }>('SELECT count(*)::text n FROM risk_operational_state_history')).rows[0]?.n);
    const hRes = (await restoredAdmin.query<{ restore_pending: boolean }>('SELECT restore_pending FROM risk_operational_state_history ORDER BY history_id')).rows;
    expect(hRes).toHaveLength(hSrc + 1);
    expect(hRes[hRes.length - 1]?.restore_pending).toBe(true);
    const owners = await restoredAdmin.query<{ owner: string }>(`SELECT DISTINCT pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'S')`);
    expect(owners.rows.map((r) => r.owner)).toEqual(['openclaw_risk_owner']);
    // Login de MIGRAÇÃO de teste (membro do grupo dono): é com ele que a CLI da imagem reconcilia.
    migratorRole = `e2e_item09_migrator_${randomBytes(4).toString('hex')}`;
    const password = randomBytes(16).toString('hex');
    await admin.query(`CREATE ROLE ${migratorRole} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${password}' IN ROLE openclaw_risk_owner`);
    const u = new URL(restoredAdminUrl);
    u.username = migratorRole;
    u.password = password;
    migratorUrl = u.toString();
  });

  it('com a app de runtime sobre o restaurado: ready 503 (só reconciliation fail), live 200', async () => {
    restored = await startComposition({ databaseUrl: restoredRuntimeUrl, identities: comp.identities });
    const ready = await call(restored.url, 'GET', '/health/ready', null);
    expect(ready.status).toBe(503);
    expect(ready.json).toEqual({ status: 'not_ready', checks: { database: 'ok', schema: 'ok', privileges: 'ok', reconciliation: 'fail', draining: 'ok' } });
    expect((await call(restored.url, 'GET', '/health/live', null)).status).toBe(200);
    // O runtime continua sem poder limpar a pendência.
    await expect(restored.pool.query('UPDATE risk_operational_state SET restore_pending = FALSE')).rejects.toMatchObject({ code: '42501' });
    expect((await restoredAdmin.query('SELECT restore_pending FROM risk_operational_state')).rows[0]).toEqual({ restore_pending: true });
  });

  it('evaluate (nova proposta e replay de uma antiga), consume e release → 503; nada gravado; nenhum ALLOW; ACTIVE intactas', async () => {
    const c = restored as Composition;
    const agent = agentAt(c, 0);
    before = await accountCounts(restoredAdmin, account);
    const beforeFresh = await accountCounts(restoredAdmin, freshAccount);
    activeBefore = (await restoredAdmin.query<{ reservation_id: string; status: string }>(`SELECT reservation_id::text, status FROM risk_reservations ORDER BY reservation_id`)).rows;
    const auditTotal = await auditCount(restoredAdmin);
    const exec = c.identities.executor.token;

    const fresh = await evaluateVia(c, agent, agentProposal(c, account, agent));
    expect(fresh.status).toBe(503);
    const replay = await evaluateVia(c, agent, oldProposals[1]);
    expect(replay.status).toBe(503);
    for (const r of [fresh, replay]) expect(r.text).not.toContain('ALLOW_PAPER');

    const stale = old[1] as DecisionBody;
    const consumeStale = await call(c.url, 'POST', consumePath(stale.decisionId), exec, { accountId: account, paperOrderId: 'order-pendente-1', proposalHash: stale.proposalHash });
    const consumeFresh = await call(c.url, 'POST', consumePath(freshDecision.decisionId), exec, { accountId: freshAccount, paperOrderId: 'order-pendente-2', proposalHash: freshDecision.proposalHash });
    const releaseFresh = await call(c.url, 'POST', releasePath(freshDecision.reservationId ?? ''), exec, { reason: 'pendente' });
    expect([consumeStale.status, consumeFresh.status, releaseFresh.status]).toEqual([503, 503, 503]);

    expect(await accountCounts(restoredAdmin, account)).toEqual(before);
    expect(await accountCounts(restoredAdmin, freshAccount)).toEqual(beforeFresh);
    expect(await auditCount(restoredAdmin)).toBe(auditTotal);
    expect((await restoredAdmin.query<{ reservation_id: string; status: string }>(`SELECT reservation_id::text, status FROM risk_reservations ORDER BY reservation_id`)).rows).toEqual(activeBefore);
    expect(activeBefore.filter((r) => r.status === 'ACTIVE').length).toBeGreaterThanOrEqual(3);
    // Falha de infraestrutura/pendência vira 503 e nunca vaza a causa.
    for (const r of [fresh, replay, consumeStale, consumeFresh, releaseFresh]) expect(r.text).not.toMatch(/restore|reconcil|risk_operational|postgres/i);
  });

  it('expire-reservations (CLI da imagem, runtime) falha com exit 1 e não expira nada, mesmo havendo ACTIVE vencidas', async () => {
    const overdue = await restoredAdmin.query<{ n: string }>(`SELECT count(*)::text n FROM risk_reservations WHERE status = 'ACTIVE' AND expires_at < now()`);
    expect(Number(overdue.rows[0]?.n)).toBeGreaterThanOrEqual(2);
    const r = runImageCli(['expire-reservations'], cliEnv(restoredRuntimeUrl));
    expect(r.code).toBe(1);
    expect(r.stderr).toBe('varredura de reservas falhou; nenhuma expiração foi confirmada\n');
    expect((await restoredAdmin.query<{ reservation_id: string; status: string }>(`SELECT reservation_id::text, status FROM risk_reservations ORDER BY reservation_id`)).rows).toEqual(activeBefore);
  });

  it('a credencial de runtime não reconcilia (exit 1, nada muda); sem credencial de migração → exit 2; a pendência segue ligada', async () => {
    const asRuntime = runImageCli(['reconcile-after-restore'], { RISK_ENVIRONMENT: 'PAPER', RISK_MIGRATION_DATABASE_URL: restoredRuntimeUrl, ...DB_DEADLINES });
    expect(asRuntime.code).toBe(1);
    expect(asRuntime.stderr).toBe('reconciliação falhou; nada foi confirmado\n');
    const noConfig = runImageCli(['reconcile-after-restore'], { RISK_ENVIRONMENT: 'PAPER', RISK_DATABASE_URL: restoredRuntimeUrl });
    expect(noConfig.code).toBe(2);
    // Sem os prazos de banco (credencial de migração válida) a CLI recusa antes de conectar: exit 2.
    const noDeadlines = runImageCli(['reconcile-after-restore'], { RISK_ENVIRONMENT: 'PAPER', RISK_MIGRATION_DATABASE_URL: migratorUrl });
    expect(noDeadlines.code).toBe(2);
    expect(noDeadlines.stderr).toMatch(/RISK_DB_(CONNECTION|STATEMENT|LOCK)_TIMEOUT_MS/);
    expect(noDeadlines.stdout + noDeadlines.stderr).not.toMatch(/postgres(ql)?:\/\/|restore_pending/);
    expect((await restoredAdmin.query('SELECT restore_pending FROM risk_operational_state')).rows[0]).toEqual({ restore_pending: true });
    expect((await call((restored as Composition).url, 'GET', '/health/ready', null)).status).toBe(503);
  });

  it('verify-runtime-privileges continua 0 com a pendência ligada (privilégios não dependem da reconciliação)', () => {
    const r = runImageCli(['verify-runtime-privileges'], cliEnv(restoredRuntimeUrl));
    expect({ code: r.code, out: r.stdout.trim() }).toEqual({ code: 0, out: 'privilégios de runtime no mínimo' });
  });
});

describe('reconcile-after-restore (CLI da imagem, credencial de migração): ACTIVE anteriores → EXPIRED; ready volta', { timeout: 240_000 }, () => {
  let activeIds: string[] = [];
  let auditBeforeReconcile = 0;

  it('todas as ACTIVE herdadas do dump (de TODAS as contas, vencidas ou vigentes) viram EXPIRED com auditoria trigger=post-restore-reconciliation', async () => {
    activeIds = (await restoredAdmin.query<{ reservation_id: string }>(`SELECT reservation_id::text FROM risk_reservations WHERE status = 'ACTIVE' ORDER BY 1`)).rows.map((r) => r.reservation_id);
    expect(activeIds).toContain(freshDecision.reservationId); // vigente (TTL longo): também é anterior ao ponto de restauração
    expect(activeIds).toContain((old[1] as DecisionBody).reservationId);
    expect(activeIds).toContain((old[2] as DecisionBody).reservationId);
    const consumedId = consumedDecision.reservationId;
    auditBeforeReconcile = await auditCount(restoredAdmin);
    const r = reconcileCli();
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain(`reconciliação concluída; reservas expiradas: ${activeIds.length}\n`);
    expect(r.stdout + r.stderr).not.toMatch(/postgres(ql)?:\/\//);
    const after = await restoredAdmin.query<{ reservation_id: string; status: string; closed_at: Date | null }>(`SELECT reservation_id::text, status, closed_at FROM risk_reservations WHERE reservation_id::text = ANY($1)`, [activeIds]);
    expect(after.rows).toHaveLength(activeIds.length);
    for (const row of after.rows) {
      expect(row.status).toBe('EXPIRED');
      expect(row.closed_at).toBeInstanceOf(Date);
    }
    expect((await restoredAdmin.query(`SELECT 1 FROM risk_reservations WHERE status = 'ACTIVE'`)).rowCount).toBe(0);
    expect((await restoredAdmin.query<{ status: string }>('SELECT status FROM risk_reservations WHERE reservation_id = $1', [consumedId])).rows[0]?.status).toBe('CONSUMED');
    const events = await restoredAdmin.query<{ reservation_id: string; trigger: string }>(
      `SELECT reservation_id::text, details_json->>'trigger' AS trigger FROM risk_audit_events WHERE event_type = 'RESERVATION_EXPIRED' AND details_json->>'trigger' = 'post-restore-reconciliation' ORDER BY 1`,
    );
    expect(events.rows.map((e) => e.reservation_id)).toEqual(activeIds);
    const rec = await restoredAdmin.query<{ details_json: Record<string, unknown> }>(`SELECT details_json FROM risk_audit_events WHERE event_type = 'RESTORE_RECONCILED'`);
    expect(rec.rows).toEqual([{ details_json: { trigger: 'post-restore-reconciliation', expiredReservations: activeIds.length } }]);
    expect(await auditCount(restoredAdmin)).toBe(auditBeforeReconcile + activeIds.length + 1);
    const st = (await restoredAdmin.query<{ restore_pending: boolean; restore_cleared_at: Date | null }>('SELECT restore_pending, restore_cleared_at FROM risk_operational_state')).rows[0];
    expect(st?.restore_pending).toBe(false);
    expect(st?.restore_cleared_at).toBeInstanceOf(Date);
  });

  it('a origem não é tocada pela reconciliação e a auditoria restaurada = origem + marcação + reconciliação + expirações', async () => {
    expect((await admin.query(`SELECT 1 FROM risk_audit_events WHERE event_type IN ('RESTORE_PENDING_MARKED', 'RESTORE_RECONCILED')`)).rowCount).toBe(0);
    const src = await auditCount(admin, RESTORE_EVENTS);
    const dst = await auditCount(restoredAdmin, RESTORE_EVENTS);
    expect(dst).toBe(src);
    expect(await auditCount(restoredAdmin)).toBe(src + 1 + 1 + activeIds.length);
  });

  it('idempotência: segunda execução sai 0 "nada a reconciliar" e não toca em nada', async () => {
    const total = await auditCount(restoredAdmin);
    const hist = Number((await restoredAdmin.query<{ n: string }>('SELECT count(*)::text n FROM risk_operational_state_history')).rows[0]?.n);
    const r = reconcileCli();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('nada a reconciliar');
    expect(await auditCount(restoredAdmin)).toBe(total);
    expect(Number((await restoredAdmin.query<{ n: string }>('SELECT count(*)::text n FROM risk_operational_state_history')).rows[0]?.n)).toBe(hist);
  });

  it('o serviço volta: ready 200 com todos os checks ok (reconciliation ok) na app já em execução, sem reiniciar', async () => {
    const ready = await call((restored as Composition).url, 'GET', '/health/ready', null);
    expect(ready.status).toBe(200);
    expect(ready.json).toEqual({ status: 'ready', checks: { database: 'ok', schema: 'ok', privileges: 'ok', reconciliation: 'ok', draining: 'ok' } });
  });

  it('as autorizações anteriores não são mais consumíveis (I-01): nem a vencida nem a vigente; release também não as reabre', async () => {
    const c = restored as Composition;
    const exec = c.identities.executor.token;
    const stale = old[1] as DecisionBody;
    // Relógio da composição "dentro" do TTL original: só o estado EXPIRED impede o consumo.
    c.clock.set(Date.now() - 600_000);
    const late = await call(c.url, 'POST', consumePath(stale.decisionId), exec, { accountId: account, paperOrderId: 'order-apos-reconciliar-1', proposalHash: stale.proposalHash });
    c.clock.set(Date.now());
    const vigente = await call(c.url, 'POST', consumePath(freshDecision.decisionId), exec, { accountId: freshAccount, paperOrderId: 'order-apos-reconciliar-2', proposalHash: freshDecision.proposalHash });
    expect([late.status, vigente.status]).toEqual([409, 409]);
    const rel = await call(c.url, 'POST', releasePath(freshDecision.reservationId ?? ''), exec, { reason: 'tarde' });
    expect(rel.status).toBe(409);
    expect((await restoredAdmin.query<{ status: string }>('SELECT status FROM risk_reservations WHERE reservation_id = $1', [freshDecision.reservationId])).rows[0]?.status).toBe('EXPIRED');
    expect((await restoredAdmin.query(`SELECT 1 FROM risk_reservations WHERE paper_order_id LIKE 'order-apos-reconciliar%' OR paper_order_id LIKE 'order-pendente%'`)).rowCount).toBe(0);
  });
});

describe('app como login de runtime no banco restaurado', { timeout: 240_000 }, () => {
  it('sem superuser, o restaurado reconciliado está ready (schema, privilégios e reconciliação ok) e o runtime não consegue DELETE/TRUNCATE/UPDATE amplo', async () => {
    const c = restored as Composition;
    const ready = await call(c.url, 'GET', '/health/ready', null);
    expect(ready.status).toBe(200);
    expect(ready.json).toMatchObject({ status: 'ready', checks: { database: 'ok', schema: 'ok', privileges: 'ok', reconciliation: 'ok' } });
    for (const sql of ['DELETE FROM risk_decisions', 'TRUNCATE risk_decisions', 'UPDATE risk_decisions SET status = status', 'UPDATE risk_reservations SET exposure_base = 1', 'UPDATE risk_operational_state SET restore_pending = TRUE', 'SELECT 1 FROM risk_operational_state_history']) {
      await expect(c.pool.query(sql), sql).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('replay das propostas originais devolve exatamente as decisões originais (sem nova reserva)', async () => {
    const c = restored as Composition;
    const before = await accountCounts(restoredAdmin, account);
    const agent = agentAt(c, 0);
    for (const [i, proposal] of oldProposals.entries()) {
      const r = await evaluateVia(c, agent, proposal);
      expect(r.status).toBe(200);
      expect(r.json).toEqual(old[i]);
      expect(r.headers.get('idempotent-replayed')).toBe('true');
    }
    expect(await accountCounts(restoredAdmin, account)).toEqual(before);
    expect((await call(c.url, 'GET', `/v1/risk/decisions/${blockDecisionId}`, c.identities.executor.token)).status).toBe(200);
    expect(await integrityViolations(restoredAdmin, account)).toEqual([]);
    expect(await integrityViolations(restoredAdmin, freshAccount)).toEqual([]);
  });

  it('o consumo já feito não se repete com outra ordem; a ordem original repete (idempotente)', async () => {
    const c = restored as Composition;
    const exec = c.identities.executor.token;
    const body = { accountId: account, proposalHash: consumedDecision.proposalHash };
    expect((await call(c.url, 'POST', consumePath(consumedDecision.decisionId), exec, { ...body, paperOrderId: 'order-depois-do-restore' })).status).toBe(409);
    expect((await call(c.url, 'POST', consumePath(consumedDecision.decisionId), exec, { ...body, paperOrderId: ORDER })).json).toMatchObject({ status: 'CONSUMED', replayed: true });
  });
});

describe('depois da reconciliação: expire-reservations e novas autorizações', { timeout: 240_000 }, () => {
  it('expire-reservations (CLI da imagem) é no-op: nada ACTIVE restou para expirar; EXPIRED/CONSUMED permanecem e não há nova auditoria', async () => {
    const snapshot = async () => (await restoredAdmin.query<{ reservation_id: string; status: string }>(`SELECT reservation_id::text, status FROM risk_reservations ORDER BY 1`)).rows;
    const statuses = await snapshot();
    const total = await auditCount(restoredAdmin);
    expect(statuses.filter((r) => r.status === 'ACTIVE')).toEqual([]);
    for (let i = 0; i < 2; i += 1) {
      const r = runImageCli(['expire-reservations'], cliEnv(restoredRuntimeUrl));
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('reservas expiradas: 0\n');
    }
    expect(await snapshot()).toEqual(statuses);
    expect(await auditCount(restoredAdmin)).toBe(total);
    const mine = await restoredAdmin.query<{ status: string }>(`SELECT status FROM risk_reservations WHERE account_id = $1 ORDER BY status`, [account]);
    expect(mine.rows.map((x) => x.status)).toEqual(['CONSUMED', 'EXPIRED', 'EXPIRED']);
    const fresh = await restoredAdmin.query<{ status: string }>('SELECT status FROM risk_reservations WHERE reservation_id = $1', [freshDecision.reservationId]);
    expect(fresh.rows[0]?.status).toBe('EXPIRED'); // a vigente também foi expirada pela reconciliação (antes, só pelo TTL)
  });

  it('autorizações NOVAS voltam a funcionar depois da reconciliação (e a nova reserva fica ACTIVE: reconciliar de novo não a toca)', async () => {
    const c = restored as Composition;
    const agent = agentAt(c, 0);
    c.clock.set(Date.now());
    const r = await evaluateVia(c, agent, agentProposal(c, freshAccount, agent));
    expect(r.status).toBe(200);
    const d = asDecision(r.json);
    expect(d.status).toBe('ALLOW_PAPER');
    expect(reconcileCli().stdout).toContain('nada a reconciliar');
    expect((await restoredAdmin.query<{ status: string }>('SELECT status FROM risk_reservations WHERE reservation_id = $1', [d.reservationId])).rows[0]?.status).toBe('ACTIVE');
    expect(await integrityViolations(restoredAdmin, freshAccount)).toEqual([]);
  });
});

describe('rollback da imagem (N-1) e divergência de schema', () => {
  it('migração extra desconhecida da imagem é aceita (rollback para N-1); checksum divergente derruba o ready; restaurar o checksum recupera', async () => {
    const c = restored as Composition;
    await restoredAdmin.query(`INSERT INTO schema_migrations (version, checksum, applied_at) VALUES ('9999_futura_fixture.sql', $1, now())`, ['f'.repeat(64)]);
    expect((await call(c.url, 'GET', '/health/ready', null)).status).toBe(200);
    const original = (await restoredAdmin.query<{ checksum: string }>(`SELECT checksum FROM schema_migrations WHERE version = '0001_initial.sql'`)).rows[0]?.checksum ?? '';
    await restoredAdmin.query(`UPDATE schema_migrations SET checksum = $1 WHERE version = '0001_initial.sql'`, ['0'.repeat(64)]);
    const bad = await call(c.url, 'GET', '/health/ready', null);
    expect(bad.status).toBe(503);
    expect(bad.json).toMatchObject({ checks: { schema: 'fail' } });
    await restoredAdmin.query(`UPDATE schema_migrations SET checksum = $1 WHERE version = '0001_initial.sql'`, [original]);
    expect((await call(c.url, 'GET', '/health/ready', null)).status).toBe(200);
    await restoredAdmin.query(`DELETE FROM schema_migrations WHERE version = '9999_futura_fixture.sql'`);
  });

  it('o banco de origem não foi alterado pela restauração (mesmos checksums e contagens da conta)', async () => {
    const counts = await accountCounts(admin, account);
    expect(counts).toMatchObject({ allow: 3, block: 1, reservations: 3 });
    expect(await integrityViolations(admin, account)).toEqual([]);
  });
});

/** Só para testar a recusa dos scripts: troca o banco sem a trava `_test` do helper. */
function withDatabaseUnsafe(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

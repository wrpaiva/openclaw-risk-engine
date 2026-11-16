import pg from 'pg';
import { createServer, type Server } from 'node:http';
import { appendFileSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startServer } from '../contract/support.js';
import { validProposal } from '../fixtures/proposals.js';
import { count, createIsolatedDatabase, createRuntimeLogin, createTestLogin, seedAccount, seedPolicy, type IsolatedDatabase, type RuntimeLogin } from './support/database.js';
import { buildDist, freePort, runNode, runtimeEnv, type Dist, type RunResult } from './support/dist.js';
import { AGENT, executorPrincipal, harness, uniqueProposal } from './support/harness.js';
import { randomUUID } from 'node:crypto';

// CLI operacional executada como processo filho a partir do dist compilado (etapa 2.5). Tudo FICTÍCIO; bancos descartáveis *_test.
let dist: Dist;
const STACK = /\n\s+at .*\(|node:internal|\.js:\d+:\d+|Error:/;

beforeAll(() => {
  dist = buildDist('risk-cli', { copyMigrations: true });
});
afterAll(() => {
  dist.cleanup();
});

const base = (extra: Record<string, string> = {}): Record<string, string> => runtimeEnv({ RISK_HTTP_ENABLED: 'false', ...extra });
const run = (args: readonly string[], env: Record<string, string>, timeoutMs?: number) => runNode(dist.cliMain, args, env, timeoutMs);
/** Nenhuma saída pode ter stack trace nem segredos (senha de URL, a própria URL ou caminhos de arquivo de segredo). */
function expectClean(r: RunResult, secrets: readonly string[] = []): void {
  const all = `${r.stdout}\n${r.stderr}`;
  expect(all).not.toMatch(STACK);
  expect(all).not.toMatch(/postgres(ql)?:\/\//);
  for (const s of secrets) if (s !== '') expect(all, 'segredo vazou').not.toContain(s);
}
const secretsOf = (url: string): string[] => {
  const u = new URL(url);
  return [u.password, u.username, url];
};

describe('uso e códigos de saída (2 = uso/configuração inválidos)', () => {
  it('sem subcomando, subcomando desconhecido e argumentos extras → exit 2 com mensagem fixa', async () => {
    for (const args of [[], ['nao-existe'], ['migrate', 'extra'], ['--help'], ['MIGRATE'], ['']]) {
      const r = await run(args, base());
      expect(r.code, JSON.stringify(args)).toBe(2);
      expect(r.stdout).toBe('');
      expect(r.stderr).toMatch(/^(uso: main <migrate\|expire-reservations\|reconcile-after-restore\|mark-restore-pending\|verify-runtime-privileges\|healthcheck>|subcomando desconhecido)\n$/);
      expectClean(r);
    }
  });
});

describe('sem prazos de banco (RISK_DB_*_TIMEOUT_MS) os subcomandos de operador recusam: exit 2, banco intocado, só nomes de variáveis', () => {
  const DEADLINES = ['RISK_DB_CONNECTION_TIMEOUT_MS', 'RISK_DB_STATEMENT_TIMEOUT_MS', 'RISK_DB_LOCK_TIMEOUT_MS'] as const;
  const without = (env: Record<string, string>, names: readonly string[]): Record<string, string> => {
    return Object.fromEntries(Object.entries(env).filter(([k]) => !names.includes(k)));
  };

  it.each(['migrate', 'reconcile-after-restore', 'mark-restore-pending'] as const)('%s: ausência de cada prazo, e de todos, → exit 2 sem conectar', async (command) => {
    const db = await createIsolatedDatabase(2, { migrate: false });
    try {
      const env = base({ RISK_MIGRATION_DATABASE_URL: db.url });
      const sets: (readonly string[])[] = [...DEADLINES.map((d) => [d]), DEADLINES];
      for (const missing of sets) {
        const r = await run([command], without(env, missing));
        expect(r.code, `${command} sem ${missing.join(',')}`).toBe(2);
        expect(r.stdout).toBe('');
        for (const name of missing) expect(r.stderr, name).toContain(name);
        for (const present of DEADLINES.filter((d) => !missing.includes(d))) expect(r.stderr).not.toContain(present);
        expectClean(r, secretsOf(db.url));
      }
      // Nenhum comando chegou ao banco: nem a tabela de migrações foi criada.
      expect((await db.pool.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`)).rows[0]).toEqual({ n: 0 });
    } finally {
      await db.drop();
    }
  });

  it.each(['migrate', 'reconcile-after-restore', 'mark-restore-pending'] as const)('%s: prazo inválido (0, negativo, não numérico, decimal) → exit 2', async (command) => {
    const db = await createIsolatedDatabase(2, { migrate: false });
    try {
      for (const bad of ['0', '-1', 'abc', '1.5', '']) {
        const r = await run([command], base({ RISK_MIGRATION_DATABASE_URL: db.url, RISK_DB_LOCK_TIMEOUT_MS: bad }));
        expect(r.code, `${command} lock=${bad}`).toBe(2);
        expect(r.stderr).toContain('RISK_DB_LOCK_TIMEOUT_MS');
        expectClean(r, secretsOf(db.url));
      }
    } finally {
      await db.drop();
    }
  });

  it('migrate com os prazos presentes funciona e, com o lock de migração segurado por outra sessão, falha (exit 1) em tempo finito', async () => {
    const db = await createIsolatedDatabase(2, { migrate: false });
    const holder = new pg.Client({ connectionString: db.url });
    holder.on('error', () => undefined);
    await holder.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1)', [7_340_011_001]);
      const t0 = Date.now();
      const r = await run(['migrate'], base({ RISK_MIGRATION_DATABASE_URL: db.url, RISK_DB_LOCK_TIMEOUT_MS: '500', RISK_DB_STATEMENT_TIMEOUT_MS: '8000' }), 30_000);
      expect(r.code).toBe(1);
      expect(Date.now() - t0).toBeLessThan(8000); // bem antes do statement_timeout: foi o lock_timeout
      expectClean(r, secretsOf(db.url));
      expect((await db.pool.query(`SELECT to_regclass('schema_migrations') AS t`)).rows[0]).toEqual({ t: null });
      await holder.query('SELECT pg_advisory_unlock($1)', [7_340_011_001]);
      expect((await run(['migrate'], base({ RISK_MIGRATION_DATABASE_URL: db.url }))).code).toBe(0);
    } finally {
      await holder.end().catch(() => undefined);
      await db.drop();
    }
  });
});

describe('migrate', () => {
  const migrationEnv = (url: string) => base({ RISK_MIGRATION_DATABASE_URL: url });
  const schemaCount = async (db: IsolatedDatabase) => (await db.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM information_schema.tables WHERE table_schema = 'public'`)).rows[0]?.n;

  it('sem credencial de migração → exit 2, banco intocado (a credencial de runtime NÃO é aceita como substituta)', async () => {
    const db = await createIsolatedDatabase(2, { migrate: false });
    try {
      const r = await run(['migrate'], base({ RISK_DATABASE_URL: db.url }));
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('RISK_MIGRATION_DATABASE_URL');
      expectClean(r, secretsOf(db.url));
      expect(await schemaCount(db)).toBe('0');
    } finally {
      await db.drop();
    }
  });

  it('RISK_ENVIRONMENT ausente ou não PAPER → exit 2 sem tocar no banco', async () => {
    const db = await createIsolatedDatabase(2, { migrate: false });
    try {
      for (const environment of [undefined, 'LIVE']) {
        const env = migrationEnv(db.url);
        if (environment === undefined) delete env['RISK_ENVIRONMENT'];
        else env['RISK_ENVIRONMENT'] = environment;
        const r = await run(['migrate'], env);
        expect(r.code, String(environment)).toBe(2);
        expectClean(r, secretsOf(db.url));
      }
      expect(await schemaCount(db)).toBe('0');
    } finally {
      await db.drop();
    }
  });

  it('credencial de migração via _FILE (com newline final) aplica as 4 migrações; reexecução é no-op com exit 0', async () => {
    const db = await createIsolatedDatabase(2, { migrate: false });
    const file = join(dist.work, `mig-${randomUUID()}.url`);
    writeFileSync(file, `${db.url}\n`, { mode: 0o600 });
    try {
      const env = base({ RISK_MIGRATION_DATABASE_URL_FILE: file });
      const first = await run(['migrate'], env);
      expect(first.code).toBe(0);
      expect(first.stdout.trim().split('\n')).toEqual(['aplicada 0001_initial.sql', 'aplicada 0002_access_grants.sql', 'aplicada 0003_runtime_privileges.sql', 'aplicada 0004_restore_reconciliation.sql']);
      expect(first.stderr).toBe('');
      expectClean(first, [...secretsOf(db.url), file]);
      expect(await count(db.pool, 'schema_migrations')).toBe(4);
      const second = await run(['migrate'], env);
      expect(second.code).toBe(0);
      expect(second.stdout).toBe('nenhuma migração pendente\n');
      expect(await count(db.pool, 'schema_migrations')).toBe(4);
    } finally {
      rmSync(file, { force: true });
      await db.drop();
    }
  });

  it('arquivo de credencial ilegível/vazio → exit 2 sem vazar caminho', async () => {
    const empty = join(dist.work, `empty-${randomUUID()}.url`);
    writeFileSync(empty, '\n');
    try {
      for (const file of [join(dist.work, 'nao-existe.url'), empty]) {
        const r = await run(['migrate'], base({ RISK_MIGRATION_DATABASE_URL_FILE: file }));
        expect(r.code).toBe(2);
        expect(r.stderr).toMatch(/^RISK_MIGRATION_DATABASE_URL_FILE: (arquivo ilegível|conteúdo inválido)\n$/);
        expectClean(r, [file]);
      }
    } finally {
      rmSync(empty, { force: true });
    }
  });

  it('as duas formas juntas → exit 2 (exclusividade)', async () => {
    const r = await run(['migrate'], base({ RISK_MIGRATION_DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x_test', RISK_MIGRATION_DATABASE_URL_FILE: '/nao/existe' }));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('mutuamente exclusivos');
    expectClean(r);
  });

  it('com a credencial de RUNTIME no lugar da de migração → exit 1, nada criado, mensagem fixa', async () => {
    const db = await createIsolatedDatabase(2, { migrate: false });
    const login = await createRuntimeLogin(db);
    try {
      const r = await run(['migrate'], migrationEnv(login.url));
      expect(r.code).toBe(1);
      expect(r.stderr).toBe('migração falhou; nada foi confirmado para a migração em curso\n');
      expectClean(r, secretsOf(login.url));
      expect(await schemaCount(db)).toBe('0');
    } finally {
      await login.drop();
      await db.drop();
    }
  });

  it('banco inalcançável → exit 1 com mensagem fixa e sem o endereço', async () => {
    const r = await run(['migrate'], migrationEnv('postgres://alguem:senha-zz9@127.0.0.1:1/openclaw_risk_zz9_test'));
    expect(r.code).toBe(1);
    expect(r.stderr).toBe('migração falhou; nada foi confirmado para a migração em curso\n');
    expectClean(r, ['senha-zz9', 'alguem', 'zz9']);
  });

  it('migração com erro no meio: rollback dela, anteriores preservadas, exit 1, e correção retoma de onde parou', async () => {
    const db = await createIsolatedDatabase(2, { migrate: false });
    const bad = join(dist.work, 'migrations/0005_quebrada.sql');
    writeFileSync(bad, 'CREATE TABLE risk_cli_half_done (x int);\nSELECT funcao_que_nao_existe();\n');
    try {
      const failed = await run(['migrate'], migrationEnv(db.url));
      expect(failed.code).toBe(1);
      expect(failed.stderr).toBe('migração falhou; nada foi confirmado para a migração em curso\n');
      expect(failed.stderr).not.toMatch(/funcao_que_nao_existe|risk_cli_half_done|0005/);
      expectClean(failed, secretsOf(db.url));
      const tables = await db.pool.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'risk_cli_half_done'`);
      expect(tables.rowCount).toBe(0);
      expect((await db.pool.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version')).rows.map((r) => r.version)).toEqual([
        '0001_initial.sql', '0002_access_grants.sql', '0003_runtime_privileges.sql', '0004_restore_reconciliation.sql',
      ]);
    } finally {
      rmSync(bad, { force: true });
    }
    try {
      const resumed = await run(['migrate'], migrationEnv(db.url));
      expect(resumed.code).toBe(0);
      expect(resumed.stdout).toBe('nenhuma migração pendente\n');
    } finally {
      await db.drop();
    }
  });

  it('retomada: banco com só 0001-0003 aplicadas; a CLI aplica 0004 e depois não há mais nada pendente', async () => {
    const db = await createIsolatedDatabase(2, { migrate: false });
    const m4 = join(dist.work, 'migrations/0004_restore_reconciliation.sql');
    const parked = join(dist.work, '0004.parked');
    renameSync(m4, parked);
    try {
      const first = await run(['migrate'], migrationEnv(db.url));
      expect(first.code).toBe(0);
      expect(first.stdout.trim().split('\n')).toEqual(['aplicada 0001_initial.sql', 'aplicada 0002_access_grants.sql', 'aplicada 0003_runtime_privileges.sql']);
      expect(await count(db.pool, 'schema_migrations')).toBe(3);
    } finally {
      renameSync(parked, m4);
    }
    try {
      const resumed = await run(['migrate'], migrationEnv(db.url));
      expect(resumed.code).toBe(0);
      expect(resumed.stdout).toBe('aplicada 0004_restore_reconciliation.sql\n');
      expect(await count(db.pool, 'schema_migrations')).toBe(4);
      expect(await count(db.pool, 'risk_operational_state', 'NOT restore_pending')).toBe(1);
      expect((await run(['migrate'], migrationEnv(db.url))).stdout).toBe('nenhuma migração pendente\n');
    } finally {
      await db.drop();
    }
  });

  it('migração já aplicada e alterada depois → exit 1 sem aplicar nada novo (imutabilidade)', async () => {
    const db = await createIsolatedDatabase(2, { migrate: false });
    const first = join(dist.work, 'migrations/0001_initial.sql');
    const original = readFileSync(first, 'utf8');
    try {
      expect((await run(['migrate'], migrationEnv(db.url))).code).toBe(0);
      appendFileSync(first, '\n-- alteração indevida de teste\n');
      const r = await run(['migrate'], migrationEnv(db.url));
      expect(r.code).toBe(1);
      expect(r.stderr).toBe('migração falhou; nada foi confirmado para a migração em curso\n');
      expect(r.stderr).not.toContain('0001');
      expect(await count(db.pool, 'schema_migrations')).toBe(4);
    } finally {
      writeFileSync(first, original);
      await db.drop();
    }
  });
});

describe('expire-reservations', () => {
  let db: IsolatedDatabase;
  let rt: RuntimeLogin;
  const iso = (ms: number) => new Date(ms).toISOString();
  const runtimeCli = (url: string, extra: Record<string, string> = {}) => base({ RISK_DATABASE_URL: url, ...extra });

  beforeAll(async () => {
    db = await createIsolatedDatabase();
    await seedAccount(db.pool);
    // TTL de autorização FICTÍCIO longo, só para a reserva "fresca" não vencer durante o teste.
    await seedPolicy(db.pool, { maxAuthorizationTtlMs: 600_000 });
    rt = await createRuntimeLogin(db);
  });
  afterAll(async () => {
    await rt.drop();
    await db.drop();
  });

  async function authorizeAt(nowMs: number | null): Promise<string> {
    const h = harness(rt.pool);
    const ms = nowMs ?? Date.now();
    const times = nowMs === null ? { createdAt: iso(ms - 1000), expiresAt: iso(ms + 30_000) } : {};
    if (nowMs === null) {
      h.clock.set(iso(ms));
      if (h.external.snapshot) h.external.snapshot = { ...h.external.snapshot, asOf: iso(ms - 1000) };
      if (h.external.marketQuote) h.external.marketQuote = { ...h.external.marketQuote, asOf: iso(ms - 500) };
    }
    const proposal = validProposal({ proposalId: randomUUID(), idempotencyKey: `idem-${randomUUID()}`, ...times });
    const r = await h.evaluate.execute({ proposal, authenticatedAgentId: AGENT });
    if (r.kind !== 'DECISION' || r.decision.status !== 'ALLOW_PAPER' || !r.decision.reservationId) throw new Error(`esperava ALLOW_PAPER: ${JSON.stringify(r)}`);
    return r.decision.reservationId;
  }
  const status = async (id: string) => (await db.pool.query<{ status: string }>('SELECT status FROM risk_reservations WHERE reservation_id = $1', [id])).rows[0]?.status;

  it('expira só as vencidas (relógio real), com a credencial de runtime; repetir é no-op; reserva fresca fica ACTIVE', async () => {
    const stale = await authorizeAt(Date.parse('2026-11-13T22:00:00.000Z')); // vence em 2026-11-13T22:10, no passado
    const fresh = await authorizeAt(null); // vence daqui a ~10 minutos
    expect(await status(stale)).toBe('ACTIVE');
    const first = await run(['expire-reservations'], runtimeCli(rt.url));
    expect(first.code).toBe(0);
    expect(first.stdout).toBe('reservas expiradas: 1\n');
    expectClean(first, secretsOf(rt.url));
    expect(await status(stale)).toBe('EXPIRED');
    expect(await status(fresh)).toBe('ACTIVE');
    expect(await count(db.pool, 'risk_audit_events', `event_type = 'RESERVATION_EXPIRED' AND reservation_id = $1`, [stale])).toBe(1);
    const second = await run(['expire-reservations'], runtimeCli(rt.url));
    expect(second.code).toBe(0);
    expect(second.stdout).toBe('reservas expiradas: 0\n');
    expect(await count(db.pool, 'risk_audit_events', `event_type = 'RESERVATION_EXPIRED' AND reservation_id = $1`, [stale])).toBe(1);
    expect(await status(fresh)).toBe('ACTIVE');
  });

  it('varreduras concorrentes (3 processos) expiram cada reserva exatamente uma vez', async () => {
    const stale = await Promise.all([1, 2, 3, 4].map(() => authorizeAt(Date.parse('2026-11-13T22:00:00.000Z'))));
    const results = await Promise.all([1, 2, 3].map(() => run(['expire-reservations'], runtimeCli(rt.url))));
    for (const r of results) expect(r.code).toBe(0);
    const total = results.reduce((sum, r) => sum + Number(/reservas expiradas: (\d+)/.exec(r.stdout)?.[1] ?? NaN), 0);
    expect(total).toBe(4);
    for (const id of stale) {
      expect(await status(id)).toBe('EXPIRED');
      expect(await count(db.pool, 'risk_audit_events', `event_type = 'RESERVATION_EXPIRED' AND reservation_id = $1`, [id])).toBe(1);
    }
  });

  it('banco inalcançável → exit 1 com mensagem fixa; nada expira', async () => {
    const stale = await authorizeAt(Date.parse('2026-11-13T22:00:00.000Z'));
    const dead = new URL(rt.url);
    dead.port = '1';
    const r = await run(['expire-reservations'], runtimeCli(dead.toString()));
    expect(r.code).toBe(1);
    expect(r.stderr).toBe('varredura de reservas falhou; nenhuma expiração foi confirmada\n');
    expectClean(r, secretsOf(rt.url));
    expect(await status(stale)).toBe('ACTIVE');
    await run(['expire-reservations'], runtimeCli(rt.url));
  });

  it('configuração inválida → exit 2 sem tocar no banco', async () => {
    const stale = await authorizeAt(Date.parse('2026-11-13T22:00:00.000Z'));
    const cases: Record<string, string>[] = [
      { RISK_DB_STATEMENT_TIMEOUT_MS: '0' },
      { RISK_LOG_LEVEL: 'debug' },
      { RISK_ENVIRONMENT: 'LIVE' },
      { RISK_MIGRATION_DATABASE_URL: db.url }, // credencial de migração no ambiente de runtime
    ];
    for (const extra of cases) {
      const r = await run(['expire-reservations'], runtimeCli(rt.url, extra));
      expect(r.code, JSON.stringify(Object.keys(extra))).toBe(2);
      expect(r.stdout).toBe('');
      expectClean(r, [...secretsOf(rt.url), ...secretsOf(db.url)]);
    }
    const missing = runtimeCli(rt.url);
    delete missing['RISK_DATABASE_URL'];
    expect((await run(['expire-reservations'], missing)).code).toBe(2);
    expect(await status(stale)).toBe('ACTIVE');
    await run(['expire-reservations'], runtimeCli(rt.url));
  });

  it('credencial de runtime via _FILE funciona', async () => {
    const file = join(dist.work, `rt-${randomUUID()}.url`);
    writeFileSync(file, `${rt.url}\n`, { mode: 0o600 });
    try {
      const r = await run(['expire-reservations'], base({ RISK_DATABASE_URL_FILE: file }));
      expect(r.code).toBe(0);
      expectClean(r, [...secretsOf(rt.url), file]);
    } finally {
      rmSync(file, { force: true });
    }
  });
});

describe('mark-restore-pending e reconcile-after-restore', () => {
  let db: IsolatedDatabase;
  let rt: RuntimeLogin;
  const migEnv = (extra: Record<string, string> = {}) => base({ RISK_MIGRATION_DATABASE_URL: db.url, ...extra });
  const iso = (ms: number) => new Date(ms).toISOString();

  beforeAll(async () => {
    db = await createIsolatedDatabase(12);
    await seedAccount(db.pool);
    await seedPolicy(db.pool, { maxAuthorizationTtlMs: 600_000 });
    rt = await createRuntimeLogin(db);
  });
  afterAll(async () => {
    await rt.drop();
    await db.drop();
  });
  beforeEach(async () => {
    // Estado de partida do caso: nada pendente; reservas anteriores encerradas (só para não acumular capacidade).
    await db.pool.query('UPDATE risk_operational_state SET restore_pending = FALSE, restore_marked_at = NULL, restore_cleared_at = NULL WHERE singleton');
    await db.pool.query(`UPDATE risk_reservations SET status = 'RELEASED', closed_at = now() WHERE status = 'ACTIVE'`);
  });

  async function authorize(h = harness(rt.pool), atMs?: number): Promise<{ reservationId: string; decisionId: string; proposalHash: string; accountId: string }> {
    const ms = atMs ?? Date.now();
    h.clock.set(iso(ms));
    if (h.external.snapshot) h.external.snapshot = { ...h.external.snapshot, asOf: iso(ms - 1000) };
    if (h.external.marketQuote) h.external.marketQuote = { ...h.external.marketQuote, asOf: iso(ms - 500) };
    const proposal = validProposal({ proposalId: randomUUID(), idempotencyKey: `idem-${randomUUID()}`, createdAt: iso(ms - 1000), expiresAt: iso(ms + 30_000) });
    const r = await h.evaluate.execute({ proposal, authenticatedAgentId: AGENT });
    if (r.kind !== 'DECISION' || r.decision.status !== 'ALLOW_PAPER' || !r.decision.reservationId) throw new Error(`esperava ALLOW_PAPER: ${JSON.stringify(r)}`);
    return { reservationId: r.decision.reservationId, decisionId: r.decision.decisionId, proposalHash: r.decision.proposalHash, accountId: r.decision.accountId };
  }
  const status = async (id: string) => (await db.pool.query<{ status: string }>('SELECT status FROM risk_reservations WHERE reservation_id = $1', [id])).rows[0]?.status;
  const state = async () => (await db.pool.query<{ restore_pending: boolean; restore_marked_at: Date | null; restore_cleared_at: Date | null }>('SELECT restore_pending, restore_marked_at, restore_cleared_at FROM risk_operational_state')).rows[0];
  const audit = (type: string, extra = 'TRUE', params: unknown[] = []) => count(db.pool, 'risk_audit_events', `event_type = '${type}' AND ${extra}`, params);
  const metricLines = (out: string) => out.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as Record<string, unknown>).filter((o) => o['event'] === 'metric.reservation_op');

  describe('mark-restore-pending', () => {
    it('marca, audita RESTORE_PENDING_MARKED, grava marcador e histórico; exit 0', async () => {
      const histBefore = await count(db.pool, 'risk_operational_state_history');
      const auditBefore = await audit('RESTORE_PENDING_MARKED');
      const r = await run(['mark-restore-pending'], migEnv());
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('restore_pending marcado: o serviço fica not-ready até reconcile-after-restore\n');
      expect(r.stderr).toBe('');
      expectClean(r, secretsOf(db.url));
      const st = await state();
      expect(st?.restore_pending).toBe(true);
      expect(st?.restore_marked_at).toBeInstanceOf(Date);
      expect(await audit('RESTORE_PENDING_MARKED')).toBe(auditBefore + 1);
      expect(await count(db.pool, 'risk_operational_state_history')).toBe(histBefore + 1);
    });

    it('idempotente: segunda execução preserva o marcador original, não audita nem registra histórico', async () => {
      expect((await run(['mark-restore-pending'], migEnv())).code).toBe(0);
      const first = await state();
      const histBefore = await count(db.pool, 'risk_operational_state_history');
      const auditBefore = await audit('RESTORE_PENDING_MARKED');
      await new Promise((r) => setTimeout(r, 50));
      const second = await run(['mark-restore-pending'], migEnv());
      expect(second.code).toBe(0);
      expect(second.stdout).toBe('restore_pending já estava marcado\n');
      expect(await state()).toEqual(first);
      expect(await audit('RESTORE_PENDING_MARKED')).toBe(auditBefore);
      expect(await count(db.pool, 'risk_operational_state_history')).toBe(histBefore);
    });

    it('não toca em reservas ACTIVE (só marca)', async () => {
      const a = await authorize();
      expect((await run(['mark-restore-pending'], migEnv())).code).toBe(0);
      expect(await status(a.reservationId)).toBe('ACTIVE');
    });

    it('credencial de runtime no lugar da de migração → exit 1, nada marcado, mensagem fixa', async () => {
      const r = await run(['mark-restore-pending'], base({ RISK_MIGRATION_DATABASE_URL: rt.url }));
      expect(r.code).toBe(1);
      expect(r.stderr).toBe('marcação falhou; nada foi confirmado\n');
      expectClean(r, secretsOf(rt.url));
      expect((await state())?.restore_pending).toBe(false);
    });

    it('sem credencial de migração (só a de runtime) → exit 2; ambiente não PAPER → exit 2; nada marcado', async () => {
      expect((await run(['mark-restore-pending'], base({ RISK_DATABASE_URL: rt.url }))).code).toBe(2);
      expect((await run(['mark-restore-pending'], migEnv({ RISK_ENVIRONMENT: 'LIVE' }))).code).toBe(2);
      expect((await state())?.restore_pending).toBe(false);
    });

    it('banco inalcançável → exit 1 com mensagem fixa e sem o endereço', async () => {
      const dead = new URL(db.url);
      dead.port = '1';
      const r = await run(['mark-restore-pending'], base({ RISK_MIGRATION_DATABASE_URL: dead.toString() }));
      expect(r.code).toBe(1);
      expect(r.stderr).toBe('marcação falhou; nada foi confirmado\n');
      expectClean(r, secretsOf(db.url));
    });
  });

  describe('reconcile-after-restore', () => {
    it('ACTIVE → EXPIRED com auditoria (trigger) e RESTORE_RECONCILED; CONSUMED/RELEASED intactas; limpa a pendência', async () => {
      const h = harness(rt.pool);
      const active = [await authorize(h), await authorize(h), await authorize(h)];
      const consumedRes = await authorize(h);
      const releasedRes = await authorize(h);
      const c = await h.consume.execute({ principal: executorPrincipal(), decisionId: consumedRes.decisionId, accountId: consumedRes.accountId, paperOrderId: `order-${randomUUID()}`, proposalHash: consumedRes.proposalHash });
      expect(c.kind).toBe('CONSUMED');
      expect((await h.release.execute({ principal: executorPrincipal(), reservationId: releasedRes.reservationId, reason: 'fixture' })).kind).toBe('RELEASED');
      const decisionsBefore = await count(db.pool, 'risk_decisions');
      expect((await run(['mark-restore-pending'], migEnv())).code).toBe(0);

      const r = await run(['reconcile-after-restore'], migEnv());
      expect(r.code).toBe(0);
      expect(r.stderr).toBe('');
      expect(r.stdout).toContain('reconciliação concluída; reservas expiradas: 3\n');
      expectClean(r, secretsOf(db.url));
      for (const a of active) {
        expect(await status(a.reservationId)).toBe('EXPIRED');
        expect(await audit('RESERVATION_EXPIRED', `reservation_id = $1 AND details_json->>'trigger' = 'post-restore-reconciliation'`, [a.reservationId])).toBe(1);
      }
      expect(await status(consumedRes.reservationId)).toBe('CONSUMED');
      expect(await status(releasedRes.reservationId)).toBe('RELEASED');
      const closed = await db.pool.query<{ closed_at: Date | null }>(`SELECT closed_at FROM risk_reservations WHERE reservation_id = ANY($1)`, [active.map((a) => a.reservationId)]);
      for (const row of closed.rows) expect(row.closed_at).toBeInstanceOf(Date);
      const rec = await db.pool.query<{ details_json: Record<string, unknown>; account_id: string | null }>(`SELECT details_json, account_id FROM risk_audit_events WHERE event_type = 'RESTORE_RECONCILED' ORDER BY created_at DESC LIMIT 1`);
      expect(rec.rows[0]?.details_json).toEqual({ trigger: 'post-restore-reconciliation', expiredReservations: 3 });
      const st = await state();
      expect(st?.restore_pending).toBe(false);
      expect(st?.restore_cleared_at).toBeInstanceOf(Date);
      expect(await count(db.pool, 'risk_decisions')).toBe(decisionsBefore); // decisões imutáveis
      // Métrica EXPIRE/OK uma vez por reserva, só depois do COMMIT.
      const metrics = metricLines(r.stdout);
      expect(metrics).toHaveLength(3);
      for (const m of metrics) expect(m).toMatchObject({ op: 'EXPIRE', outcome: 'OK', count: 1 });
    });

    it('idempotência: segunda execução não toca em nada (reserva nova ACTIVE segue ACTIVE; sem nova auditoria)', async () => {
      await authorize();
      expect((await run(['mark-restore-pending'], migEnv())).code).toBe(0);
      expect((await run(['reconcile-after-restore'], migEnv())).code).toBe(0);
      const fresh = await authorize(); // criada depois da reconciliação: legítima
      const auditTotal = await count(db.pool, 'risk_audit_events');
      const histTotal = await count(db.pool, 'risk_operational_state_history');
      const second = await run(['reconcile-after-restore'], migEnv());
      expect(second.code).toBe(0);
      expect(second.stdout).toBe('nada a reconciliar (restore_pending já é false)\n');
      expect(metricLines(second.stdout)).toHaveLength(0);
      expect(await status(fresh.reservationId)).toBe('ACTIVE');
      expect(await count(db.pool, 'risk_audit_events')).toBe(auditTotal);
      expect(await count(db.pool, 'risk_operational_state_history')).toBe(histTotal);
    });

    it('sem pendência: exit 0 "nada a reconciliar" e as ACTIVE continuam ACTIVE', async () => {
      const a = await authorize();
      const reconciledBefore = await audit('RESTORE_RECONCILED');
      const r = await run(['reconcile-after-restore'], migEnv());
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('nada a reconciliar (restore_pending já é false)\n');
      expect(await status(a.reservationId)).toBe('ACTIVE');
      expect(await audit('RESTORE_RECONCILED')).toBe(reconciledBefore);
    });

    it('pendência sem nenhuma ACTIVE: reconcilia com 0 expiradas e limpa a flag', async () => {
      expect((await run(['mark-restore-pending'], migEnv())).code).toBe(0);
      const r = await run(['reconcile-after-restore'], migEnv());
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('reconciliação concluída; reservas expiradas: 0\n');
      expect((await state())?.restore_pending).toBe(false);
    });

    it('credencial de RUNTIME → exit 1, nada muda (flag e reservas), métrica EXPIRE/UNAVAILABLE, mensagem fixa', async () => {
      const a = await authorize();
      expect((await run(['mark-restore-pending'], migEnv())).code).toBe(0);
      const reconciledBefore = await audit('RESTORE_RECONCILED');
      const r = await run(['reconcile-after-restore'], base({ RISK_MIGRATION_DATABASE_URL: rt.url }));
      expect(r.code).toBe(1);
      expect(r.stderr).toBe('reconciliação falhou; nada foi confirmado\n');
      expectClean(r, secretsOf(rt.url));
      expect(metricLines(r.stdout).map((m) => [m['op'], m['outcome']])).toEqual([['EXPIRE', 'UNAVAILABLE']]);
      expect(await status(a.reservationId)).toBe('ACTIVE');
      expect((await state())?.restore_pending).toBe(true);
      expect(await audit('RESTORE_RECONCILED')).toBe(reconciledBefore);
    });

    it('sem credencial de migração, ambiente não PAPER ou ambas as formas → exit 2 e nada muda', async () => {
      const a = await authorize();
      expect((await run(['mark-restore-pending'], migEnv())).code).toBe(0);
      expect((await run(['reconcile-after-restore'], base({ RISK_DATABASE_URL: rt.url }))).code).toBe(2);
      expect((await run(['reconcile-after-restore'], base())).code).toBe(2);
      expect((await run(['reconcile-after-restore'], migEnv({ RISK_ENVIRONMENT: 'LIVE' }))).code).toBe(2);
      expect((await run(['reconcile-after-restore'], migEnv({ RISK_MIGRATION_DATABASE_URL_FILE: '/nao/existe' }))).code).toBe(2);
      expect(await status(a.reservationId)).toBe('ACTIVE');
      expect((await state())?.restore_pending).toBe(true);
    });

    it('banco inalcançável → exit 1 com mensagem fixa; nada muda', async () => {
      const dead = new URL(db.url);
      dead.port = '1';
      const r = await run(['reconcile-after-restore'], base({ RISK_MIGRATION_DATABASE_URL: dead.toString() }));
      expect(r.code).toBe(1);
      expect(r.stderr).toBe('reconciliação falhou; nada foi confirmado\n');
      expectClean(r, secretsOf(db.url));
    });

    it('atomicidade: falha no meio (auditoria impedida) → rollback total: reservas seguem ACTIVE e a flag segue ligada', async () => {
      const a = await authorize();
      expect((await run(['mark-restore-pending'], migEnv())).code).toBe(0);
      const reconciledBefore = await audit('RESTORE_RECONCILED');
      // Sabotagem só no banco de teste: o INSERT em risk_audit_events passa a falhar.
      await db.pool.query(`CREATE FUNCTION risk_test_block_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'sabotagem de teste'; END $$`);
      await db.pool.query(`CREATE TRIGGER risk_test_block_audit BEFORE INSERT ON risk_audit_events FOR EACH ROW WHEN (NEW.event_type = 'RESERVATION_EXPIRED') EXECUTE FUNCTION risk_test_block_audit()`);
      try {
        const r = await run(['reconcile-after-restore'], migEnv());
        expect(r.code).toBe(1);
        expect(r.stderr).toBe('reconciliação falhou; nada foi confirmado\n');
        expect(r.stderr).not.toContain('sabotagem');
        expect(await status(a.reservationId)).toBe('ACTIVE');
        expect((await state())?.restore_pending).toBe(true);
        expect(await audit('RESTORE_RECONCILED')).toBe(reconciledBefore);
      } finally {
        await db.pool.query('DROP TRIGGER risk_test_block_audit ON risk_audit_events');
        await db.pool.query('DROP FUNCTION risk_test_block_audit()');
      }
      expect((await run(['reconcile-after-restore'], migEnv())).code).toBe(0);
      expect(await status(a.reservationId)).toBe('EXPIRED');
    });

    it('com a flag ligada, evaluate/consume/release (runtime) → UNAVAILABLE e expire-reservations (CLI) → exit 1; depois de reconciliar, voltam', async () => {
      const h = harness(rt.pool);
      const a = await authorize(h);
      const overdue = await authorize(harness(rt.pool), Date.parse('2026-11-13T22:00:00.000Z')); // já vencida: a varredura precisaria travar a conta
      expect((await run(['mark-restore-pending'], migEnv())).code).toBe(0);
      expect(await h.evaluate.execute({ proposal: uniqueProposal(), authenticatedAgentId: AGENT })).toEqual({ kind: 'UNAVAILABLE' });
      expect(await h.consume.execute({ principal: executorPrincipal(), decisionId: a.decisionId, accountId: a.accountId, paperOrderId: 'order-x', proposalHash: a.proposalHash })).toEqual({ kind: 'UNAVAILABLE' });
      expect(await h.release.execute({ principal: executorPrincipal(), reservationId: a.reservationId, reason: 'x' })).toEqual({ kind: 'UNAVAILABLE' });
      const sweep = await run(['expire-reservations'], base({ RISK_DATABASE_URL: rt.url }));
      expect(sweep.code).toBe(1);
      expect(sweep.stderr).toBe('varredura de reservas falhou; nenhuma expiração foi confirmada\n');
      expect(await status(a.reservationId)).toBe('ACTIVE');
      expect(await status(overdue.reservationId)).toBe('ACTIVE');
      expect((await run(['reconcile-after-restore'], migEnv())).code).toBe(0);
      // A autorização anterior ao ponto de restauração está EXPIRED: consume não a aceita.
      const afterConsume = await h.consume.execute({ principal: executorPrincipal(), decisionId: a.decisionId, accountId: a.accountId, paperOrderId: 'order-y', proposalHash: a.proposalHash });
      expect(afterConsume).toEqual({ kind: 'NOT_AUTHORIZED', reason: 'EXPIRED' });
      const fresh = await h.evaluate.execute({ proposal: uniqueProposal(), authenticatedAgentId: AGENT });
      expect(fresh.kind).toBe('DECISION');
    });

    it('expire-reservations com a flag ligada e SEM nenhuma reserva vencida → exit 1 (nunca exit 0 mascarando o estado); sem a flag, exit 0', async () => {
      const a = await authorize(); // vigente: nada a expirar
      expect((await run(['expire-reservations'], base({ RISK_DATABASE_URL: rt.url }))).code).toBe(0);
      expect((await run(['mark-restore-pending'], migEnv())).code).toBe(0);
      const auditBefore = await audit('RESERVATION_EXPIRED');
      const sweep = await run(['expire-reservations'], base({ RISK_DATABASE_URL: rt.url }));
      expect(sweep.code).toBe(1);
      expect(sweep.stdout).toBe('');
      expect(sweep.stderr).toBe('varredura de reservas falhou; nenhuma expiração foi confirmada\n');
      expectClean(sweep, secretsOf(rt.url));
      expect(await status(a.reservationId)).toBe('ACTIVE');
      expect(await audit('RESERVATION_EXPIRED')).toBe(auditBefore);
    });

    it('concorrência com evaluate (lock por conta): nenhuma autorização durante a pendência; as anteriores expiram, as novas só valem depois', async () => {
      for (let round = 0; round < 4; round++) {
        const h = harness(rt.pool);
        const pre = [await authorize(h), await authorize(h)];
        expect((await run(['mark-restore-pending'], migEnv())).code, `round ${round}`).toBe(0);
        // Segura o lock da conta: reconcile e evaluates enfileiram; ao soltar, a ordem de entrada é livre.
        const holder = await db.pool.connect();
        await holder.query('BEGIN');
        await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['paper-fixture']);
        const reconcile = run(['reconcile-after-restore'], migEnv());
        const evals = Array.from({ length: 6 }, () => h.evaluate.execute({ proposal: uniqueProposal(), authenticatedAgentId: AGENT }));
        await new Promise((r) => setTimeout(r, 800 + round * 150));
        await holder.query('ROLLBACK');
        holder.release();
        const [rec, results] = [await reconcile, await Promise.all(evals)];
        expect(rec.code, `round ${round}: ${rec.stderr}`).toBe(0);
        expect(rec.stdout).toContain('reservas expiradas: 2\n');
        for (const p of pre) expect(await status(p.reservationId), `round ${round}`).toBe('EXPIRED');
        expect((await state())?.restore_pending).toBe(false);
        for (const res of results) {
          expect(['DECISION', 'UNAVAILABLE'], `round ${round}`).toContain(res.kind);
          if (res.kind === 'DECISION' && res.decision.status === 'ALLOW_PAPER') {
            // Uma autorização só é legítima se saiu DEPOIS da reconciliação: nunca foi expirada por ela.
            const id = res.decision.reservationId ?? '';
            expect(await audit('RESERVATION_EXPIRED', `reservation_id = $1 AND details_json->>'trigger' = 'post-restore-reconciliation'`, [id]), `round ${round}`).toBe(0);
            expect(await status(id)).toBe('ACTIVE');
          } else if (res.kind === 'DECISION') {
            expect(res.decision.reservationId ?? null).toBeNull();
          }
        }
        await db.pool.query(`UPDATE risk_reservations SET status = 'RELEASED', closed_at = now() WHERE status = 'ACTIVE'`);
        await db.pool.query('UPDATE risk_operational_state SET restore_pending = FALSE WHERE singleton');
      }
    });

    it('duas reconciliações simultâneas: uma faz o trabalho, a outra encontra a flag limpa; contagem total correta', async () => {
      const h = harness(rt.pool);
      await Promise.all([authorize(h), authorize(h), authorize(h)]);
      expect((await run(['mark-restore-pending'], migEnv())).code).toBe(0);
      const expiredBefore = await audit('RESERVATION_EXPIRED', `details_json->>'trigger' = 'post-restore-reconciliation'`);
      const reconciledBefore = await audit('RESTORE_RECONCILED');
      const [a, b] = await Promise.all([run(['reconcile-after-restore'], migEnv()), run(['reconcile-after-restore'], migEnv())]);
      expect([a.code, b.code]).toEqual([0, 0]);
      const outs = [a.stdout, b.stdout].sort();
      expect(outs.some((o) => o.includes('reservas expiradas: 3\n'))).toBe(true);
      expect(outs.some((o) => o.includes('nada a reconciliar'))).toBe(true);
      expect(await audit('RESERVATION_EXPIRED', `details_json->>'trigger' = 'post-restore-reconciliation'`)).toBe(expiredBefore + 3);
      expect(await audit('RESTORE_RECONCILED')).toBe(reconciledBefore + 1);
    });
  });
});

describe('verify-runtime-privileges', () => {
  let db: IsolatedDatabase;
  let rt: RuntimeLogin;
  beforeAll(async () => {
    db = await createIsolatedDatabase();
    rt = await createRuntimeLogin(db);
  });
  afterAll(async () => {
    await rt.drop();
    await db.drop();
  });
  const env = (url: string) => base({ RISK_DATABASE_URL: url });

  it('login de runtime correto → exit 0', async () => {
    const r = await run(['verify-runtime-privileges'], env(rt.url));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('privilégios de runtime no mínimo\n');
    expect(r.stderr).toBe('');
    expectClean(r, secretsOf(rt.url));
  });

  it('superuser → exit 1 com código de categoria, sem stack nem credenciais', async () => {
    const r = await run(['verify-runtime-privileges'], env(db.url));
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/^privilégios de runtime acima do mínimo ou não verificáveis: .*SUPERUSER.*\n$/);
    expectClean(r, secretsOf(db.url));
  });

  it('login com DELETE a mais → exit 1 EXCESS_TABLE_PRIVILEGE sem nomes de tabela/role', async () => {
    const l = await createTestLogin(db);
    try {
      await db.pool.query(`GRANT DELETE ON risk_outbox TO ${l.role}`);
      const r = await run(['verify-runtime-privileges'], env(l.url));
      expect(r.code).toBe(1);
      expect(r.stderr).toBe('privilégios de runtime acima do mínimo ou não verificáveis: EXCESS_TABLE_PRIVILEGE\n');
      expect(r.stderr).not.toMatch(/risk_outbox/);
      expectClean(r, [...secretsOf(l.url), l.role]);
    } finally {
      await l.drop();
    }
  });

  it('banco inalcançável → exit 1 INSPECTION_FAILED (fail-closed, não 0)', async () => {
    const dead = new URL(rt.url);
    dead.port = '1';
    const r = await run(['verify-runtime-privileges'], env(dead.toString()));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('INSPECTION_FAILED');
    expectClean(r, secretsOf(rt.url));
  });

  it('sem credencial → exit 2', async () => {
    const r = await run(['verify-runtime-privileges'], base());
    expect(r.code).toBe(2);
    expectClean(r);
  });
});

describe('healthcheck', () => {
  const DUMMY_DB = 'postgres://nunca-usado:nunca-usada-zz9@127.0.0.1:1/openclaw_risk_zz9_test';
  const hc = (port: number, extra: Record<string, string> = {}) =>
    runtimeEnv({ RISK_DATABASE_URL: DUMMY_DB, RISK_HTTP_PORT: String(port), RISK_PRINCIPALS_FILE: '/fixture/principals.json', RISK_HTTP_REQUEST_TIMEOUT_MS: '1500', RISK_HTTP_HEADERS_TIMEOUT_MS: '1000', ...extra });
  const stub: Server[] = [];
  afterAll(async () => {
    await Promise.all(stub.map((s) => new Promise<void>((resolve) => { s.closeAllConnections(); s.close(() => { resolve(); }); })));
  });
  async function stubServer(handler: Parameters<typeof createServer>[1]): Promise<number> {
    const s = createServer(handler);
    stub.push(s);
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
    return (s.address() as AddressInfo).port;
  }

  it('servidor vivo → exit 0 "live", sem tocar no banco', async () => {
    const srv = await startServer();
    try {
      const r = await run(['healthcheck'], hc(srv.port));
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('live\n');
      expectClean(r, ['zz9']);
    } finally {
      await srv.close();
    }
  });

  it('sem servidor (porta fechada) → exit 1, mensagem fixa', async () => {
    const r = await run(['healthcheck'], hc(await freePort()));
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('healthcheck: serviço indisponível\n');
    expectClean(r, ['zz9']);
  });

  it('servidor respondendo 503 → exit 1; qualquer status diferente de 200 → 1', async () => {
    for (const status of [503, 500, 404, 204, 301]) {
      const port = await stubServer((_req, res) => {
        res.writeHead(status);
        res.end();
      });
      const r = await run(['healthcheck'], hc(port));
      expect(r.code, String(status)).toBe(1);
      expect(r.stderr).toBe('healthcheck: resposta diferente de 200\n');
    }
  });

  it('servidor que nunca responde → exit 1 dentro do timeout configurado (não pendura)', async () => {
    const port = await stubServer(() => undefined);
    const started = Date.now();
    const r = await run(['healthcheck'], hc(port), 15_000);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe('healthcheck: serviço indisponível\n');
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('bate em /health/live, em 127.0.0.1, uma única vez e sem credenciais', async () => {
    const seen: { url?: string; auth?: string | undefined; host?: string | undefined }[] = [];
    const port = await stubServer((req, res) => {
      seen.push({ url: req.url, auth: req.headers.authorization, host: req.socket.remoteAddress });
      res.writeHead(200);
      res.end('{}');
    });
    const r = await run(['healthcheck'], hc(port));
    expect(r.code).toBe(0);
    expect(seen).toEqual([{ url: '/health/live', auth: undefined, host: '127.0.0.1' }]);
  });

  it('HTTP desabilitado → exit 2; configuração inválida → exit 2', async () => {
    const off = await run(['healthcheck'], base({ RISK_DATABASE_URL: DUMMY_DB }));
    expect(off.code).toBe(2);
    expect(off.stderr).toBe('RISK_HTTP_ENABLED não é true\n');
    const badHost = await run(['healthcheck'], hc(8080, { RISK_HTTP_HOST: '0.0.0.0' }));
    expect(badHost.code).toBe(2);
    expectClean(badHost, ['zz9']);
  });
});

// ADR-0011: o healthcheck sonda o host certo conforme o escopo de bind (fixtures fictícias; servidores de teste só em loopback).
describe('healthcheck e RISK_HTTP_BIND_SCOPE', () => {
  const DUMMY_DB = 'postgres://nunca-usado:nunca-usada-zz9@127.0.0.1:1/openclaw_risk_zz9_test';
  const OVERLAY = 'plaintext-encrypted-overlay';
  const hc = (port: number, extra: Record<string, string>) =>
    runtimeEnv({ RISK_DATABASE_URL: DUMMY_DB, RISK_HTTP_PORT: String(port), RISK_PRINCIPALS_FILE: '/fixture/principals.json', RISK_HTTP_REQUEST_TIMEOUT_MS: '1500', RISK_HTTP_HEADERS_TIMEOUT_MS: '1000', ...extra });
  const servers: Server[] = [];
  afterAll(async () => {
    await Promise.all(servers.map((s) => new Promise<void>((resolve) => { s.closeAllConnections(); s.close(() => { resolve(); }); })));
  });
  async function listenOn(host: string): Promise<{ port: number; seen: string[] }> {
    const seen: string[] = [];
    const s = createServer((req, res) => {
      seen.push(`${req.url ?? ''}|${req.headers.authorization ?? ''}`);
      res.writeHead(200);
      res.end('{}');
    });
    servers.push(s);
    await new Promise<void>((resolve, reject) => {
      s.once('error', reject);
      s.listen(0, host, resolve);
    });
    return { port: (s.address() as AddressInfo).port, seen };
  }
  async function ipv6Available(): Promise<boolean> {
    try {
      const s = createServer();
      await new Promise<void>((resolve, reject) => {
        s.once('error', reject);
        s.listen(0, '::1', resolve);
      });
      await new Promise<void>((resolve) => { s.close(() => { resolve(); }); });
      return true;
    } catch {
      return false;
    }
  }

  it('private-network + transporte + 0.0.0.0 com servidor em 127.0.0.1 → exit 0 (curinga configurado não impede a sonda; host sondado é garantido pelo unit de healthProbeHost)', async () => {
    const { port, seen } = await listenOn('127.0.0.1');
    const r = await run(['healthcheck'], hc(port, { RISK_HTTP_BIND_SCOPE: 'private-network', RISK_HTTP_TRANSPORT: OVERLAY, RISK_HTTP_HOST: '0.0.0.0' }));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('live\n');
    expect(seen).toEqual(['/health/live|']);
    expectClean(r, ['zz9']);
  });

  it('loopback + ::1 com servidor em ::1 → exit 0 (skip documentado se o ambiente não tem IPv6 em loopback)', async (ctx) => {
    if (!(await ipv6Available())) {
      ctx.skip();
      return;
    }
    const { port, seen } = await listenOn('::1');
    const r = await run(['healthcheck'], hc(port, { RISK_HTTP_BIND_SCOPE: 'loopback', RISK_HTTP_HOST: '::1' }));
    expect(r.code).toBe(0);
    expect(seen).toEqual(['/health/live|']);
    expectClean(r, ['zz9']);
  });

  it('loopback + 127.5.5.5 (escopo omitido) sonda o host configurado, não 127.0.0.1', async (ctx) => {
    let srv: { port: number; seen: string[] };
    try {
      srv = await listenOn('127.5.5.5');
    } catch {
      ctx.skip();
      return;
    }
    const r = await run(['healthcheck'], hc(srv.port, { RISK_HTTP_HOST: '127.5.5.5' }));
    expect(r.code).toBe(0);
    expect(srv.seen).toEqual(['/health/live|']);
  });

  it('private-network sem transporte → exit 2 sem sondar o servidor, mensagem fixa', async () => {
    const { port, seen } = await listenOn('127.0.0.1');
    const r = await run(['healthcheck'], hc(port, { RISK_HTTP_BIND_SCOPE: 'private-network', RISK_HTTP_HOST: '0.0.0.0' }));
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('RISK_HTTP_TRANSPORT');
    expect(seen).toEqual([]);
    expectClean(r, ['zz9']);
  });

  it('combinações inválidas (private-network com 127.0.0.1; transporte em loopback; escopo inválido) → exit 2 sem sondar', async () => {
    const { port, seen } = await listenOn('127.0.0.1');
    const cases: Record<string, string>[] = [
      { RISK_HTTP_BIND_SCOPE: 'private-network', RISK_HTTP_TRANSPORT: OVERLAY, RISK_HTTP_HOST: '127.0.0.1' },
      { RISK_HTTP_BIND_SCOPE: 'loopback', RISK_HTTP_TRANSPORT: OVERLAY },
      { RISK_HTTP_BIND_SCOPE: 'Private-Network', RISK_HTTP_TRANSPORT: OVERLAY, RISK_HTTP_HOST: '0.0.0.0' },
    ];
    for (const extra of cases) {
      const r = await run(['healthcheck'], hc(port, extra));
      expect(r.code, JSON.stringify(extra)).toBe(2);
      expect(r.stdout).toBe('');
      expectClean(r, ['zz9']);
    }
    expect(seen).toEqual([]);
  });
});

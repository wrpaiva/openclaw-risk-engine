import type { Pool } from 'pg';
import type { Logger } from '../../application/ports/Logger.js';
import type { CheckStatus, ReadinessProbe, ReadinessReport } from '../../application/ports/ReadinessProbe.js';
import { ClientLease, deriveDeadlines, raceDeadline } from './clientLease.js';
import type { AppliedMigration } from './migrate.js';
import type { PrivilegeInspector } from './PgPrivilegeInspector.js';

export interface PgReadinessProbeDeps {
  readonly pool: Pool;
  /** Migrações da imagem (`readBundledMigrations`); falha de leitura = schema FAIL. */
  readonly bundledMigrations: () => Promise<readonly AppliedMigration[]>;
  readonly privileges: PrivilegeInspector;
  /** Timeout de statement já obrigatório na configuração (RISK_DB_STATEMENT_TIMEOUT_MS). */
  readonly statementTimeoutMs: number;
  /** RISK_DB_CONNECTION_TIMEOUT_MS; se ausente, o do pool (ver `deriveDeadlines`). */
  readonly connectionTimeoutMs?: number;
  readonly logger?: Logger;
}

/**
 * Prontidão: banco responde, schema compatível com a imagem, privilégios mínimos e sem reconciliação pendente.
 * Cada verificação tem prazo total de RISK_DB_CONNECTION_TIMEOUT_MS + RISK_DB_STATEMENT_TIMEOUT_MS (conexão +
 * comandos); estourado, o cliente é destruído e a verificação vira FAIL (banco congelado nunca pendura o /health/ready).
 * Migração aplicada que a imagem não conhece é aceita (rollback para a imagem N-1).
 * `check()` nunca lança nem expõe mensagens de erro.
 */
export class PgReadinessProbe implements ReadinessProbe {
  /** Verificação em voo compartilhada por chamadas concorrentes (single-flight; sem cache nem TTL). */
  private inFlight: Promise<ReadinessReport> | null = null;

  constructor(private readonly deps: PgReadinessProbeDeps) {}

  check(): Promise<ReadinessReport> {
    if (this.inFlight !== null) return this.inFlight;
    const flight = this.run();
    this.inFlight = flight;
    void flight.finally(() => {
      if (this.inFlight === flight) this.inFlight = null;
    });
    return flight;
  }

  private async run(): Promise<ReadinessReport> {
    const [database, schema, privileges, reconciliation] = await Promise.all([
      this.safe(() => this.database()),
      this.safe(() => this.schema()),
      this.safe(() => this.privilegeCheck()),
      this.safe(() => this.reconciliation()),
    ]);
    return { database, schema, privileges, reconciliation };
  }

  private async safe(fn: () => Promise<boolean>): Promise<CheckStatus> {
    try {
      return (await fn()) ? 'OK' : 'FAIL';
    } catch {
      return 'FAIL';
    }
  }

  private async withClient<T>(work: (query: (sql: string) => Promise<readonly Record<string, unknown>[]>) => Promise<T>): Promise<T> {
    const deadlines = deriveDeadlines(this.deps.pool, this.deps.statementTimeoutMs, this.deps.connectionTimeoutMs);
    let lease: ClientLease | undefined;
    const run = async (): Promise<T> => {
      lease = await ClientLease.acquire(this.deps.pool, deadlines, this.deps.logger);
      const current = lease;
      try {
        await current.query('BEGIN READ ONLY');
        await current.query("SELECT set_config('statement_timeout', $1, true)", [String(this.deps.statementTimeoutMs)]);
        const result = await work(async (sql) => (await current.query(sql)).rows);
        await current.query('ROLLBACK');
        return result;
      } catch (error) {
        // Conexão em estado incerto (inclusive prazo estourado): sem ROLLBACK, destruir.
        current.markBroken();
        throw error;
      } finally {
        current.finish();
      }
    };
    // Prazo total: conexão + comandos. A conexão congelada é destruída; o resultado é FAIL.
    return raceDeadline(run(), deadlines.queryMs, () => lease?.destroy());
  }

  private database(): Promise<boolean> {
    return this.withClient(async (query) => (await query('SELECT 1 AS ok')).length === 1);
  }

  private schema(): Promise<boolean> {
    return this.withClient(async (query) => {
      const bundled = await this.deps.bundledMigrations();
      const rows = await query('SELECT version, checksum FROM schema_migrations');
      const applied = new Map(rows.map((r) => [String(r['version']), String(r['checksum'])]));
      if (bundled.length === 0) return false;
      return bundled.every((m) => applied.get(m.version) === m.checksum);
    });
  }

  /** FAIL se a reconciliação pós-restauração está pendente, a linha de estado não existe ou a leitura falha. */
  private reconciliation(): Promise<boolean> {
    return this.withClient(async (query) => {
      const rows = await query('SELECT restore_pending FROM risk_operational_state');
      return rows.length === 1 && rows[0]?.['restore_pending'] === false;
    });
  }

  private async privilegeCheck(): Promise<boolean> {
    return (await this.deps.privileges.inspect()).ok;
  }
}

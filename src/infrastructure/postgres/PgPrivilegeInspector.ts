import type { Pool } from 'pg';
import type { Logger } from '../../application/ports/Logger.js';
import { ClientLease, deriveDeadlines, raceDeadline } from './clientLease.js';

/** Códigos fixos: nunca carregam nomes de tabelas, roles ou mensagens do banco. */
export type PrivilegeViolation =
  | 'SUPERUSER'
  | 'BYPASSRLS'
  | 'CREATEROLE'
  | 'CREATEDB'
  | 'REPLICATION'
  | 'OWNS_RELATION'
  | 'CREATE_ON_PUBLIC'
  | 'CREATE_ON_DATABASE'
  | 'TEMP_ON_DATABASE'
  | 'OWNS_OR_CREATES_IN_SCHEMA'
  | 'MEMBER_OF_OWNER'
  | 'EXCESS_TABLE_PRIVILEGE'
  | 'INSPECTION_FAILED';

export interface PrivilegeReport {
  readonly ok: boolean;
  readonly violations: readonly PrivilegeViolation[];
}

export interface PrivilegeInspector {
  /** Nunca lança: qualquer exceção vira `INSPECTION_FAILED` (fail-closed). */
  inspect(): Promise<PrivilegeReport>;
}

export const OWNER_ROLE = 'openclaw_risk_owner';

// Grants exatos das migrações 0003/0004 (única fonte do que o runtime pode ter além de SELECT).
// risk_operational_state (0004): o runtime só tem SELECT; qualquer INSERT/UPDATE/DELETE nela é EXCESS_TABLE_PRIVILEGE
// porque a tabela não consta em INSERT_TABLES nem em UPDATE_COLUMNS.
const INSERT_TABLES = ['trade_proposals', 'risk_decisions', 'risk_audit_events', 'risk_outbox', 'risk_reservations'] as const;
const UPDATE_COLUMNS = { table: 'risk_reservations', columns: ['status', 'closed_at', 'paper_order_id'] } as const;

const ROLE_SQL = `
  SELECT r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication,
         has_schema_privilege(current_user, 'public', 'CREATE') AS create_public,
         has_database_privilege(current_user, current_database(), 'CREATE') AS create_database,
         has_database_privilege(current_user, current_database(), 'TEMP') AS temp_database,
         COALESCE(has_any_column_privilege(current_user, to_regclass('public.risk_operational_state_history'), 'SELECT'), false) AS select_state_history,
         COALESCE(pg_has_role(current_user, (SELECT oid FROM pg_roles WHERE rolname = $1), 'MEMBER'), false) AS member_of_owner
    FROM pg_roles r WHERE r.rolname = current_user`;

const OWNS_SQL = `
  SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
     AND pg_has_role(current_user, c.relowner, 'MEMBER') LIMIT 1`;

// Sombreamento de schema: dono OU capacidade de CREATE em qualquer schema além dos de sistema (pg_catalog,
// information_schema; toast e temporários ficam de fora: o TEMP do banco é checado à parte). O CREATE em `public`
// já é CREATE_ON_PUBLIC (sem violação duplicada); a propriedade de `public` conta aqui.
const SCHEMAS_SQL = `
  SELECT 1 FROM pg_namespace n
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_(toast|temp_)'
     AND (pg_has_role(current_user, n.nspowner, 'MEMBER') OR (n.nspname <> 'public' AND has_schema_privilege(current_user, n.oid, 'CREATE')))
   LIMIT 1`;

// Privilégios de tabela (DELETE/TRUNCATE/TRIGGER) e de coluna (INSERT/UPDATE/REFERENCES; o de coluna inclui o de tabela).
const EXCESS_SQL = `
  SELECT 1
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
     AND (
       has_table_privilege(current_user, c.oid, 'DELETE')
       OR has_table_privilege(current_user, c.oid, 'TRUNCATE')
       OR has_table_privilege(current_user, c.oid, 'TRIGGER')
       OR EXISTS (
         SELECT 1 FROM pg_attribute a
          WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
            AND (
              has_column_privilege(current_user, c.oid, a.attnum, 'REFERENCES')
              OR (has_column_privilege(current_user, c.oid, a.attnum, 'INSERT') AND NOT (c.relname = ANY ($1::text[])))
              OR (has_column_privilege(current_user, c.oid, a.attnum, 'UPDATE')
                  AND NOT (c.relname = $2 AND a.attname = ANY ($3::text[])))
            )
       )
     )
   LIMIT 1`;

export interface PgPrivilegeInspectorOptions {
  /** Timeout de statement já obrigatório na configuração (RISK_DB_STATEMENT_TIMEOUT_MS). */
  readonly statementTimeoutMs: number;
  /** RISK_DB_CONNECTION_TIMEOUT_MS; se ausente, o do pool (ver `deriveDeadlines`). */
  readonly connectionTimeoutMs?: number;
  readonly logger?: Logger;
}

/**
 * Verifica, com o usuário conectado, que o runtime não tem poder além dos grants da 0003.
 * O histórico de reconciliação (risk_operational_state_history) é do operador: SELECT nele também reprova.
 * Superuser passa em todas as funções has_*_privilege: por isso os atributos da role são checados à parte.
 */
export class PgPrivilegeInspector implements PrivilegeInspector {
  constructor(
    private readonly pool: Pool,
    private readonly options: PgPrivilegeInspectorOptions,
  ) {}

  async inspect(): Promise<PrivilegeReport> {
    try {
      const violations = await this.collect();
      return { ok: violations.length === 0, violations };
    } catch {
      return { ok: false, violations: ['INSPECTION_FAILED'] };
    }
  }

  private async collect(): Promise<readonly PrivilegeViolation[]> {
    // Prazo total = conexão + statement (ver clientLease.ts): banco congelado => INSPECTION_FAILED, nunca pendura.
    const deadlines = deriveDeadlines(this.pool, this.options.statementTimeoutMs, this.options.connectionTimeoutMs);
    let lease: ClientLease | undefined;
    const run = async (): Promise<readonly PrivilegeViolation[]> => {
      lease = await ClientLease.acquire(this.pool, deadlines, this.options.logger);
      const current = lease;
      try {
        await current.query('BEGIN READ ONLY');
        await current.query("SELECT set_config('statement_timeout', $1, true)", [String(this.options.statementTimeoutMs)]);
        const role = await current.query<{
          rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolreplication: boolean;
          create_public: boolean; create_database: boolean; temp_database: boolean; select_state_history: boolean; member_of_owner: boolean;
        }>(ROLE_SQL, [OWNER_ROLE]);
        const r = role.rows[0];
        if (r === undefined) {
          await current.query('ROLLBACK');
          return ['INSPECTION_FAILED'] as const;
        }
        const found: PrivilegeViolation[] = [];
        if (r.rolsuper) found.push('SUPERUSER');
        if (r.rolbypassrls) found.push('BYPASSRLS');
        if (r.rolcreaterole) found.push('CREATEROLE');
        if (r.rolcreatedb) found.push('CREATEDB');
        if (r.rolreplication) found.push('REPLICATION');
        if (r.create_public) found.push('CREATE_ON_PUBLIC');
        if (r.create_database) found.push('CREATE_ON_DATABASE');
        if (r.temp_database) found.push('TEMP_ON_DATABASE');
        if (r.select_state_history) found.push('EXCESS_TABLE_PRIVILEGE');
        if (r.member_of_owner) found.push('MEMBER_OF_OWNER');
        if ((await current.query(OWNS_SQL)).rowCount) found.push('OWNS_RELATION');
        if ((await current.query(SCHEMAS_SQL)).rowCount) found.push('OWNS_OR_CREATES_IN_SCHEMA');
        const excess = await current.query(EXCESS_SQL, [[...INSERT_TABLES], UPDATE_COLUMNS.table, [...UPDATE_COLUMNS.columns]]);
        if (excess.rowCount) found.push('EXCESS_TABLE_PRIVILEGE');
        await current.query('ROLLBACK');
        return found;
      } catch (error) {
        current.markBroken();
        throw error;
      } finally {
        current.finish();
      }
    };
    return raceDeadline(run(), deadlines.queryMs, () => lease?.destroy());
  }
}

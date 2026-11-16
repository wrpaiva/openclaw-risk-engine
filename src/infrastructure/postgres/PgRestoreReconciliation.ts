import type { Pool } from 'pg';
import { ClientLease } from './clientLease.js';
import type { MigrateTimeouts } from './migrate.js';

// Máximo de setTimeout do Node: só para o caminho legado (testes), sem prazos.
const NO_DEADLINE_MS = 2_147_483_647;

export interface ReconciliationResult {
  /** false = nada pendente (execução idempotente: nenhuma reserva foi tocada). */
  readonly reconciled: boolean;
  readonly expiredReservations: number;
}

export interface MarkResult {
  /** false = já estava pendente (nada mudou). */
  readonly changed: boolean;
}

/**
 * Operações de OPERADOR sobre o estado de reconciliação pós-restauração. Exigem a credencial de MIGRAÇÃO
 * (dona das tabelas): o runtime só tem SELECT em `risk_operational_state` e nunca chega a este código.
 */
export class PgRestoreReconciliation {
  /**
   * `timeouts` (sempre na CLI): espera de conexão, prazo por comando do cliente (conexão + statement) e
   * statement_timeout/lock_timeout da transação (esperas de FOR UPDATE e dos advisory locks por conta).
   * Sem `timeouts`: legado, sem prazos (apenas testes).
   */
  constructor(
    private readonly pool: Pool,
    private readonly timeouts?: MigrateTimeouts,
  ) {}

  /**
   * Em uma única transação: se `restore_pending`, expira TODAS as reservas ACTIVE (auditoria RESERVATION_EXPIRED com
   * details.trigger='post-restore-reconciliation'), limpa `restore_pending` e registra RESTORE_RECONCILED.
   * Sem pendência: não toca em nada (reservas ACTIVE novas, criadas após a reconciliação, são legítimas).
   * Toma o lock por conta (mesma chave da aplicação) de todas as contas, em ordem, para esperar transações em voo.
   * Ordem dos locks: `ORDER BY account_id` usa a collation do banco, enquanto ExpireRiskReservations ordena em JS
   * (`sort()`, ordem de code units UTF-16). As ordens podem divergir para ids com maiúsculas/símbolos; isso NÃO
   * causa deadlock aqui porque o estado operacional é travado antes (FOR UPDATE) e a varredura falha em
   * `lockAccount` enquanto restore_pending=true; com a flag limpa esta rotina não toma locks de conta. Se algum
   * dia ambas passarem a competir pelos mesmos locks, use a mesma ordenação (ex.: COLLATE "C" e sort() em JS).
   */
  async reconcile(now: string): Promise<ReconciliationResult> {
    return this.inTransaction(async (q) => {
      const state = await q('SELECT restore_pending FROM risk_operational_state WHERE singleton FOR UPDATE');
      if (state.rows.length !== 1) throw new Error('estado operacional ausente');
      if (state.rows[0]?.['restore_pending'] !== true) return { reconciled: false, expiredReservations: 0 };

      const accounts = await q(
        `SELECT account_id FROM (
           SELECT account_id FROM risk_accounts
           UNION SELECT account_id FROM risk_reservations WHERE status = 'ACTIVE') a
         ORDER BY account_id`,
      );
      for (const row of accounts.rows) {
        await q('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [row['account_id']]);
      }
      // Uma só instrução: fecha as reservas e grava a auditoria correspondente (nunca uma sem a outra).
      const closed = await q(
        `WITH closed AS (
           UPDATE risk_reservations SET status = 'EXPIRED', closed_at = $1
            WHERE status = 'ACTIVE'
        RETURNING reservation_id, decision_id, account_id)
         INSERT INTO risk_audit_events
           (event_id, correlation_id, account_id, proposal_id, decision_id, reservation_id, event_type, details_json, created_at)
         SELECT gen_random_uuid(), NULL, account_id, NULL, decision_id, reservation_id, 'RESERVATION_EXPIRED',
                '{"trigger":"post-restore-reconciliation"}'::jsonb, $1
           FROM closed`,
        [now],
      );
      const expired = closed.rowCount ?? 0;
      await q(
        `UPDATE risk_operational_state SET restore_pending = FALSE, restore_cleared_at = $1, updated_at = $1 WHERE singleton`,
        [now],
      );
      await q(
        `INSERT INTO risk_audit_events (event_id, correlation_id, account_id, proposal_id, decision_id, reservation_id, event_type, details_json, created_at)
         VALUES (gen_random_uuid(), NULL, NULL, NULL, NULL, NULL, 'RESTORE_RECONCILED', $2::jsonb, $1)`,
        [now, JSON.stringify({ trigger: 'post-restore-reconciliation', expiredReservations: expired })],
      );
      return { reconciled: true, expiredReservations: expired };
    });
  }

  /** Marca a reconciliação como pendente (manual). Idempotente: se já pendente, preserva o marcador original. */
  async markPending(now: string): Promise<MarkResult> {
    return this.inTransaction(async (q) => {
      const state = await q('SELECT restore_pending FROM risk_operational_state WHERE singleton FOR UPDATE');
      if (state.rows.length !== 1) throw new Error('estado operacional ausente');
      if (state.rows[0]?.['restore_pending'] === true) return { changed: false };
      await q(`UPDATE risk_operational_state SET restore_pending = TRUE, restore_marked_at = $1, updated_at = $1 WHERE singleton`, [now]);
      await q(
        `INSERT INTO risk_audit_events (event_id, correlation_id, account_id, proposal_id, decision_id, reservation_id, event_type, details_json, created_at)
         VALUES (gen_random_uuid(), NULL, NULL, NULL, NULL, NULL, 'RESTORE_PENDING_MARKED', '{"trigger":"operator"}'::jsonb, $1)`,
        [now],
      );
      return { changed: true };
    });
  }

  private async inTransaction<T>(work: (q: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>) => Promise<T>): Promise<T> {
    const t = this.timeouts;
    const lease = await ClientLease.acquire(
      this.pool,
      t === undefined
        ? { connectMs: NO_DEADLINE_MS, queryMs: NO_DEADLINE_MS }
        : { connectMs: t.connectionTimeoutMs, queryMs: t.connectionTimeoutMs + t.statementTimeoutMs },
    );
    try {
      await lease.query('BEGIN');
      if (t !== undefined) {
        await lease.query("SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true)", [
          String(t.statementTimeoutMs),
          String(t.lockTimeoutMs),
        ]);
      }
      try {
        const result = await work((sql, values) => lease.query(sql, values));
        await lease.query('COMMIT');
        return result;
      } catch (error) {
        await lease.query('ROLLBACK').catch(() => {
          lease.markBroken();
        });
        throw error;
      }
    } catch (error) {
      lease.markBroken();
      throw error;
    } finally {
      lease.finish();
    }
  }
}

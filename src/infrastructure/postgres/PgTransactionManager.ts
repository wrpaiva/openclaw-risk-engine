import type { Pool } from 'pg';
import type { Logger } from '../../application/ports/Logger.js';
import type { RiskMetrics } from '../../application/ports/RiskMetrics.js';
import { safeMetrics } from '../../application/SafeMetrics.js';
import { ClientLease, deriveDeadlines, isClientDeadline, type DbDeadlines } from './clientLease.js';
import type { RiskUnitOfWork } from '../../application/ports/RiskUnitOfWork.js';
import type { TransactionManager } from '../../application/ports/TransactionManager.js';
import { PgRiskUnitOfWork } from './PgRiskUnitOfWork.js';

/**
 * READ COMMITTED + advisory lock por conta: após obter o lock, cada comando enxerga tudo
 * o que transações anteriores da mesma conta confirmaram (SPEC §7.2, ADR-0006).
 */
export interface TransactionTimeouts {
  readonly statementTimeoutMs: number;
  readonly lockTimeoutMs: number;
  /**
   * RISK_DB_CONNECTION_TIMEOUT_MS. Prazo do cliente por comando = connection + statement (ver clientLease.ts);
   * se ausente, usa o connectionTimeoutMillis do pool (ou o statement timeout, para nunca esperar sem limite).
   */
  readonly connectionTimeoutMs?: number;
}

export interface PgTransactionManagerOptions {
  readonly logger?: Logger;
  /** Emite dependencyFailure('DATABASE') quando connect/BEGIN/configuração/COMMIT falham ou a conexão cai. */
  readonly metrics?: RiskMetrics;
}

export class PgTransactionManager implements TransactionManager {
  private readonly metrics: RiskMetrics;
  private readonly deadlines: DbDeadlines;

  /** Timeouts obrigatórios (sem default): um gerenciador sem limites seria fail-open. */
  constructor(
    private readonly pool: Pool,
    private readonly timeouts: TransactionTimeouts,
    private readonly options: PgTransactionManagerOptions = {},
  ) {
    this.metrics = safeMetrics(options.metrics);
    this.deadlines = deriveDeadlines(pool, timeouts.statementTimeoutMs, timeouts.connectionTimeoutMs);
  }

  async run<T>(work: (uow: RiskUnitOfWork) => Promise<T>): Promise<T> {
    let lease: ClientLease;
    try {
      // Espera de conexão com prazo: banco congelado => erro => UNAVAILABLE, nunca pendura.
      lease = await ClientLease.acquire(this.pool, this.deadlines, this.options.logger);
    } catch (error) {
      this.metrics.dependencyFailure('DATABASE');
      throw error;
    }
    // Falha de infraestrutura do Postgres = fora do trabalho de domínio (BEGIN, set_config, COMMIT, conexão perdida).
    let inWork = false;
    let dbFailure = false;
    try {
      await lease.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      // lock_timeout também cobre a espera do advisory lock da conta; estouro => erro => rollback => UNAVAILABLE.
      await lease.query("SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true)", [
        String(this.timeouts.statementTimeoutMs),
        String(this.timeouts.lockTimeoutMs),
      ]);
      let result: T;
      inWork = true;
      try {
        result = await work(new PgRiskUnitOfWork(lease.client, this.deadlines.queryMs));
      } catch (error) {
        // Prazo do cliente estourado: o comando segue pendente no servidor; ROLLBACK ficaria na fila atrás dele.
        // A conexão é destruída (o servidor aborta a transação ao perdê-la).
        if (isClientDeadline(error)) lease.markDeadline();
        else {
          await lease.query('ROLLBACK').catch(() => {
            lease.markBroken();
          });
        }
        throw error;
      }
      inWork = false;
      // Se o COMMIT falhar, a exceção sobe e o resultado (inclusive ALLOW_PAPER) nunca é devolvido.
      await lease.query('COMMIT');
      return result;
    } catch (error) {
      lease.markBroken();
      dbFailure = !inWork;
      throw error;
    } finally {
      if (dbFailure || lease.isLost()) this.metrics.dependencyFailure('DATABASE');
      // Conexão em estado incerto não volta ao pool.
      lease.finish();
    }
  }
}

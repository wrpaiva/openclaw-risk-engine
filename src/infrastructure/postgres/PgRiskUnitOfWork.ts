import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { queryWithDeadline } from './clientLease.js';
import type { AccessRole } from '../../application/ports/AuthenticatedAgentContext.js';
import {
  UniqueConflictError,
  type AccountRecord,
  type AuditEvent,
  type OutboxEvent,
  type ReservationRecord,
  type ReservationStatus,
  type ReservedExposure,
  type RiskUnitOfWork,
  type StoredProposal,
} from '../../application/ports/RiskUnitOfWork.js';
import type { RiskDecisionV1 } from '../../domain/RiskDecision.js';
import type { TradeProposalV1 } from '../../domain/TradeProposal.js';

/** Reconciliação pós-restauração pendente ou estado operacional ausente: nenhuma operação transacional prossegue. */
export class RestorePendingError extends Error {
  override readonly name = 'RestorePendingError';
  constructor() {
    super('reconciliação pós-restauração pendente');
  }
}

const UNIQUE_VIOLATION = '23505';

interface ReservationRow {
  reservation_id: string;
  decision_id: string;
  account_id: string;
  instrument: string;
  strategy_id: string;
  exposure_base: string;
  risk_base: string;
  status: ReservationStatus;
  expires_at: Date;
  created_at: Date;
  closed_at: Date | null;
  paper_order_id: string | null;
}

const RESERVATION_COLUMNS = `reservation_id, decision_id, account_id, instrument, strategy_id,
  exposure_base::text AS exposure_base, risk_base::text AS risk_base, status, expires_at, created_at, closed_at, paper_order_id`;

export class PgRiskUnitOfWork implements RiskUnitOfWork {
  /** `queryTimeoutMs`: prazo do cliente por comando (ver clientLease.ts); sem ele, só o statement_timeout do servidor vale. */
  constructor(
    private readonly client: PoolClient,
    private readonly queryTimeoutMs?: number,
  ) {}

  private query<R extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<QueryResult<R>> {
    return queryWithDeadline<R>(this.client, text, values, this.queryTimeoutMs);
  }

  async hasActiveGrant(principalId: string, role: AccessRole, accountId: string): Promise<boolean> {
    const { rows } = await this.query(
      'SELECT 1 FROM risk_access_grants WHERE principal_id = $1 AND role = $2 AND account_id = $3 AND revoked_at IS NULL',
      [principalId, role, accountId],
    );
    return rows.length > 0;
  }

  async assertOperational(): Promise<void> {
    const state = await this.query<{ restore_pending: boolean }>('SELECT restore_pending FROM risk_operational_state');
    if (state.rows.length !== 1 || state.rows[0]?.restore_pending !== false) throw new RestorePendingError();
  }

  async lockAccount(accountId: string): Promise<AccountRecord | null> {
    // Lock explícito por conta (SPEC §7.2.3): vale também para contas ainda não cadastradas,
    // então propostas concorrentes para conta desconhecida também são serializadas.
    await this.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [accountId]);
    // Reconciliação pós-restauração pendente (ou estado ilegível/ausente): fail-closed, sob o lock da conta,
    // para que tráfego direto não contorne a readiness. A exceção vira UNAVAILABLE/503 nos casos de uso.
    await this.assertOperational();
    const { rows } = await this.query<{ account_id: string; environment: string }>(
      'SELECT account_id, environment FROM risk_accounts WHERE account_id = $1',
      [accountId],
    );
    const row = rows[0];
    return row ? { accountId: row.account_id, environment: row.environment } : null;
  }

  async findActivePolicyDocument(accountId: string): Promise<unknown> {
    const { rows } = await this.query<{ policy_json: unknown }>(
      'SELECT policy_json FROM risk_policies WHERE account_id = $1 AND active',
      [accountId],
    );
    return rows[0]?.policy_json ?? null;
  }

  async findProposalByIdempotencyKey(accountId: string, idempotencyKey: string): Promise<StoredProposal | null> {
    return this.findProposal('account_id = $1 AND idempotency_key = $2', [accountId, idempotencyKey]);
  }

  async findProposalById(proposalId: string): Promise<StoredProposal | null> {
    return this.findProposal('proposal_id = $1', [proposalId]);
  }

  async findDecisionByProposalId(proposalId: string): Promise<RiskDecisionV1 | null> {
    return this.findDecision('proposal_id = $1', proposalId);
  }

  async findDecisionById(decisionId: string): Promise<RiskDecisionV1 | null> {
    return this.findDecision('decision_id = $1', decisionId);
  }

  async sumActiveReservations(accountId: string, instrument: string, strategyId: string): Promise<ReservedExposure> {
    const { rows } = await this.query<{ total: string; by_instrument: string; by_strategy: string }>(
      `SELECT COALESCE(SUM(exposure_base), 0)::text AS total,
              COALESCE(SUM(exposure_base) FILTER (WHERE instrument = $2), 0)::text AS by_instrument,
              COALESCE(SUM(exposure_base) FILTER (WHERE strategy_id = $3), 0)::text AS by_strategy
         FROM risk_reservations WHERE account_id = $1 AND status = 'ACTIVE'`,
      [accountId, instrument, strategyId],
    );
    const row = rows[0];
    if (!row) throw new Error('soma de reservas sem resultado');
    return { totalBase: row.total, instrumentBase: row.by_instrument, strategyBase: row.by_strategy };
  }

  async insertProposal(proposal: TradeProposalV1, proposalHash: string, receivedAt: string): Promise<void> {
    await this.guardUnique(() =>
      this.query(
        `INSERT INTO trade_proposals
           (proposal_id, account_id, agent_id, idempotency_key, proposal_hash, payload_json, correlation_id, received_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          proposal.proposalId,
          proposal.accountId,
          proposal.agentId,
          proposal.idempotencyKey,
          proposalHash,
          JSON.stringify(proposal),
          proposal.correlationId,
          receivedAt,
        ],
      ),
    );
  }

  async insertDecision(d: RiskDecisionV1): Promise<void> {
    await this.guardUnique(() =>
      this.query(
        `INSERT INTO risk_decisions
           (decision_id, proposal_id, account_id, agent_id, status, violations_json, policy_id, policy_version, policy_hash,
            market_data_as_of, snapshot_version, reservation_id, authorization_expires_at, evaluated_at, decision_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          d.decisionId,
          d.proposalId,
          d.accountId,
          d.agentId,
          d.status,
          JSON.stringify(d.violations),
          d.policyId,
          d.policyVersion,
          d.policyHash,
          d.marketDataAsOf,
          d.snapshotVersion,
          d.reservationId,
          d.authorizationExpiresAt,
          d.evaluatedAt,
          JSON.stringify(d),
        ],
      ),
    );
  }

  async insertReservation(r: Omit<ReservationRecord, 'status' | 'closedAt' | 'paperOrderId'>): Promise<void> {
    await this.guardUnique(() =>
      this.query(
        `INSERT INTO risk_reservations
           (reservation_id, decision_id, account_id, instrument, strategy_id, exposure_base, risk_base, status, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6::numeric, $7::numeric, 'ACTIVE', $8, $9)`,
        [r.reservationId, r.decisionId, r.accountId, r.instrument, r.strategyId, r.exposureBase, r.riskBase, r.expiresAt, r.createdAt],
      ),
    );
  }

  async findReservation(reservationId: string): Promise<ReservationRecord | null> {
    const { rows } = await this.query<ReservationRow>(
      `SELECT ${RESERVATION_COLUMNS} FROM risk_reservations WHERE reservation_id = $1`,
      [reservationId],
    );
    return rows[0] ? toReservation(rows[0]) : null;
  }

  async findReservationByDecision(decisionId: string): Promise<ReservationRecord | null> {
    const { rows } = await this.query<ReservationRow>(
      `SELECT ${RESERVATION_COLUMNS} FROM risk_reservations WHERE decision_id = $1`,
      [decisionId],
    );
    return rows[0] ? toReservation(rows[0]) : null;
  }

  async findAccountsWithExpiredReservations(now: string): Promise<readonly string[]> {
    const { rows } = await this.query<{ account_id: string }>(
      `SELECT DISTINCT account_id FROM risk_reservations WHERE status = 'ACTIVE' AND expires_at <= $1`,
      [now],
    );
    return rows.map((r) => r.account_id);
  }

  async findExpiredActiveReservations(accountId: string, now: string): Promise<readonly ReservationRecord[]> {
    const { rows } = await this.query<ReservationRow>(
      `SELECT ${RESERVATION_COLUMNS} FROM risk_reservations
        WHERE account_id = $1 AND status = 'ACTIVE' AND expires_at <= $2 ORDER BY reservation_id`,
      [accountId, now],
    );
    return rows.map(toReservation);
  }

  async closeReservation(
    reservationId: string,
    to: Exclude<ReservationStatus, 'ACTIVE'>,
    closedAt: string,
    paperOrderId: string | null,
  ): Promise<boolean> {
    const result = await this.guardUnique(() =>
      this.query(
        `UPDATE risk_reservations SET status = $2, closed_at = $3, paper_order_id = $4
          WHERE reservation_id = $1 AND status = 'ACTIVE'`,
        [reservationId, to, closedAt, paperOrderId],
      ),
    );
    return result.rowCount === 1;
  }

  async appendAudit(e: AuditEvent): Promise<void> {
    await this.query(
      `INSERT INTO risk_audit_events
         (event_id, correlation_id, account_id, proposal_id, decision_id, reservation_id, event_type, details_json, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [e.eventId, e.correlationId, e.accountId, e.proposalId, e.decisionId, e.reservationId, e.eventType, JSON.stringify(e.details), e.createdAt],
    );
  }

  async appendOutbox(e: OutboxEvent): Promise<void> {
    await this.query(
      `INSERT INTO risk_outbox (event_id, aggregate_id, event_type, payload_json, created_at) VALUES ($1, $2, $3, $4, $5)`,
      [e.eventId, e.aggregateId, e.eventType, JSON.stringify(e.payload), e.createdAt],
    );
  }

  private async findProposal(where: string, params: readonly string[]): Promise<StoredProposal | null> {
    const { rows } = await this.query<{ proposal_id: string; account_id: string; idempotency_key: string; proposal_hash: string }>(
      `SELECT proposal_id, account_id, idempotency_key, proposal_hash FROM trade_proposals WHERE ${where}`,
      [...params],
    );
    const row = rows[0];
    return row
      ? { proposalId: row.proposal_id, accountId: row.account_id, idempotencyKey: row.idempotency_key, proposalHash: row.proposal_hash }
      : null;
  }

  private async findDecision(where: string, id: string): Promise<RiskDecisionV1 | null> {
    // decision_json é a decisão exatamente como devolvida; o chamador revalida antes de confiar.
    const { rows } = await this.query<{ decision_json: RiskDecisionV1 }>(`SELECT decision_json FROM risk_decisions WHERE ${where}`, [id]);
    return rows[0]?.decision_json ?? null;
  }

  private async guardUnique<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (isPgError(error) && error.code === UNIQUE_VIOLATION) throw new UniqueConflictError(error.constraint ?? 'unique');
      throw error;
    }
  }
}

function toReservation(row: ReservationRow): ReservationRecord {
  return {
    reservationId: row.reservation_id,
    decisionId: row.decision_id,
    accountId: row.account_id,
    instrument: row.instrument,
    strategyId: row.strategy_id,
    exposureBase: row.exposure_base,
    riskBase: row.risk_base,
    status: row.status,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    closedAt: row.closed_at ? row.closed_at.toISOString() : null,
    paperOrderId: row.paper_order_id,
  };
}

function isPgError(error: unknown): error is { code: string; constraint?: string } {
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string';
}

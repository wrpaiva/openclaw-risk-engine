import type { RiskDecisionV1 } from '../../domain/RiskDecision.js';
import type { TradeProposalV1 } from '../../domain/TradeProposal.js';
import type { AccessRole } from './AuthenticatedAgentContext.js';

export interface AccountRecord {
  readonly accountId: string;
  readonly environment: string;
}

export interface StoredProposal {
  readonly proposalId: string;
  readonly accountId: string;
  readonly idempotencyKey: string;
  readonly proposalHash: string;
}

export type ReservationStatus = 'ACTIVE' | 'CONSUMED' | 'EXPIRED' | 'RELEASED';

export interface ReservationRecord {
  readonly reservationId: string;
  readonly decisionId: string;
  readonly accountId: string;
  readonly instrument: string;
  readonly strategyId: string;
  readonly exposureBase: string;
  readonly riskBase: string;
  readonly status: ReservationStatus;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly closedAt: string | null;
  readonly paperOrderId: string | null;
}

/** Soma das reservas ACTIVE (inclusive vencidas ainda não expiradas pelo fluxo transacional). */
export interface ReservedExposure {
  readonly totalBase: string;
  readonly instrumentBase: string;
  readonly strategyBase: string;
}

export type AuditEventType =
  | 'DECISION_RECORDED'
  | 'RESERVATION_CREATED'
  | 'RESERVATION_CONSUMED'
  | 'RESERVATION_RELEASED'
  | 'RESERVATION_EXPIRED'
  | 'IDEMPOTENCY_CONFLICT';

/** Metadados apenas: nunca payload completo, tokens ou texto de agente (SPEC §7.3). */
export interface AuditEvent {
  readonly eventId: string;
  readonly eventType: AuditEventType;
  readonly correlationId: string | null;
  readonly accountId: string | null;
  readonly proposalId: string | null;
  readonly decisionId: string | null;
  readonly reservationId: string | null;
  readonly details: Readonly<Record<string, string | number | boolean | null | readonly string[]>>;
  readonly createdAt: string;
}

export interface OutboxEvent {
  readonly eventId: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

/** Violação de unicidade concorrente (ex.: proposalId reutilizado em outra conta). */
export class UniqueConflictError extends Error {
  override readonly name = 'UniqueConflictError';
}

/** Operações disponíveis dentro de uma transação. */
export interface RiskUnitOfWork {
  /**
   * Falha (RestorePendingError) se a reconciliação pós-restauração está pendente ou o estado operacional é ilegível/ausente.
   * `lockAccount` já a aplica; este método existe para fluxos que podem não tomar nenhum lock de conta (varredura sem vencidas).
   */
  assertOperational(): Promise<void>;
  /** Serializa operações da conta até o fim da transação e devolve o registro (ou `null`). */
  lockAccount(accountId: string): Promise<AccountRecord | null>;
  /** Documento bruto da política ativa; validado pelo chamador. Mais de uma ativa é impossível (índice único). */
  /** Concessão ativa (não revogada) do principal com o papel na conta. */
  hasActiveGrant(principalId: string, role: AccessRole, accountId: string): Promise<boolean>;
  findActivePolicyDocument(accountId: string): Promise<unknown>;
  findProposalByIdempotencyKey(accountId: string, idempotencyKey: string): Promise<StoredProposal | null>;
  findProposalById(proposalId: string): Promise<StoredProposal | null>;
  findDecisionByProposalId(proposalId: string): Promise<RiskDecisionV1 | null>;
  findDecisionById(decisionId: string): Promise<RiskDecisionV1 | null>;
  sumActiveReservations(accountId: string, instrument: string, strategyId: string): Promise<ReservedExposure>;
  insertProposal(proposal: TradeProposalV1, proposalHash: string, receivedAt: string): Promise<void>;
  insertDecision(decision: RiskDecisionV1): Promise<void>;
  insertReservation(reservation: Omit<ReservationRecord, 'status' | 'closedAt' | 'paperOrderId'>): Promise<void>;
  findReservation(reservationId: string): Promise<ReservationRecord | null>;
  findReservationByDecision(decisionId: string): Promise<ReservationRecord | null>;
  /** Contas com reservas ACTIVE vencidas em `now`. */
  findAccountsWithExpiredReservations(now: string): Promise<readonly string[]>;
  findExpiredActiveReservations(accountId: string, now: string): Promise<readonly ReservationRecord[]>;
  /** Transição única ACTIVE → destino; `false` se a reserva já não estava ACTIVE. */
  closeReservation(
    reservationId: string,
    to: Exclude<ReservationStatus, 'ACTIVE'>,
    closedAt: string,
    paperOrderId: string | null,
  ): Promise<boolean>;
  appendAudit(event: AuditEvent): Promise<void>;
  appendOutbox(event: OutboxEvent): Promise<void>;
}

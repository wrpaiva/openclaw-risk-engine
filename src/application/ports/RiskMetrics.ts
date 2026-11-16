/**
 * Emissores de dependencyFailure: apenas 'DATABASE' (PgTransactionManager: falha de connect/BEGIN/configuração/COMMIT
 * ou conexão perdida em uso). MARKET_DATA, INSTRUMENT_CATALOG e ACCOUNT_SNAPSHOT NÃO têm emissor de propósito: as fontes
 * reais dependem de decisões em aberto (D-02/D-03/D-05) e hoje as fontes Unconfigured devolvem null, o que já vira violação
 * de BLOCK (fail-closed), não falha de dependência. Quando houver adaptadores reais, eles passam a emitir.
 */
/** Enums fechados: nunca ids de conta, agente, proposta ou correlação como rótulo (baixa cardinalidade, SPEC §11.3). */
export type EvaluationOutcome = 'ALLOW_PAPER' | 'BLOCK';
export type TransportOutcome = 'AUTH' | 'CONTRACT' | 'CONFLICT' | 'UNAVAILABLE';
export type ReservationOp = 'CONSUME' | 'RELEASE' | 'EXPIRE';
export type ReservationOpOutcome = 'OK' | 'CONFLICT' | 'FORBIDDEN' | 'UNAVAILABLE';
export type DependencyKind = 'DATABASE' | 'MARKET_DATA' | 'INSTRUMENT_CATALOG' | 'ACCOUNT_SNAPSHOT';

export interface RiskMetrics {
  /** risk_evaluations_total{status,reasonCode}; reasonCode é um código fechado de violação (ou 'NONE'). */
  evaluation(status: EvaluationOutcome, reasonCode: string): void;
  /** risk_evaluation_duration_seconds */
  evaluationDuration(seconds: number): void;
  /** Erros de transporte, distintos de BLOCK. */
  transportError(outcome: TransportOutcome): void;
  /** risk_reservation_conflicts_total */
  reservationConflict(op: ReservationOp): void;
  reservationOp(op: ReservationOp, outcome: ReservationOpOutcome): void;
  /** risk_dependency_failures_total */
  dependencyFailure(kind: DependencyKind): void;
  /** risk_idempotency_replays_total */
  idempotencyReplay(): void;
}

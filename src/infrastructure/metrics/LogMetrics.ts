import type { Logger } from '../../application/ports/Logger.js';
import type {
  DependencyKind,
  EvaluationOutcome,
  ReservationOp,
  ReservationOpOutcome,
  RiskMetrics,
  TransportOutcome,
} from '../../application/ports/RiskMetrics.js';

/**
 * Métricas derivadas de log (decisão da 2.5): cada evento `metric.*` é uma linha JSON agregável por quem coleta logs.
 * Só enums fechados, contagens e durações; nunca ids. Nunca lança.
 */
export class LogMetrics implements RiskMetrics {
  constructor(private readonly logger: Logger) {}

  evaluation(status: EvaluationOutcome, reasonCode: string): void {
    this.emit('metric.evaluation', { outcome: status, violationCodes: [reasonCode], count: 1 });
  }
  evaluationDuration(seconds: number): void {
    this.emit('metric.evaluation_duration', { durationMs: seconds * 1000 });
  }
  transportError(outcome: TransportOutcome): void {
    this.emit('metric.transport_error', { outcome, count: 1 });
  }
  reservationConflict(op: ReservationOp): void {
    this.emit('metric.reservation_conflict', { op, count: 1 });
  }
  reservationOp(op: ReservationOp, outcome: ReservationOpOutcome): void {
    this.emit('metric.reservation_op', { op, outcome, count: 1 });
  }
  dependencyFailure(kind: DependencyKind): void {
    this.emit('metric.dependency_failure', { kind, count: 1 });
  }
  idempotencyReplay(): void {
    this.emit('metric.idempotency_replay', { count: 1 });
  }

  private emit(event: string, fields: Parameters<Logger['info']>[1]): void {
    try {
      this.logger.info(event, fields);
    } catch {
      // Métrica nunca afeta o fluxo de risco.
    }
  }
}

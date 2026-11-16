import type { DependencyKind, EvaluationOutcome, ReservationOp, ReservationOpOutcome, RiskMetrics, TransportOutcome } from '../../../src/application/ports/RiskMetrics.js';

/** RiskMetrics que registra as emissões como "metodo:arg:arg" para afirmações exatas. */
export class RecordingMetrics implements RiskMetrics {
  readonly calls: string[] = [];
  evaluation(status: EvaluationOutcome, reasonCode: string): void {
    this.calls.push(`evaluation:${status}:${reasonCode}`);
  }
  evaluationDuration(): void {
    this.calls.push('evaluationDuration');
  }
  transportError(outcome: TransportOutcome): void {
    this.calls.push(`transportError:${outcome}`);
  }
  reservationConflict(op: ReservationOp): void {
    this.calls.push(`reservationConflict:${op}`);
  }
  reservationOp(op: ReservationOp, outcome: ReservationOpOutcome): void {
    this.calls.push(`reservationOp:${op}:${outcome}`);
  }
  dependencyFailure(kind: DependencyKind): void {
    this.calls.push(`dependencyFailure:${kind}`);
  }
  idempotencyReplay(): void {
    this.calls.push('idempotencyReplay');
  }
}

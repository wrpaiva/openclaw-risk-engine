import type { RiskMetrics } from './ports/RiskMetrics.js';

export class NoopMetrics implements RiskMetrics {
  evaluation(): void {}
  evaluationDuration(): void {}
  transportError(): void {}
  reservationConflict(): void {}
  reservationOp(): void {}
  dependencyFailure(): void {}
  idempotencyReplay(): void {}
}

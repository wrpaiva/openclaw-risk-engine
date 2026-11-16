import { NoopMetrics } from './NoopMetrics.js';
import type { RiskMetrics } from './ports/RiskMetrics.js';

function swallow(fn: () => void): void {
  try {
    fn();
  } catch {
    // métrica nunca afeta a decisão
  }
}

/** Isola o fluxo de risco de falhas de métricas: qualquer exceção do coletor é engolida. Sem coletor, usa NoopMetrics. */
export function safeMetrics(metrics: RiskMetrics | undefined): RiskMetrics {
  const m = metrics ?? new NoopMetrics();
  return {
    evaluation: (status, reasonCode) => { swallow(() => { m.evaluation(status, reasonCode); }); },
    evaluationDuration: (seconds) => { swallow(() => { m.evaluationDuration(seconds); }); },
    transportError: (outcome) => { swallow(() => { m.transportError(outcome); }); },
    reservationConflict: (op) => { swallow(() => { m.reservationConflict(op); }); },
    reservationOp: (op, outcome) => { swallow(() => { m.reservationOp(op, outcome); }); },
    dependencyFailure: (kind) => { swallow(() => { m.dependencyFailure(kind); }); },
    idempotencyReplay: () => { swallow(() => { m.idempotencyReplay(); }); },
  };
}

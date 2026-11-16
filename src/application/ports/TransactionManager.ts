import type { RiskUnitOfWork } from './RiskUnitOfWork.js';

/**
 * Unidade de trabalho (SPEC §7.2): tudo que `work` grava é confirmado num único COMMIT.
 * Qualquer erro em `work` ou no COMMIT provoca rollback e é propagado — nunca vira autorização.
 */
export interface TransactionManager {
  run<T>(work: (uow: RiskUnitOfWork) => Promise<T>): Promise<T>;
}

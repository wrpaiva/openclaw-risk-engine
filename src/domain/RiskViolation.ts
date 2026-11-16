/** Códigos estruturados de violação (SPEC §4.5). */
export const RISK_VIOLATION_CODES = [
  'INVALID_PROPOSAL',
  'UNAUTHORIZED_AGENT',
  'NON_PAPER_ENVIRONMENT',
  'POLICY_MISSING',
  'POLICY_INVALID',
  'INSTRUMENT_NOT_ALLOWED',
  'MARKET_DATA_UNAVAILABLE',
  'MARKET_DATA_STALE',
  'FX_RATE_UNAVAILABLE',
  'ACCOUNT_SNAPSHOT_STALE',
  'INSUFFICIENT_CASH',
  'INVALID_STOP_LOSS',
  'MAX_ORDER_NOTIONAL',
  'MAX_TRADE_RISK',
  'MAX_GROSS_EXPOSURE',
  'MAX_INSTRUMENT_EXPOSURE',
  'MAX_STRATEGY_EXPOSURE',
  'DAILY_LOSS_LIMIT',
  'PROPOSAL_EXPIRED',
  'RISK_CAPACITY_UNAVAILABLE',
  'INTERNAL_EVALUATION_FAILURE',
] as const;

export type RiskViolationCode = (typeof RISK_VIOLATION_CODES)[number];

export interface RiskViolationV1 {
  readonly code: RiskViolationCode;
  readonly field?: string;
  /** Mensagem de auditoria determinística; nunca gerada por LLM. */
  readonly message: string;
  readonly observed?: string;
  readonly limit?: string;
}

/** Allowlist tipada: nada fora destes campos chega ao log (sem tokens, headers, payloads ou prompts). */
export interface LogFields {
  readonly requestId?: string;
  readonly correlationId?: string;
  readonly proposalId?: string;
  readonly decisionId?: string;
  readonly reservationId?: string;
  readonly principalId?: string;
  readonly accountId?: string;
  readonly route?: string;
  readonly httpStatus?: number;
  readonly outcome?: string;
  readonly violationCodes?: readonly string[];
  readonly errorKind?: string;
  readonly durationMs?: number;
  /** Eventos metric.*: enums fechados e contagens, nunca ids. */
  readonly op?: string;
  readonly kind?: string;
  readonly count?: number;
  /** http.listening: enums fechados (ADR-0011); nunca host, porta ou URL. */
  readonly bindScope?: string;
  readonly transport?: string;
}

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

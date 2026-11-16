import type { RiskViolationCode, RiskViolationV1 } from '../domain/RiskViolation.js';
import { DecimalAmount } from '../domain/value-objects/DecimalAmount.js';
import { UtcInstant } from '../domain/value-objects/UtcInstant.js';

/**
 * Converte string já validada pelo schema. Falha aqui é erro de programação:
 * a exceção é capturada pelo avaliador e vira INTERNAL_EVALUATION_FAILURE (fail-closed).
 */
export function dec(raw: string): DecimalAmount {
  const r = DecimalAmount.parse(raw, { allowNegative: true });
  if (!r.ok) throw new Error(`decimal não validado: ${r.error}`);
  return r.value;
}

export function instant(raw: string): UtcInstant {
  const r = UtcInstant.parse(raw);
  if (!r.ok) throw new Error(`instante não validado: ${r.error}`);
  return r.value;
}

export function violation(
  code: RiskViolationCode,
  field: string,
  message: string,
  observed?: string,
  limit?: string,
): RiskViolationV1 {
  return {
    code,
    field,
    message,
    ...(observed !== undefined ? { observed } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

export type Freshness = 'FRESH' | 'STALE' | 'FUTURE';

/**
 * Dado é fresco se a idade é estritamente menor que o limite ("abaixo do limite", SPEC §5 regra 3).
 * Timestamp no futuro além da tolerância de relógio não é confiável.
 */
export function freshness(asOf: UtcInstant, now: UtcInstant, maxAgeMs: number, clockSkewToleranceMs: number): Freshness {
  if (asOf.isAfter(now.plusMillis(clockSkewToleranceMs))) return 'FUTURE';
  return now.millisSince(asOf) < maxAgeMs ? 'FRESH' : 'STALE';
}

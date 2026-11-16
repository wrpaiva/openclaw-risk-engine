import { z } from 'zod';
import { DecimalAmount, type DecimalParseOptions } from './value-objects/DecimalAmount.js';
import { UtcInstant } from './value-objects/UtcInstant.js';

/** Identificador opaco: 1..128 caracteres ASCII visíveis (seguro para log e índice). */
const OPAQUE_ID_PATTERN = /^[\x21-\x7E]{1,128}$/;
export const opaqueId = () => z.string().regex(OPAQUE_ID_PATTERN);

export function isOpaqueId(s: string): boolean {
  return OPAQUE_ID_PATTERN.test(s);
}

/** UUID no mesmo critério dos schemas (`z.uuid()`). */
export function isUuid(s: string): boolean {
  return z.uuid().safeParse(s).success;
}

/** String decimal canônica (ver DecimalAmount); nunca `number`. */
export const decimalString = (options: DecimalParseOptions) =>
  z.string().refine((s) => DecimalAmount.parse(s, options).ok, { message: 'decimal inválido' });

/** ISO-8601 com offset explícito. */
export const instantString = () =>
  z.string().refine((s) => UtcInstant.parse(s).ok, { message: 'instante ISO-8601 com offset inválido' });

export function issueField(issue: z.core.$ZodIssue): string | undefined {
  if (issue.code === 'unrecognized_keys') return issue.keys.join(',');
  return issue.path.length > 0 ? issue.path.map(String).join('.') : undefined;
}

/** Converte string já validada pelo schema; falha aqui é erro de programação. */
export function mustParseInstant(raw: string): UtcInstant {
  const r = UtcInstant.parse(raw);
  if (!r.ok) throw new Error('instante deveria ter sido validado pelo schema');
  return r.value;
}

export function assertNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} deve ser inteiro não negativo e explícito`);
  }
}

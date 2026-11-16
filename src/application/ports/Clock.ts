import type { UtcInstant } from '../../domain/value-objects/UtcInstant.js';

/** Relógio injetável; o domínio nunca lê `Date.now()` diretamente (SPEC §5 regra 3). */
export interface Clock {
  now(): UtcInstant;
}

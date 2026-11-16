/** Identificadores UUID gerados por fonte criptográfica; nunca `Math.random()` (SPEC §6). */
export interface IdGenerator {
  uuid(): string;
}

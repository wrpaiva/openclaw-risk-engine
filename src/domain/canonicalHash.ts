import { createHash } from 'node:crypto';

/**
 * JSON canônico usado em `policyHash` e `proposalHash` (ADR-0005):
 * chaves de objeto em ordem lexicográfica (code units UTF-16), sem espaços, arrays em ordem,
 * apenas string, boolean, null, inteiros seguros, arrays e objetos simples.
 * Valores monetários trafegam como string; números fracionários são rejeitados por ambiguidade.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isSafeInteger(value)) throw new TypeError('JSON canônico aceita apenas inteiros seguros');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
      const proto = Object.getPrototypeOf(value) as unknown;
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError('JSON canônico aceita apenas objetos simples');
      }
      const record = value as Record<string, unknown>;
      const entries = Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
      return `{${entries.join(',')}}`;
    }
    default:
      throw new TypeError(`Tipo não suportado em JSON canônico: ${typeof value}`);
  }
}

export function sha256Canonical(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

import { describe, expect, it } from 'vitest';
import { UtcInstant } from '../../../src/domain/value-objects/UtcInstant.js';

const parse = (raw: string) => {
  const r = UtcInstant.parse(raw);
  if (!r.ok) throw new Error(`fixture inválida: ${raw}`);
  return r.value;
};

describe('UtcInstant.parse', () => {
  it.each([
    ['2026-11-13T22:00:00Z', '2026-11-13T22:00:00.000Z'],
    ['2026-11-13T22:00:00.123Z', '2026-11-13T22:00:00.123Z'],
    ['2026-11-13T19:00:00-03:00', '2026-11-13T22:00:00.000Z'],
    ['2026-11-14T01:30:00+03:30', '2026-11-13T22:00:00.000Z'],
    ['2028-02-29T00:00:00Z', '2028-02-29T00:00:00.000Z'],
  ])('aceita %s e normaliza para UTC', (raw, iso) => {
    expect(parse(raw).toISOString()).toBe(iso);
  });

  it.each([
    ['sem offset', '2026-11-13T22:00:00'],
    ['só data', '2026-11-13'],
    ['epoch numérico em string', '1763071200000'],
    ['dia inexistente (V8 rolaria para março)', '2026-02-30T00:00:00Z'],
    ['29/02 em ano não bissexto', '2026-02-29T00:00:00Z'],
    ['hora 24', '2026-11-13T24:00:00Z'],
    ['minuto 60', '2026-11-13T22:60:00Z'],
    ['segundo bissexto 60', '2026-11-13T22:00:60Z'],
    ['mês 13', '2026-13-01T00:00:00Z'],
    ['offset fora da faixa', '2026-11-13T22:00:00+25:00'],
    ['mais de 3 casas de fração (truncaria em silêncio)', '2026-11-13T22:00:00.1234Z'],
    ['separador com espaço', '2026-11-13 22:00:00Z'],
    ['z minúsculo', '2026-11-13T22:00:00z'],
    ['vazio', ''],
    ['ano anterior a 1970 (Date.UTC trata 0..99 como 19xx)', '0099-01-01T00:00:00Z'],
  ])('rejeita %s', (_label, raw) => {
    expect(UtcInstant.parse(raw).ok).toBe(false);
  });

  it('rejeita valor que não é string', () => {
    expect(UtcInstant.parse(Date.now() as unknown as string).ok).toBe(false);
  });
});

describe('UtcInstant comparação', () => {
  it('compara instantes equivalentes em fusos diferentes', () => {
    const a = parse('2026-11-13T22:00:00Z');
    const b = parse('2026-11-13T19:00:00-03:00');
    expect(a.equals(b)).toBe(true);
    expect(a.isBefore(b)).toBe(false);
    expect(a.isAfter(b)).toBe(false);
  });

  it('ordena e mede diferença em milissegundos', () => {
    const a = parse('2026-11-13T22:00:00.000Z');
    const b = parse('2026-11-13T22:00:01.500Z');
    expect(a.isBefore(b)).toBe(true);
    expect(b.isAfter(a)).toBe(true);
    expect(b.millisSince(a)).toBe(1500);
    expect(a.plusMillis(1500).equals(b)).toBe(true);
  });

  it('cria a partir de epoch ms para relógios injetados', () => {
    expect(UtcInstant.fromEpochMillis(0).toISOString()).toBe('1970-01-01T00:00:00.000Z');
    expect(() => UtcInstant.fromEpochMillis(Number.NaN)).toThrow();
    expect(() => UtcInstant.fromEpochMillis(1.5)).toThrow();
  });
});

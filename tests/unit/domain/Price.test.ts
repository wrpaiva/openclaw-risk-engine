import { describe, expect, it } from 'vitest';
import { Price } from '../../../src/domain/value-objects/Price.js';

function price(raw: string, currency = 'USD'): Price {
  const r = Price.parse(raw, currency);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

describe('Price', () => {
  it('aceita preço positivo com moeda', () => {
    expect(price('100.01').toString()).toBe('100.01');
  });

  it.each([
    ['0', 'NOT_POSITIVE'],
    ['-1', 'NEGATIVE_NOT_ALLOWED'],
    ['1e2', 'MALFORMED'],
  ])('rejeita %s com %s', (raw, error) => {
    expect(Price.parse(raw, 'USD')).toEqual({ ok: false, error });
  });

  it('rejeita escala acima do tick do instrumento', () => {
    expect(Price.parse('100.001', 'USD', 2)).toEqual({ ok: false, error: 'SCALE_EXCEEDED' });
  });

  it('rejeita moeda inválida', () => {
    expect(Price.parse('1', 'us')).toEqual({ ok: false, error: 'INVALID_CURRENCY' });
  });

  it('compara na mesma moeda e recusa moedas distintas', () => {
    expect(price('1.10').compare(price('1.1'))).toBe(0);
    expect(() => price('1', 'USD').compare(price('1', 'BRL'))).toThrow(TypeError);
  });
});

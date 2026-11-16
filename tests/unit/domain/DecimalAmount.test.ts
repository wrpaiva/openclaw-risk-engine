import { describe, expect, it } from 'vitest';
import { DecimalAmount } from '../../../src/domain/value-objects/DecimalAmount.js';

describe('DecimalAmount.parse', () => {
  it.each(['1', '0.1', '123.456', '1000000', '0.00000001'])('aceita decimal canônico %s', (raw) => {
    const result = DecimalAmount.parse(raw);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.toString()).toBe(raw);
  });

  it.each([
    ['notação exponencial', '1e3'],
    ['exponencial maiúscula', '1E-2'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['vazio', ''],
    ['espaços', ' 1'],
    ['sinal +', '+1'],
    ['zero à esquerda', '01'],
    ['ponto sem fração', '1.'],
    ['fração sem inteiro', '.5'],
    ['vírgula decimal', '1,5'],
    ['hexadecimal', '0x10'],
    ['separador de milhar', '1_000'],
  ])('rejeita %s', (_label, raw) => {
    expect(DecimalAmount.parse(raw).ok).toBe(false);
  });

  it('rejeita valores que não são string, inclusive number JS', () => {
    expect(DecimalAmount.parse(0.1 as unknown as string).ok).toBe(false);
    expect(DecimalAmount.parse(null as unknown as string).ok).toBe(false);
  });

  it('rejeita negativos por padrão e aceita quando permitido', () => {
    expect(DecimalAmount.parse('-1').ok).toBe(false);
    const allowed = DecimalAmount.parse('-1.5', { allowNegative: true });
    expect(allowed.ok && allowed.value.toString()).toBe('-1.5');
  });

  it('rejeita "-0" mesmo quando negativos são permitidos', () => {
    expect(DecimalAmount.parse('-0', { allowNegative: true }).ok).toBe(false);
  });

  it('rejeita zero quando exigido positivo', () => {
    expect(DecimalAmount.parse('0', { positive: true }).ok).toBe(false);
    expect(DecimalAmount.parse('0.000', { positive: true }).ok).toBe(false);
    expect(DecimalAmount.parse('0.001', { positive: true }).ok).toBe(true);
  });

  it('rejeita escala acima do limite informado', () => {
    expect(DecimalAmount.parse('1.123', { maxScale: 2 }).ok).toBe(false);
    expect(DecimalAmount.parse('1.12', { maxScale: 2 }).ok).toBe(true);
  });

  it('rejeita overflow de dígitos inteiros e escala acima do teto técnico', () => {
    expect(DecimalAmount.parse('1'.repeat(DecimalAmount.MAX_INTEGER_DIGITS + 1)).ok).toBe(false);
    expect(DecimalAmount.parse('1'.repeat(DecimalAmount.MAX_INTEGER_DIGITS)).ok).toBe(true);
    expect(DecimalAmount.parse(`0.${'1'.repeat(DecimalAmount.MAX_SCALE + 1)}`).ok).toBe(false);
  });

  it('não permite maxScale acima do teto técnico', () => {
    expect(() => DecimalAmount.parse('1', { maxScale: DecimalAmount.MAX_SCALE + 1 })).toThrow();
  });
});

describe('DecimalAmount aritmética', () => {
  const d = (raw: string) => {
    const r = DecimalAmount.parse(raw, { allowNegative: true });
    if (!r.ok) throw new Error(`fixture inválida: ${raw}`);
    return r.value;
  };

  it('soma 0.1 + 0.2 exatamente, sem erro IEEE-754', () => {
    expect(d('0.1').plus(d('0.2')).equals(d('0.3'))).toBe(true);
  });

  it('subtrai, multiplica e compara de forma exata', () => {
    expect(d('10').minus(d('0.01')).toString()).toBe('9.99');
    expect(d('0.00000001').times(d('3')).toString()).toBe('0.00000003');
    expect(d('1.10').compare(d('1.1'))).toBe(0);
    expect(d('1.1').greaterThan(d('1.09'))).toBe(true);
    expect(d('1.09').lessThan(d('1.1'))).toBe(true);
  });

  it('calcula valor absoluto e sinais', () => {
    expect(d('-2.5').abs().toString()).toBe('2.5');
    expect(d('-2.5').isNegative()).toBe(true);
    expect(d('0').isZero()).toBe(true);
  });

  it('toString nunca usa notação exponencial', () => {
    expect(d('0.0000000000000001').toString()).toBe('0.0000000000000001');
    expect(d('100000000000000000000000').toString()).toBe('100000000000000000000000');
  });

  it('é imutável', () => {
    const a = d('1');
    a.plus(d('1'));
    expect(a.toString()).toBe('1');
    expect(Object.isFrozen(a)).toBe(true);
  });
});

describe('DecimalAmount — incrementos e escala', () => {
  const d = (raw: string) => {
    const r = DecimalAmount.parse(raw, { allowNegative: true });
    if (!r.ok) throw new Error(raw);
    return r.value;
  };

  it.each([
    ['0.03', '0.01', true],
    ['0.0300', '0.01', true],
    ['0.035', '0.01', false],
    ['100.01', '0.01', true],
    ['0.3', '0.1', true],
    ['1.000000000000000001', '0.000000000000000001', true],
    ['1.000000000000000001', '0.01', false],
  ])('%s múltiplo de %s = %s (exato, sem ponto flutuante)', (value, step, expected) => {
    expect(d(value).isMultipleOf(d(step))).toBe(expected);
  });

  it('recusa incremento zero ou negativo', () => {
    expect(() => d('1').isMultipleOf(d('0'))).toThrow(RangeError);
    expect(() => d('1').isMultipleOf(d('-1'))).toThrow(RangeError);
  });

  it('calcula escala sem zeros à direita', () => {
    expect(d('1.2300').scale()).toBe(2);
    expect(d('10').scale()).toBe(0);
  });

  it('min/max e negação sem zero negativo', () => {
    expect(d('1.5').max(d('2')).toString()).toBe('2');
    expect(d('1.5').min(d('2')).toString()).toBe('1.5');
    expect(d('0').negated().toString()).toBe('0');
    expect(d('-3.2').negated().toString()).toBe('3.2');
  });
});

describe('DecimalAmount.roundUpToScale', () => {
  const d = (raw: string) => {
    const r = DecimalAmount.parse(raw, { allowNegative: true });
    if (!r.ok) throw new Error(raw);
    return r.value;
  };

  it.each([
    ['1.0001', 2, '1.01'],
    ['1.00', 2, '1'],
    ['-1.0001', 2, '-1.01'],
  ])('%s na escala %i → %s (para longe de zero)', (raw, scale, expected) => {
    expect(d(raw).roundUpToScale(scale).toString()).toBe(expected);
  });

  it('produto com escala acima do teto é arredondado para cima, nunca truncado', () => {
    const product = d('0.0000000001').times(d('0.000000001')); // 1e-19
    expect(product.roundUpToScale(18).toString()).toBe('0.000000000000000001');
  });

  it('recusa escala inválida', () => {
    expect(() => d('1').roundUpToScale(19)).toThrow(RangeError);
  });
});

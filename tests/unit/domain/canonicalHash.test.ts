import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Canonical } from '../../../src/domain/canonicalHash.js';

describe('canonicalJson', () => {
  it('ordena chaves recursivamente e remove espaços', () => {
    expect(canonicalJson({ b: 1, a: { d: 'x', c: [2, 1] } })).toBe('{"a":{"c":[2,1],"d":"x"},"b":1}');
  });

  it('produz a mesma saída independentemente da ordem de inserção das chaves', () => {
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
  });

  it('preserva a ordem dos arrays', () => {
    expect(canonicalJson(['b', 'a'])).not.toBe(canonicalJson(['a', 'b']));
  });

  it('serializa strings, booleanos e null como JSON', () => {
    expect(canonicalJson({ s: 'á"\n', t: true, n: null })).toBe('{"n":null,"s":"á\\"\\n","t":true}');
  });

  it.each([
    ['undefined', { a: undefined }],
    ['NaN', { a: Number.NaN }],
    ['Infinity', { a: Number.POSITIVE_INFINITY }],
    ['número fracionário (ambíguo; dinheiro vai como string)', { a: 0.1 }],
    ['inteiro inseguro', { a: Number.MAX_SAFE_INTEGER + 1 }],
    ['bigint', { a: 1n }],
    ['função', { a: () => 1 }],
    ['Date', { a: new Date(0) }],
    ['Map', { a: new Map() }],
  ])('rejeita %s', (_label, value) => {
    expect(() => canonicalJson(value)).toThrow();
  });
});

describe('sha256Canonical', () => {
  it('é estável para o mesmo documento canônico', () => {
    expect(sha256Canonical({ b: '2', a: '1' })).toBe(sha256Canonical({ a: '1', b: '2' }));
  });

  it('muda quando qualquer valor muda', () => {
    expect(sha256Canonical({ a: '1' })).not.toBe(sha256Canonical({ a: '1.0' }));
  });

  it('usa o formato sha256:<hex de 64 caracteres> sobre UTF-8', () => {
    // sha256("{}") conhecido
    expect(sha256Canonical({})).toBe('sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
  });
});

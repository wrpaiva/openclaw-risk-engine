import { describe, expect, it } from 'vitest';
import { isOpaqueId, isUuid } from '../../../src/domain/schemaSupport.js';

describe('isOpaqueId', () => {
  it('aceita 1 e 128 caracteres ASCII visíveis', () => {
    expect(isOpaqueId('a')).toBe(true);
    expect(isOpaqueId('a'.repeat(128))).toBe(true);
    expect(isOpaqueId('agent-fixture_1:x.y')).toBe(true);
  });

  it.each([
    ['vazio', ''],
    ['129 caracteres', 'a'.repeat(129)],
    ['espaço', 'a b'],
    ['espaço à esquerda', ' a'],
    ['tab', 'a\tb'],
    ['quebra de linha final', 'abc\n'],
    ['não-ASCII', 'agénte'],
    ['emoji', 'a\u{1F600}'],
  ])('rejeita %s', (_l, v) => {
    expect(isOpaqueId(v)).toBe(false);
  });
});

describe('isUuid', () => {
  it('aceita UUID válido, minúsculo e maiúsculo', () => {
    expect(isUuid('123e4567-e89b-42d3-a456-426614174000')).toBe(true);
    expect(isUuid('123E4567-E89B-42D3-A456-426614174000')).toBe(true);
  });

  it.each([
    ['vazio', ''],
    ['sem hífens', '123e4567e89b42d3a456426614174000'],
    ['curto', '123e4567-e89b-42d3-a456-42661417400'],
    ['caractere inválido', '123e4567-e89b-42d3-a456-42661417400g'],
    ['espaço final', '123e4567-e89b-42d3-a456-426614174000 '],
    ['texto', 'not-a-uuid'],
  ])('rejeita %s', (_l, v) => {
    expect(isUuid(v)).toBe(false);
  });
});

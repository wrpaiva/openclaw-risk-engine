import { describe, expect, it } from 'vitest';
import { validateRiskContext } from '../../../src/domain/RiskContext.js';
import { fixtureContext } from '../../fixtures/contexts.js';

const isOk = (input: unknown) => validateRiskContext(input).ok;
const market = fixtureContext()['market'] as Record<string, unknown>;

describe('validateRiskContext', () => {
  it('aceita contexto completo, com P&L negativo', () => {
    expect(isOk(fixtureContext())).toBe(true);
  });

  it('aceita conversão de câmbio completa', () => {
    const conversion = { fromCurrency: 'USD', toCurrency: 'BRL', rate: '5.4321', asOf: '2026-11-13T21:59:00.000Z', source: 'fixture-fx' };
    expect(isOk(fixtureContext({ conversion }))).toBe(true);
  });

  it.each(['snapshotVersion', 'asOf', 'availableCashBase', 'openGrossExposureBase', 'pendingReservedExposureBase', 'market'])(
    'rejeita %s ausente (fail-closed)',
    (field) => {
      expect(isOk(fixtureContext({ [field]: undefined }))).toBe(false);
    },
  );

  it.each([
    ['bid zero', { bid: '0' }],
    ['ask ausente', { ask: undefined }],
    ['asOf sem offset', { asOf: '2026-11-13T21:59:59' }],
    ['preço em number', { bid: 99.99 }],
  ])('rejeita cotação com %s (UT-004)', (_label, override) => {
    expect(isOk(fixtureContext({ market: { ...market, ...override } }))).toBe(false);
  });

  it.each([
    ['exposição negativa', { openGrossExposureBase: '-1' }],
    ['notação exponencial', { equityBase: '1e4' }],
    ['câmbio incompleto', { conversion: { fromCurrency: 'USD', toCurrency: 'BRL', rate: '5.4' } }],
    ['câmbio zero', { conversion: { fromCurrency: 'USD', toCurrency: 'BRL', rate: '0', asOf: '2026-11-13T21:59:00.000Z', source: 'fx' } }],
    ['campo adicional', { referencePrice: '100' }],
  ])('rejeita %s', (_label, override) => {
    expect(isOk(fixtureContext(override))).toBe(false);
  });
});

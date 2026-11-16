import { describe, expect, it } from 'vitest';
import { validateInstrumentSpec } from '../../../src/domain/InstrumentSpec.js';
import { fixtureInstrument } from '../../fixtures/instruments.js';

const isOk = (input: unknown) => validateInstrumentSpec(input).ok;

describe('validateInstrumentSpec', () => {
  it('aceita instrumento spot completo e coerente', () => {
    expect(isOk(fixtureInstrument())).toBe(true);
  });

  it.each(['FUTURE', 'PERPETUAL', 'CFD', 'OPTION'])('rejeita productType %s sem modelo aprovado (D-02/D-06)', (productType) => {
    expect(isOk(fixtureInstrument({ productType }))).toBe(false);
  });

  it('rejeita short sem modelo de margem (UT-017)', () => {
    expect(isOk(fixtureInstrument({ shortSelling: 'ALLOWED' }))).toBe(false);
  });

  it.each(['tickSize', 'lotSize', 'minQuantity', 'contractMultiplier', 'quoteCurrency', 'market'])(
    'rejeita %s ausente (sem valor padrão)',
    (field) => {
      expect(isOk(fixtureInstrument({ [field]: undefined }))).toBe(false);
    },
  );

  it.each([
    ['tickSize zero', { tickSize: '0' }],
    ['lotSize negativo', { lotSize: '-0.0001' }],
    ['multiplicador exponencial', { contractMultiplier: '1e0' }],
    ['tickSize acima da escala de preço', { tickSize: '0.001' }],
    ['lotSize acima da escala de quantidade', { lotSize: '0.00001' }],
    ['escala fracionária', { priceScale: 2.5 }],
    ['escala acima do teto técnico', { quantityScale: 19 }],
    ['moeda minúscula', { quoteCurrency: 'usd' }],
    ['campo adicional', { leverage: '10' }],
  ])('rejeita %s', (_label, override) => {
    expect(isOk(fixtureInstrument(override))).toBe(false);
  });
});

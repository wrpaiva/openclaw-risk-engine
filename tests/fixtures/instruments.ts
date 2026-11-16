// Instrumento FICTÍCIO para testes. Universo real de instrumentos depende de D-02 (SPEC §12).
export function fixtureInstrument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    instrument: 'FIXTURE-BTC-USD',
    market: 'CRYPTO',
    productType: 'SPOT',
    baseAsset: 'BTC',
    quoteCurrency: 'USD',
    tickSize: '0.01',
    lotSize: '0.0001',
    minQuantity: '0.0001',
    priceScale: 2,
    quantityScale: 4,
    contractMultiplier: '1',
    shortSelling: 'UNSUPPORTED',
    enabled: true,
    ...overrides,
  };
}

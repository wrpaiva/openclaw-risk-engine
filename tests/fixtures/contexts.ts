// Contexto FICTÍCIO para testes. Fonte real de saldo/market data depende de D-03/D-05 (SPEC §12).
export function fixtureContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    accountId: 'paper-fixture',
    snapshotVersion: 'snapshot-fixture-1',
    asOf: '2026-11-13T21:59:59.000Z',
    equityBase: '10000',
    availableCashBase: '10000',
    realizedDailyPnlBase: '0',
    unrealizedPnlBase: '-1.50',
    openGrossExposureBase: '0',
    pendingReservedExposureBase: '0',
    instrumentExposureBase: '0',
    strategyExposureBase: '0',
    market: {
      instrument: 'FIXTURE-BTC-USD',
      bid: '99.99',
      ask: '100.01',
      asOf: '2026-11-13T21:59:59.500Z',
      source: 'fixture-feed',
    },
    ...overrides,
  };
}

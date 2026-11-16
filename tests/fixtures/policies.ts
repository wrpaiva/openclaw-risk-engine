// Política FICTÍCIA para testes. Os números NÃO são limites aprovados (SPEC §4.2, §12 D-04).
import { computePolicyHash, type RiskPolicyV1 } from '../../src/domain/RiskPolicy.js';

export const FIXTURE_ACCOUNT_ID = 'paper-fixture';

type UnhashedPolicy = Omit<RiskPolicyV1, 'policyHash'>;

export function unhashedPolicy(overrides: Partial<Record<keyof UnhashedPolicy, unknown>> = {}): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    policyId: 'policy-fixture',
    version: '1.0.0-fixture',
    status: 'ACTIVE',
    validFrom: '2026-11-01T00:00:00.000Z',
    validUntil: '2026-12-01T00:00:00.000Z',
    accountId: FIXTURE_ACCOUNT_ID,
    baseCurrency: 'USD',
    maxOrderNotionalBase: '1000',
    maxGrossExposureBase: '5000',
    maxInstrumentExposureBase: '2000',
    maxStrategyExposureBase: '2000',
    maxDailyLossBase: '100',
    maxRiskPerTradeBase: '20',
    minAvailableCashBase: '0',
    maxMarketDataAgeMs: 5_000,
    maxAccountSnapshotAgeMs: 5_000,
    maxFxRateAgeMs: 60_000,
    maxProposalTtlMs: 60_000,
    maxAuthorizationTtlMs: 30_000,
    mandatoryStopLoss: true,
    allowedMarkets: ['CRYPTO'],
    allowedInstruments: ['FIXTURE-BTC-USD'],
    enabled: true,
    ...overrides,
  };
  // Override com `undefined` representa campo ausente.
  return Object.fromEntries(Object.entries(doc).filter(([, v]) => v !== undefined));
}

/** Política com hash recalculado após os overrides (documento íntegro). */
export function hashedPolicy(overrides: Partial<Record<keyof UnhashedPolicy, unknown>> = {}): Record<string, unknown> {
  const doc = unhashedPolicy(overrides);
  return { ...doc, policyHash: computePolicyHash(doc as UnhashedPolicy) };
}

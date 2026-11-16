// Fixtures FICTÍCIAS para testes. Não representam valores financeiros aprovados (SPEC §12).
import type { TradeProposalV1 } from '../../src/domain/TradeProposal.js';
import { UtcInstant } from '../../src/domain/value-objects/UtcInstant.js';

export const FIXTURE_NOW_ISO = '2026-11-13T22:00:00.000Z';
export const FIXTURE_AGENT_ID = 'agent-fixture-crypto';

export function fixtureNow(): UtcInstant {
  const r = UtcInstant.parse(FIXTURE_NOW_ISO);
  if (!r.ok) throw new Error('fixture de relógio inválida');
  return r.value;
}

export function validProposal(overrides: Partial<Record<keyof TradeProposalV1, unknown>> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    proposalId: '3dd99fb7-2fa8-4700-9d4f-4baf9a4e35f6',
    idempotencyKey: 'idem-fixture-001',
    accountId: 'paper-fixture',
    agentId: FIXTURE_AGENT_ID,
    environment: 'PAPER',
    market: 'CRYPTO',
    instrument: 'FIXTURE-BTC-USD',
    side: 'BUY',
    orderType: 'MARKET',
    quantity: '0.01',
    referencePrice: '100.00',
    stopLossPrice: '95.00',
    createdAt: '2026-11-13T21:59:30.000Z',
    expiresAt: '2026-11-13T22:00:30.000Z',
    strategyId: 'strategy-fixture',
    correlationId: 'corr-fixture-001',
    ...overrides,
  };
}

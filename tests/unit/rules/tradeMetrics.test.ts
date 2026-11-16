import { describe, expect, it } from 'vitest';
import { validateInstrumentSpec } from '../../../src/domain/InstrumentSpec.js';
import { validateRiskContext } from '../../../src/domain/RiskContext.js';
import { validateRiskPolicy } from '../../../src/domain/RiskPolicy.js';
import { validateTradeProposal } from '../../../src/domain/TradeProposal.js';
import type { RiskRuleInput } from '../../../src/rules/RiskRule.js';
import { computeTradeMetrics } from '../../../src/rules/tradeMetrics.js';
import { fixtureContext } from '../../fixtures/contexts.js';
import { fixtureInstrument } from '../../fixtures/instruments.js';
import { FIXTURE_ACCOUNT_ID, hashedPolicy } from '../../fixtures/policies.js';
import { FIXTURE_AGENT_ID, fixtureNow, validProposal } from '../../fixtures/proposals.js';

function unwrap<T>(r: { ok: true; value: T } | { ok: false }): T {
  if (!r.ok) throw new Error('fixture inválida');
  return r.value;
}

function input(proposal: Record<string, unknown>): RiskRuleInput {
  const now = fixtureNow();
  return {
    proposal: unwrap(validateTradeProposal(validProposal(proposal), { now, clockSkewToleranceMs: 0, authenticatedAgentId: FIXTURE_AGENT_ID })),
    policy: unwrap(validateRiskPolicy(hashedPolicy(), { now, accountId: FIXTURE_ACCOUNT_ID })),
    context: unwrap(validateRiskContext(fixtureContext())),
    instrument: unwrap(validateInstrumentSpec(fixtureInstrument())),
    now,
    clockSkewToleranceMs: 0,
  };
}

const metrics = (proposal: Record<string, unknown>) => {
  const m = computeTradeMetrics(input(proposal));
  return { risk: m.riskEntryPrice.toString(), notional: m.notionalPrice.toString() };
};

describe('computeTradeMetrics — preços conservadores (bid 99.99 / ask 100.01)', () => {
  it('BUY MARKET entra no ask', () => {
    expect(metrics({})).toEqual({ risk: '100.01', notional: '100.01' });
  });

  it('BUY LIMIT usa o teto limitPrice', () => {
    expect(metrics({ orderType: 'LIMIT', limitPrice: '99.00' })).toEqual({ risk: '99', notional: '99' });
  });

  it('SELL MARKET sai no bid', () => {
    expect(metrics({ side: 'SELL', stopLossPrice: '105.00' })).toEqual({ risk: '99.99', notional: '99.99' });
  });

  it('SELL LIMIT abaixo do bid: risco no limite (piso), notional no bid', () => {
    expect(metrics({ side: 'SELL', orderType: 'LIMIT', limitPrice: '98.00', stopLossPrice: '105.00' })).toEqual({ risk: '98', notional: '99.99' });
  });

  it('SELL LIMIT acima do bid: risco e notional no limite', () => {
    expect(metrics({ side: 'SELL', orderType: 'LIMIT', limitPrice: '101.00', stopLossPrice: '105.00' })).toEqual({ risk: '101', notional: '101' });
  });
});

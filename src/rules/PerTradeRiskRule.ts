import type { RiskViolationV1 } from '../domain/RiskViolation.js';
import type { RiskRule, RiskRuleInput } from './RiskRule.js';
import { dec, violation } from './ruleSupport.js';
import { computeTradeMetrics } from './tradeMetrics.js';

/** Regra 8: perda projetada no stop (sem custos/slippage até D-06) não supera o limite por operação. */
export const PerTradeRiskRule: RiskRule = {
  id: 'per-trade-risk',
  haltOnViolation: false,
  evaluate(input: Readonly<RiskRuleInput>): readonly RiskViolationV1[] {
    const { tradeRiskBase } = computeTradeMetrics(input);
    const max = dec(input.policy.maxRiskPerTradeBase);
    return tradeRiskBase.greaterThan(max)
      ? [violation('MAX_TRADE_RISK', 'stopLossPrice', 'perda projetada no stop excede o limite', tradeRiskBase.toString(), max.toString())]
      : [];
  },
};

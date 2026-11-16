import type { RiskViolationV1 } from '../domain/RiskViolation.js';
import type { RiskRule, RiskRuleInput } from './RiskRule.js';
import { dec, violation } from './ruleSupport.js';
import { computeTradeMetrics } from './tradeMetrics.js';

/** Regra 7: notional em moeda-base = quantidade × preço conservador × multiplicador × câmbio. */
export const OrderNotionalRule: RiskRule = {
  id: 'order-notional',
  haltOnViolation: false,
  evaluate(input: Readonly<RiskRuleInput>): readonly RiskViolationV1[] {
    const { notionalBase } = computeTradeMetrics(input);
    const max = dec(input.policy.maxOrderNotionalBase);
    return notionalBase.greaterThan(max)
      ? [violation('MAX_ORDER_NOTIONAL', 'quantity', 'valor da ordem excede o limite', notionalBase.toString(), max.toString())]
      : [];
  },
};

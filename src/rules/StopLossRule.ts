import type { RiskViolationV1 } from '../domain/RiskViolation.js';
import type { RiskRule, RiskRuleInput } from './RiskRule.js';
import { dec, violation } from './ruleSupport.js';
import { computeTradeMetrics } from './tradeMetrics.js';

/**
 * Regra 6: BUY exige stop abaixo da entrada conservadora e do bid atual;
 * SELL exige stop acima da entrada conservadora e do ask atual (stop não dispara de imediato).
 */
export const StopLossRule: RiskRule = {
  id: 'stop-loss',
  haltOnViolation: false,
  evaluate(input: Readonly<RiskRuleInput>): readonly RiskViolationV1[] {
    const { proposal, context } = input;
    const stop = dec(proposal.stopLossPrice);
    const { riskEntryPrice } = computeTradeMetrics(input);

    if (proposal.side === 'BUY') {
      const bound = riskEntryPrice.min(dec(context.market.bid));
      if (!stop.lessThan(bound)) {
        return [violation('INVALID_STOP_LOSS', 'stopLossPrice', 'stop de compra deve ficar abaixo da entrada e do bid', proposal.stopLossPrice, bound.toString())];
      }
    } else {
      const bound = riskEntryPrice.max(dec(context.market.ask));
      if (!stop.greaterThan(bound)) {
        return [violation('INVALID_STOP_LOSS', 'stopLossPrice', 'stop de venda deve ficar acima da entrada e do ask', proposal.stopLossPrice, bound.toString())];
      }
    }
    return [];
  },
};

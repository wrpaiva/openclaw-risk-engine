import type { RiskViolationV1 } from '../domain/RiskViolation.js';
import type { RiskRule, RiskRuleInput } from './RiskRule.js';
import { dec, violation } from './ruleSupport.js';
import { computeTradeMetrics } from './tradeMetrics.js';

/**
 * Regra 11 — convenção PROVISÓRIA e conservadora até D-04/D-07 (metodologia e calendário):
 * perda corrente = max(0, −(P&L realizado + não realizado)) do período informado pelo snapshot.
 * Bloqueia se a perda já atingiu o limite (UT-010) ou se perda + risco da nova operação o excede.
 */
export const DailyLossRule: RiskRule = {
  id: 'daily-loss',
  haltOnViolation: false,
  evaluate(input: Readonly<RiskRuleInput>): readonly RiskViolationV1[] {
    const { policy, context } = input;
    const zero = dec('0');
    const pnl = dec(context.realizedDailyPnlBase).plus(dec(context.unrealizedPnlBase));
    const currentLoss = pnl.negated().max(zero);
    const max = dec(policy.maxDailyLossBase);

    if (!currentLoss.lessThan(max)) {
      return [violation('DAILY_LOSS_LIMIT', 'context.realizedDailyPnlBase', 'perda diária atingida', currentLoss.toString(), max.toString())];
    }
    const projected = currentLoss.plus(computeTradeMetrics(input).tradeRiskBase);
    if (projected.greaterThan(max)) {
      return [violation('DAILY_LOSS_LIMIT', 'stopLossPrice', 'perda diária projetada no stop excede o limite', projected.toString(), max.toString())];
    }
    return [];
  },
};

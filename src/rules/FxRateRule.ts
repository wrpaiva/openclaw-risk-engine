import type { RiskViolationV1 } from '../domain/RiskViolation.js';
import type { RiskRule, RiskRuleInput } from './RiskRule.js';
import { freshness, instant, violation } from './ruleSupport.js';
import { fxRateToBase } from './tradeMetrics.js';

/** Pré-condição da regra 7: câmbio cotação → base presente, na direção certa e fresco. */
export const FxRateRule: RiskRule = {
  id: 'fx-rate',
  haltOnViolation: true,
  evaluate(input: Readonly<RiskRuleInput>): readonly RiskViolationV1[] {
    const { instrument, policy, context, now, clockSkewToleranceMs } = input;
    if (instrument.quoteCurrency === policy.baseCurrency) return [];

    const pair = `${instrument.quoteCurrency}->${policy.baseCurrency}`;
    if (fxRateToBase(input) === null || context.conversion === undefined) {
      return [violation('FX_RATE_UNAVAILABLE', 'context.conversion', 'câmbio necessário ausente ou de outro par', context.conversion ? `${context.conversion.fromCurrency}->${context.conversion.toCurrency}` : undefined, pair)];
    }
    if (freshness(instant(context.conversion.asOf), now, policy.maxFxRateAgeMs, clockSkewToleranceMs) !== 'FRESH') {
      return [violation('FX_RATE_UNAVAILABLE', 'context.conversion.asOf', 'câmbio desatualizado ou com timestamp no futuro', context.conversion.asOf, `${policy.maxFxRateAgeMs}ms`)];
    }
    return [];
  },
};

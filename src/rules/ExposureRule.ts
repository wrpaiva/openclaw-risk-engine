import type { RiskViolationV1 } from '../domain/RiskViolation.js';
import type { RiskRule, RiskRuleInput } from './RiskRule.js';
import { dec, violation } from './ruleSupport.js';
import { computeTradeMetrics } from './tradeMetrics.js';

/**
 * Regra 10: exposição bruta (sem compensar BUY e SELL) = abertas + reservas pendentes + nova.
 * Por instrumento e estratégia, o adaptador deve incluir as reservas pendentes no valor do contexto.
 */
export const ExposureRule: RiskRule = {
  id: 'exposure',
  haltOnViolation: false,
  evaluate(input: Readonly<RiskRuleInput>): readonly RiskViolationV1[] {
    const { policy, context } = input;
    const incremental = computeTradeMetrics(input).notionalBase;
    const out: RiskViolationV1[] = [];

    const gross = dec(context.openGrossExposureBase).plus(dec(context.pendingReservedExposureBase)).plus(incremental);
    const checks = [
      ['MAX_GROSS_EXPOSURE', 'exposição bruta agregada', gross, policy.maxGrossExposureBase],
      ['MAX_INSTRUMENT_EXPOSURE', 'exposição do instrumento', dec(context.instrumentExposureBase).plus(incremental), policy.maxInstrumentExposureBase],
      ['MAX_STRATEGY_EXPOSURE', 'exposição da estratégia', dec(context.strategyExposureBase).plus(incremental), policy.maxStrategyExposureBase],
    ] as const;
    for (const [code, label, projected, rawLimit] of checks) {
      const limit = dec(rawLimit);
      if (projected.greaterThan(limit)) {
        out.push(violation(code, 'quantity', `${label} excede o limite`, projected.toString(), limit.toString()));
      }
    }
    return out;
  },
};

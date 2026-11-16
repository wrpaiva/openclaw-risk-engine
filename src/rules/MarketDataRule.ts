import type { RiskViolationV1 } from '../domain/RiskViolation.js';
import type { RiskRule, RiskRuleInput } from './RiskRule.js';
import { dec, violation } from './ruleSupport.js';

/**
 * Regra 5: cotação confiável do instrumento correto e coerente (bid ≤ ask; zero já é rejeitado no schema).
 * Limiar de divergência entre `referencePrice` e mercado não existe na RiskPolicyV1 e depende de
 * decisão (D-04); não é inventado. A referência nunca é usada como preço.
 */
export const MarketDataRule: RiskRule = {
  id: 'market-data',
  haltOnViolation: true,
  evaluate({ proposal, context }: Readonly<RiskRuleInput>): readonly RiskViolationV1[] {
    const { market } = context;
    if (market.instrument !== proposal.instrument) {
      return [violation('MARKET_DATA_UNAVAILABLE', 'context.market.instrument', 'cotação de outro instrumento', market.instrument, proposal.instrument)];
    }
    if (dec(market.bid).greaterThan(dec(market.ask))) {
      return [violation('MARKET_DATA_UNAVAILABLE', 'context.market', 'cotação cruzada (bid > ask)', `${market.bid}/${market.ask}`)];
    }
    return [];
  },
};

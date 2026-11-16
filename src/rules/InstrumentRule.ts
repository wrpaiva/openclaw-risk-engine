import type { RiskViolationV1 } from '../domain/RiskViolation.js';
import type { RiskRule, RiskRuleInput } from './RiskRule.js';
import { dec, violation } from './ruleSupport.js';

/** Regra 4: instrumento conhecido e permitido; quantidade e preços conformes ao catálogo. */
export const InstrumentRule: RiskRule = {
  id: 'instrument',
  haltOnViolation: true,
  evaluate({ proposal, policy, instrument }: Readonly<RiskRuleInput>): readonly RiskViolationV1[] {
    const out: RiskViolationV1[] = [];
    const notAllowed = (field: string, message: string, observed?: string) =>
      out.push(violation('INSTRUMENT_NOT_ALLOWED', field, message, observed));

    if (instrument.instrument !== proposal.instrument) notAllowed('instrument', 'especificação de catálogo não corresponde ao instrumento', proposal.instrument);
    if (instrument.market !== proposal.market) notAllowed('market', 'mercado diverge do catálogo', proposal.market);
    if (!instrument.enabled) notAllowed('instrument', 'instrumento desabilitado no catálogo', proposal.instrument);
    if (!policy.allowedMarkets.includes(proposal.market)) notAllowed('market', 'mercado não permitido pela política', proposal.market);
    if (!policy.allowedInstruments.includes(proposal.instrument)) notAllowed('instrument', 'instrumento não permitido pela política', proposal.instrument);

    const invalid = (field: string, message: string, observed: string, limit: string) =>
      out.push(violation('INVALID_PROPOSAL', field, message, observed, limit));

    const quantity = dec(proposal.quantity);
    if (quantity.scale() > instrument.quantityScale) {
      invalid('quantity', 'escala da quantidade excede o catálogo', proposal.quantity, `${instrument.quantityScale}`);
    } else if (!quantity.isMultipleOf(dec(instrument.lotSize))) {
      invalid('quantity', 'quantidade não é múltipla do lote', proposal.quantity, instrument.lotSize);
    }
    if (quantity.lessThan(dec(instrument.minQuantity))) {
      invalid('quantity', 'quantidade abaixo do mínimo', proposal.quantity, instrument.minQuantity);
    }

    const tick = dec(instrument.tickSize);
    const prices: [string, string | undefined, boolean][] = [
      ['stopLossPrice', proposal.stopLossPrice, true],
      ['limitPrice', proposal.limitPrice, true],
      // Referência é informativa: apenas a escala é verificada.
      ['referencePrice', proposal.referencePrice, false],
    ];
    for (const [field, raw, requireTick] of prices) {
      if (raw === undefined) continue;
      const price = dec(raw);
      if (price.scale() > instrument.priceScale) {
        invalid(field, 'escala do preço excede o catálogo', raw, `${instrument.priceScale}`);
      } else if (requireTick && !price.isMultipleOf(tick)) {
        invalid(field, 'preço não é múltiplo do tick', raw, instrument.tickSize);
      }
    }
    return out;
  },
};

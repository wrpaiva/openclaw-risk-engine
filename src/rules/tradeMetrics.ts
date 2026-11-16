import type { DecimalAmount } from '../domain/value-objects/DecimalAmount.js';
import type { RiskRuleInput } from './RiskRule.js';
import { dec } from './ruleSupport.js';

export interface TradeMetrics {
  /** Preço de entrada mais desfavorável para a distância até o stop. */
  readonly riskEntryPrice: DecimalAmount;
  /** Preço de entrada mais desfavorável para o valor da ordem. */
  readonly notionalPrice: DecimalAmount;
  /** Taxa moeda de cotação → moeda-base (1 quando iguais). */
  readonly fxRate: DecimalAmount;
  readonly notionalBase: DecimalAmount;
  readonly tradeRiskBase: DecimalAmount;
}

/**
 * Taxa de câmbio exata para a moeda-base, ou `null` se ausente/incompatível.
 * Só aceita a direção cotação → base: nunca inverte taxa nem supõe equivalência entre moedas.
 */
export function fxRateToBase(input: Readonly<RiskRuleInput>): DecimalAmount | null {
  const { instrument, policy, context } = input;
  if (instrument.quoteCurrency === policy.baseCurrency) return dec('1');
  const c = context.conversion;
  if (c?.fromCurrency !== instrument.quoteCurrency || c.toCurrency !== policy.baseCurrency) return null;
  return dec(c.rate);
}

/**
 * Cálculo conservador (SPEC §5, fórmulas conceituais). A referência do agente nunca é usada.
 * - BUY: MARKET entra no ask; LIMIT no limitPrice (teto do preço de execução).
 * - SELL: MARKET sai no bid; LIMIT no limitPrice (piso, pior caso para o stop acima);
 *   para o notional usa max(limitPrice, bid), pois a execução pode ocorrer acima do limite.
 * Custos e slippage não entram: dependem de D-06 (SPEC §12) e não são inventados.
 * Aritmética exata: os produtos cabem na precisão do DecimalAmount, sem arredondamento.
 */
export function computeTradeMetrics(input: Readonly<RiskRuleInput>): TradeMetrics {
  const { proposal, context, instrument } = input;
  const bid = dec(context.market.bid);
  const ask = dec(context.market.ask);
  const limit = proposal.limitPrice === undefined ? undefined : dec(proposal.limitPrice);
  if (proposal.orderType === 'LIMIT' && limit === undefined) throw new Error('LIMIT sem limitPrice');

  let riskEntryPrice: DecimalAmount;
  let notionalPrice: DecimalAmount;
  if (proposal.side === 'BUY') {
    riskEntryPrice = limit ?? ask;
    notionalPrice = riskEntryPrice;
  } else {
    riskEntryPrice = limit ?? bid;
    notionalPrice = limit === undefined ? bid : limit.max(bid);
  }

  const fxRate = fxRateToBase(input);
  if (fxRate === null) throw new Error('câmbio para moeda-base indisponível');

  const quantity = dec(proposal.quantity);
  const multiplier = dec(instrument.contractMultiplier);
  const stop = dec(proposal.stopLossPrice);

  return {
    riskEntryPrice,
    notionalPrice,
    fxRate,
    notionalBase: quantity.times(notionalPrice).times(multiplier).times(fxRate),
    tradeRiskBase: riskEntryPrice.minus(stop).abs().times(quantity).times(multiplier).times(fxRate),
  };
}

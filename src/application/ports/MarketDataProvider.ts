import type { RiskContextV1 } from '../../domain/RiskContext.js';

export type MarketQuote = RiskContextV1['market'];
export type FxRate = NonNullable<RiskContextV1['conversion']>;

/** Fonte confiável de cotação/câmbio (D-03 em aberto). `null` = indisponível, nunca preço inventado. */
export interface MarketDataProvider {
  quote(instrument: string): Promise<MarketQuote | null>;
  fxRate(fromCurrency: string, toCurrency: string): Promise<FxRate | null>;
}

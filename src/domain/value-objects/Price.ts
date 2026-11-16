import { err, ok, type Result } from '../Result.js';
import { DecimalAmount, type DecimalParseError } from './DecimalAmount.js';

export type PriceParseError = DecimalParseError | 'INVALID_CURRENCY';

const CURRENCY = /^[A-Z][A-Z0-9]{2,9}$/;

/** Preço estritamente positivo, com moeda de cotação explícita (ADR-0004). */
export class Price {
  private constructor(
    readonly amount: DecimalAmount,
    readonly currency: string,
  ) {
    Object.freeze(this);
  }

  static parse(raw: string, currency: string, maxScale?: number): Result<Price, PriceParseError> {
    if (!CURRENCY.test(currency)) return err('INVALID_CURRENCY');
    const amount = DecimalAmount.parse(raw, { positive: true, ...(maxScale !== undefined ? { maxScale } : {}) });
    return amount.ok ? ok(new Price(amount.value, currency)) : err(amount.error);
  }

  /** Comparação só é definida na mesma moeda; moedas diferentes exigem conversão explícita. */
  compare(other: Price): -1 | 0 | 1 {
    if (other.currency !== this.currency) {
      throw new TypeError(`comparação entre moedas distintas: ${this.currency} x ${other.currency}`);
    }
    return this.amount.compare(other.amount);
  }

  toString(): string {
    return this.amount.toString();
  }

  toJSON(): string {
    return this.toString();
  }
}

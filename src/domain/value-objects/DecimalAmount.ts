import DecimalJs from 'decimal.js';
import { err, ok, type Result } from '../Result.js';

// Sob NodeNext o .d.ts CJS do decimal.js tipa o default import como namespace,
// mas em ESM o valor em runtime é a própria classe.
type DecimalCtor = typeof DecimalJs.Decimal;
type Decimal = InstanceType<DecimalCtor>;
const Decimal = DecimalJs as unknown as DecimalCtor;

// Precisão ampla o bastante para que soma, subtração e multiplicação de dois valores
// dentro dos tetos técnicos sejam exatas. Divisão/arredondamento terão regra explícita.
const D = Decimal.clone({
  precision: 200,
  rounding: Decimal.ROUND_HALF_EVEN,
  toExpNeg: -9e15,
  toExpPos: 9e15,
});

const CANONICAL = /^-?(0|[1-9]\d*)(\.\d+)?$/;

export interface DecimalParseOptions {
  /** Permite valores negativos (ex.: P&L). Padrão: false. */
  readonly allowNegative?: boolean;
  /** Exige valor estritamente maior que zero. Padrão: false. */
  readonly positive?: boolean;
  /** Escala máxima (casas decimais); limitada por MAX_SCALE. */
  readonly maxScale?: number;
}

export type DecimalParseError =
  | 'NOT_A_STRING'
  | 'MALFORMED'
  | 'NEGATIVE_NOT_ALLOWED'
  | 'NEGATIVE_ZERO'
  | 'NOT_POSITIVE'
  | 'SCALE_EXCEEDED'
  | 'INTEGER_DIGITS_EXCEEDED';

/** Valor decimal exato e imutável. Nunca usar `number` JS em decisões financeiras (ADR-0004). */
export class DecimalAmount {
  /** Tetos técnicos contra overflow; não são limites financeiros. */
  static readonly MAX_INTEGER_DIGITS = 30;
  static readonly MAX_SCALE = 18;

  private constructor(private readonly value: Decimal) {
    Object.freeze(this);
  }

  static parse(raw: string, options: DecimalParseOptions = {}): Result<DecimalAmount, DecimalParseError> {
    const maxScale = options.maxScale ?? DecimalAmount.MAX_SCALE;
    if (!Number.isInteger(maxScale) || maxScale < 0 || maxScale > DecimalAmount.MAX_SCALE) {
      throw new RangeError(`maxScale deve ser inteiro entre 0 e ${DecimalAmount.MAX_SCALE}`);
    }
    if (typeof raw !== 'string') return err('NOT_A_STRING');
    const match = CANONICAL.exec(raw);
    if (!match) return err('MALFORMED');

    const integerPart = match[1] ?? '';
    const fraction = match[2] ?? '';
    const negative = raw.startsWith('-');
    if (integerPart.length > DecimalAmount.MAX_INTEGER_DIGITS) return err('INTEGER_DIGITS_EXCEEDED');
    if (Math.max(fraction.length - 1, 0) > maxScale) return err('SCALE_EXCEEDED');

    const value = new D(raw);
    if (negative && value.isZero()) return err('NEGATIVE_ZERO');
    if (negative && !options.allowNegative) return err('NEGATIVE_NOT_ALLOWED');
    if (options.positive && (value.isZero() || value.isNegative())) return err('NOT_POSITIVE');
    return ok(new DecimalAmount(value));
  }

  plus(other: DecimalAmount): DecimalAmount {
    return new DecimalAmount(this.value.plus(other.value));
  }

  minus(other: DecimalAmount): DecimalAmount {
    return new DecimalAmount(this.value.minus(other.value));
  }

  times(other: DecimalAmount): DecimalAmount {
    return new DecimalAmount(this.value.times(other.value));
  }

  /** Verdadeiro se este valor é múltiplo inteiro de `step` (tick/lote). `step` deve ser positivo. */
  isMultipleOf(step: DecimalAmount): boolean {
    if (!step.value.isPositive() || step.value.isZero()) throw new RangeError('step deve ser positivo');
    return this.value.mod(step.value).isZero();
  }

  /** Número de casas decimais significativas (sem zeros à direita). */
  scale(): number {
    return this.value.decimalPlaces();
  }

  /** Arredonda para longe de zero na escala dada (conservador para valores a reservar). */
  roundUpToScale(scale: number): DecimalAmount {
    if (!Number.isInteger(scale) || scale < 0 || scale > DecimalAmount.MAX_SCALE) {
      throw new RangeError(`scale deve ser inteiro entre 0 e ${DecimalAmount.MAX_SCALE}`);
    }
    return new DecimalAmount(this.value.toDecimalPlaces(scale, Decimal.ROUND_UP));
  }

  max(other: DecimalAmount): DecimalAmount {
    return this.value.greaterThanOrEqualTo(other.value) ? this : other;
  }

  min(other: DecimalAmount): DecimalAmount {
    return this.value.lessThanOrEqualTo(other.value) ? this : other;
  }

  negated(): DecimalAmount {
    return new DecimalAmount(this.value.isZero() ? this.value.abs() : this.value.negated());
  }

  abs(): DecimalAmount {
    return new DecimalAmount(this.value.abs());
  }

  compare(other: DecimalAmount): -1 | 0 | 1 {
    return this.value.comparedTo(other.value) as -1 | 0 | 1;
  }

  equals(other: DecimalAmount): boolean {
    return this.value.equals(other.value);
  }

  greaterThan(other: DecimalAmount): boolean {
    return this.value.greaterThan(other.value);
  }

  lessThan(other: DecimalAmount): boolean {
    return this.value.lessThan(other.value);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isNegative(): boolean {
    return this.value.isNegative() && !this.value.isZero();
  }

  /** Representação canônica, sem notação exponencial. */
  toString(): string {
    return this.value.toFixed();
  }

  toJSON(): string {
    return this.toString();
  }
}

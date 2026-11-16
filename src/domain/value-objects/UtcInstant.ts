import { err, ok, type Result } from '../Result.js';

// ISO-8601 com offset explícito obrigatório e no máximo milissegundos (evita truncamento silencioso).
const ISO_WITH_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/;

export type UtcInstantParseError = 'NOT_A_STRING' | 'MALFORMED' | 'OUT_OF_RANGE';

/** Instante absoluto, imutável, com precisão de milissegundos. */
export class UtcInstant {
  private constructor(private readonly epochMillis: number) {
    Object.freeze(this);
  }

  static parse(raw: string): Result<UtcInstant, UtcInstantParseError> {
    if (typeof raw !== 'string') return err('NOT_A_STRING');
    const m = ISO_WITH_OFFSET.exec(raw);
    if (!m) return err('MALFORMED');

    const [year, month, day, hour, minute, second] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number) as [
      number, number, number, number, number, number,
    ];
    const millis = Number((m[7] ?? '0').padEnd(3, '0'));
    const offsetSign = m[9] === '-' ? -1 : 1;
    const offsetHours = Number(m[10] ?? '0');
    const offsetMinutes = Number(m[11] ?? '0');

    if (year < 1970) return err('OUT_OF_RANGE');
    if (month < 1 || month > 12) return err('OUT_OF_RANGE');
    if (day < 1 || day > daysInMonth(year, month)) return err('OUT_OF_RANGE');
    if (hour > 23 || minute > 59 || second > 59) return err('OUT_OF_RANGE');
    if (offsetHours > 23 || offsetMinutes > 59) return err('OUT_OF_RANGE');

    const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, second, millis);
    const offsetMillis = offsetSign * (offsetHours * 60 + offsetMinutes) * 60_000;
    return ok(new UtcInstant(localAsUtc - offsetMillis));
  }

  static fromEpochMillis(epochMillis: number): UtcInstant {
    if (!Number.isSafeInteger(epochMillis)) throw new RangeError('epochMillis deve ser inteiro seguro');
    return new UtcInstant(epochMillis);
  }

  toEpochMillis(): number {
    return this.epochMillis;
  }

  isBefore(other: UtcInstant): boolean {
    return this.epochMillis < other.epochMillis;
  }

  isAfter(other: UtcInstant): boolean {
    return this.epochMillis > other.epochMillis;
  }

  equals(other: UtcInstant): boolean {
    return this.epochMillis === other.epochMillis;
  }

  millisSince(earlier: UtcInstant): number {
    return this.epochMillis - earlier.epochMillis;
  }

  plusMillis(millis: number): UtcInstant {
    return UtcInstant.fromEpochMillis(this.epochMillis + millis);
  }

  toISOString(): string {
    return new Date(this.epochMillis).toISOString();
  }

  toJSON(): string {
    return this.toISOString();
  }
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

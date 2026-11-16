import type { LogFields, Logger } from '../../application/ports/Logger.js';

export type LogLevel = 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { info: 20, warn: 30, error: 40 };
const MAX_STRING = 200;
const MAX_ARRAY = 50;

export interface LogStream {
  write(line: string): unknown;
}

const ALLOWED: readonly (keyof LogFields)[] = [
  'requestId', 'correlationId', 'proposalId', 'decisionId', 'reservationId', 'principalId',
  'accountId', 'route', 'httpStatus', 'outcome', 'violationCodes', 'errorKind', 'durationMs',
  'op', 'kind', 'count', 'bindScope', 'transport',
];

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]', 'g');

function clean(value: string): string {
  const truncated = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}...` : value;
  // Controles C0/C1, DEL e separadores de linha Unicode viram escapes \\uXXXX.
  return truncated.replace(CONTROL_CHARS, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** JSON lines com allowlist de campos; falha de escrita nunca afeta a decisão. */
export class JsonLogger implements Logger {
  constructor(
    private readonly level: LogLevel,
    private readonly stream: LogStream = process.stdout,
    private readonly now: () => Date = () => new Date(),
  ) {}

  info(event: string, fields?: LogFields): void {
    this.emit('info', event, fields);
  }
  warn(event: string, fields?: LogFields): void {
    this.emit('warn', event, fields);
  }
  error(event: string, fields?: LogFields): void {
    this.emit('error', event, fields);
  }

  private emit(level: LogLevel, event: string, fields: LogFields | undefined): void {
    if (ORDER[level] < ORDER[this.level]) return;
    try {
      const record: Record<string, unknown> = { time: this.now().toISOString(), level, event: clean(event) };
      const source = (fields ?? {}) as Record<string, unknown>;
      for (const key of ALLOWED) {
        const value = source[key];
        if (typeof value === 'string') record[key] = clean(value);
        else if (typeof value === 'number' && Number.isFinite(value)) record[key] = value;
        else if (Array.isArray(value)) record[key] = value.slice(0, MAX_ARRAY).filter((v): v is string => typeof v === 'string').map(clean);
      }
      this.stream.write(`${JSON.stringify(record)}\n`);
    } catch {
      // Logging nunca derruba nem altera o fluxo de risco.
    }
  }
}

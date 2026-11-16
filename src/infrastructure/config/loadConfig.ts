import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { LogLevel } from '../logging/JsonLogger.js';
import { BIND_SCOPES, PLAINTEXT_ENCRYPTED_OVERLAY, resolveBind, type BindScope, type HttpTransport } from './httpBind.js';

// Único módulo autorizado a ler process.env (via main). Recebe o ambiente como argumento para ser testável.

// Cópia do padrão de tests/unit/architecture/boundaries.test.ts (ADR-0010): nomes que sugerem
// credenciais de exchange/corretora impedem o boot.
const FORBIDDEN_CREDENTIAL_NAME = new RegExp(
  [
    'API_?KEY', 'API_?SECRET', 'SECRET', 'PRIVATE_?KEY', 'ACCESS_?KEY', 'PASSPHRASE', 'BROKER', 'EXCHANGE',
    'BINANCE', 'COINBASE', 'KRAKEN', 'BYBIT', 'BITFINEX', 'BITSTAMP', 'KUCOIN', 'OKX', 'ALPACA', 'IBKR', 'OANDA', 'TRADIER',
    '_KEY$', '_PASSWORD$', '_TOKEN$',
  ].join('|'),
  'i',
);

export interface RiskConfig {
  readonly environment: 'PAPER';
  readonly databaseUrl: string;
  readonly logLevel: LogLevel;
  readonly clockSkewToleranceMs: number;
  readonly db: { readonly connectionTimeoutMs: number; readonly statementTimeoutMs: number; readonly lockTimeoutMs: number };
  readonly http:
    | { readonly enabled: false }
    | {
        readonly enabled: true;
        readonly host: string;
        readonly bindScope: BindScope;
        readonly transport: HttpTransport | null;
        readonly port: number;
        readonly maxBodyBytes: number;
        readonly requestTimeoutMs: number;
        readonly headersTimeoutMs: number;
        readonly principalsFile: string;
      };
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

const positiveInt = z.string().regex(/^[1-9][0-9]{0,9}$/).transform(Number);
const nonNegativeInt = z.string().regex(/^(0|[1-9][0-9]{0,9})$/).transform(Number);

const baseSchema = z.object({
  RISK_ENVIRONMENT: z.literal('PAPER'),
  RISK_DATABASE_URL: z.string().min(1).optional(),
  RISK_DATABASE_URL_FILE: z.string().min(1).optional(),
  RISK_LOG_LEVEL: z.enum(['info', 'warn', 'error']),
  RISK_HTTP_ENABLED: z.enum(['true', 'false']),
  RISK_CLOCK_SKEW_TOLERANCE_MS: nonNegativeInt,
  RISK_DB_CONNECTION_TIMEOUT_MS: positiveInt,
  RISK_DB_STATEMENT_TIMEOUT_MS: positiveInt,
  RISK_DB_LOCK_TIMEOUT_MS: positiveInt,
});

const httpSchema = z.object({
  RISK_HTTP_HOST: z.string().min(1),
  RISK_HTTP_PORT: positiveInt.refine((p) => p <= 65535),
  RISK_HTTP_MAX_BODY_BYTES: positiveInt,
  RISK_HTTP_REQUEST_TIMEOUT_MS: positiveInt,
  RISK_HTTP_HEADERS_TIMEOUT_MS: positiveInt,
  RISK_PRINCIPALS_FILE: z.string().min(1),
});

/** ADR-0011: escopo de bind e declaração explícita do transporte. Mensagens fixas, sem o valor recebido. */
function resolveScopeAndTransport(env: Readonly<Record<string, string | undefined>>): { bindScope: BindScope; transport: HttpTransport | null } {
  const rawScope = env['RISK_HTTP_BIND_SCOPE'];
  const rawTransport = env['RISK_HTTP_TRANSPORT'];
  let bindScope: BindScope = 'loopback';
  if (rawScope !== undefined) {
    const found = BIND_SCOPES.find((s) => s === rawScope);
    if (found === undefined) throw new ConfigError('RISK_HTTP_BIND_SCOPE: valor inválido');
    bindScope = found;
  }
  if (rawTransport !== undefined && rawTransport !== PLAINTEXT_ENCRYPTED_OVERLAY) throw new ConfigError('RISK_HTTP_TRANSPORT: valor inválido');
  if (bindScope === 'private-network' && rawTransport === undefined) {
    throw new ConfigError(`RISK_HTTP_BIND_SCOPE=private-network exige RISK_HTTP_TRANSPORT=${PLAINTEXT_ENCRYPTED_OVERLAY} (ADR-0011)`);
  }
  if (bindScope === 'loopback' && rawTransport !== undefined) {
    throw new ConfigError('RISK_HTTP_TRANSPORT só é permitido com RISK_HTTP_BIND_SCOPE=private-network');
  }
  return { bindScope, transport: rawTransport === undefined ? null : PLAINTEXT_ENCRYPTED_OVERLAY };
}

export type SecretFileReader = (path: string) => string;

const defaultReader: SecretFileReader = (path) => readFileSync(path, 'utf8');

/**
 * Resolve um segredo de variável direta OU de arquivo (exatamente um). Mensagens citam só nomes de variáveis;
 * nunca o caminho, o conteúdo nem a mensagem do erro de leitura.
 */
function resolveSecret(direct: string | undefined, file: string | undefined, name: string, read: SecretFileReader): string {
  if (direct !== undefined && file !== undefined) throw new ConfigError(`${name} e ${name}_FILE são mutuamente exclusivos`);
  if (direct === undefined && file === undefined) throw new ConfigError(`${name} ou ${name}_FILE é obrigatório`);
  if (direct !== undefined) return direct;
  let content: string;
  try {
    content = read(file as string);
  } catch {
    throw new ConfigError(`${name}_FILE: arquivo ilegível`);
  }
  // Segredos em arquivo costumam terminar com quebra de linha.
  const value = content.replace(/[\r\n]+$/, '');
  if (value === '' || /[\r\n]/.test(value)) throw new ConfigError(`${name}_FILE: conteúdo inválido`);
  return value;
}

function rejectForbiddenNames(env: Readonly<Record<string, string | undefined>>): void {
  const offending = Object.keys(env).filter((name) => FORBIDDEN_CREDENTIAL_NAME.test(name));
  if (offending.length > 0) throw new ConfigError('ambiente contém variáveis com padrão de credencial de exchange/corretora');
}

const MIGRATION_VARS = ['RISK_MIGRATION_DATABASE_URL', 'RISK_MIGRATION_DATABASE_URL_FILE'] as const;

export interface MigrationConfig {
  readonly environment: 'PAPER';
  readonly databaseUrl: string;
  /** Mesmas variáveis do runtime (sem valor novo): a credencial de migração também nunca fica sem prazo. */
  readonly db: { readonly connectionTimeoutMs: number; readonly statementTimeoutMs: number; readonly lockTimeoutMs: number };
}

const migrationTimeoutsSchema = z.object({
  RISK_DB_CONNECTION_TIMEOUT_MS: positiveInt,
  RISK_DB_STATEMENT_TIMEOUT_MS: positiveInt,
  RISK_DB_LOCK_TIMEOUT_MS: positiveInt,
});

/** Config exclusiva da CLI de migração (credencial do dono do schema). Nunca usada pelo servidor. */
export function loadMigrationConfig(
  env: Readonly<Record<string, string | undefined>>,
  readSecretFile: SecretFileReader = defaultReader,
): MigrationConfig {
  rejectForbiddenNames(env);
  if (env['RISK_ENVIRONMENT'] !== 'PAPER') throw new ConfigError('configuração inválida: RISK_ENVIRONMENT');
  const direct = env['RISK_MIGRATION_DATABASE_URL'];
  const file = env['RISK_MIGRATION_DATABASE_URL_FILE'];
  const url = resolveSecret(direct === '' ? undefined : direct, file === '' ? undefined : file, 'RISK_MIGRATION_DATABASE_URL', readSecretFile);
  const timeouts = migrationTimeoutsSchema.safeParse(env);
  if (!timeouts.success) throw new ConfigError(`configuração inválida: ${fieldsOf(timeouts.error)}`);
  return {
    environment: 'PAPER',
    databaseUrl: url,
    db: {
      connectionTimeoutMs: timeouts.data.RISK_DB_CONNECTION_TIMEOUT_MS,
      statementTimeoutMs: timeouts.data.RISK_DB_STATEMENT_TIMEOUT_MS,
      lockTimeoutMs: timeouts.data.RISK_DB_LOCK_TIMEOUT_MS,
    },
  };
}

/** Falha fechado; mensagens citam apenas nomes de variáveis, nunca valores. */
export function loadConfig(env: Readonly<Record<string, string | undefined>>, readSecretFile: SecretFileReader = defaultReader): RiskConfig {
  rejectForbiddenNames(env);
  // A credencial de migração (dona do schema) nunca pode estar no ambiente do runtime.
  if (MIGRATION_VARS.some((name) => env[name] !== undefined)) {
    throw new ConfigError('credencial de migração não pertence ao ambiente de runtime');
  }

  const base = baseSchema.safeParse(env);
  if (!base.success) throw new ConfigError(`configuração inválida: ${fieldsOf(base.error)}`);

  const databaseUrl = resolveSecret(base.data.RISK_DATABASE_URL, base.data.RISK_DATABASE_URL_FILE, 'RISK_DATABASE_URL', readSecretFile);
  const common = {
    environment: 'PAPER' as const,
    databaseUrl,
    logLevel: base.data.RISK_LOG_LEVEL,
    clockSkewToleranceMs: base.data.RISK_CLOCK_SKEW_TOLERANCE_MS,
    db: {
      connectionTimeoutMs: base.data.RISK_DB_CONNECTION_TIMEOUT_MS,
      statementTimeoutMs: base.data.RISK_DB_STATEMENT_TIMEOUT_MS,
      lockTimeoutMs: base.data.RISK_DB_LOCK_TIMEOUT_MS,
    },
  };
  const { bindScope, transport } = resolveScopeAndTransport(env);
  if (base.data.RISK_HTTP_ENABLED === 'false') return { ...common, http: { enabled: false } };

  const http = httpSchema.safeParse(env);
  if (!http.success) throw new ConfigError(`configuração HTTP inválida: ${fieldsOf(http.error)}`);
  const hostError = resolveBind(bindScope, http.data.RISK_HTTP_HOST);
  if (hostError !== null) throw new ConfigError(hostError);
  if (http.data.RISK_HTTP_HEADERS_TIMEOUT_MS > http.data.RISK_HTTP_REQUEST_TIMEOUT_MS) {
    throw new ConfigError('RISK_HTTP_HEADERS_TIMEOUT_MS não pode exceder RISK_HTTP_REQUEST_TIMEOUT_MS');
  }
  return {
    ...common,
    http: {
      enabled: true,
      host: http.data.RISK_HTTP_HOST,
      bindScope,
      transport,
      port: http.data.RISK_HTTP_PORT,
      maxBodyBytes: http.data.RISK_HTTP_MAX_BODY_BYTES,
      requestTimeoutMs: http.data.RISK_HTTP_REQUEST_TIMEOUT_MS,
      headersTimeoutMs: http.data.RISK_HTTP_HEADERS_TIMEOUT_MS,
      principalsFile: http.data.RISK_PRINCIPALS_FILE,
    },
  };
}

function fieldsOf(error: z.ZodError): string {
  return [...new Set(error.issues.map((i) => String(i.path[0] ?? '?')))].join(', ');
}

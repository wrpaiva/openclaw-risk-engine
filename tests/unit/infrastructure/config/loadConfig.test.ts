import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../../../src/infrastructure/config/loadConfig.js';

// Valores FICTÍCIOS de teste; não representam configuração aprovada.
const BASE = {
  RISK_ENVIRONMENT: 'PAPER',
  RISK_DATABASE_URL: 'postgres://fixture@127.0.0.1:55432/openclaw_risk_test',
  RISK_LOG_LEVEL: 'info',
  RISK_HTTP_ENABLED: 'false',
  RISK_CLOCK_SKEW_TOLERANCE_MS: '1000',
  RISK_DB_CONNECTION_TIMEOUT_MS: '2000',
  RISK_DB_STATEMENT_TIMEOUT_MS: '4000',
  RISK_DB_LOCK_TIMEOUT_MS: '3000',
};
const HTTP = {
  ...BASE,
  RISK_HTTP_ENABLED: 'true',
  RISK_HTTP_HOST: '127.0.0.1',
  RISK_HTTP_PORT: '8080',
  RISK_HTTP_MAX_BODY_BYTES: '65536',
  RISK_HTTP_REQUEST_TIMEOUT_MS: '5000',
  RISK_HTTP_HEADERS_TIMEOUT_MS: '3000',
  RISK_PRINCIPALS_FILE: '/fixture/principals.json',
};
const without = (env: Record<string, string>, k: string) => {
  const { [k]: _omit, ...rest } = env;
  return rest;
};

describe('loadConfig', () => {
  it('ambiente completo sem HTTP', () => {
    expect(loadConfig(BASE)).toEqual({
      environment: 'PAPER',
      databaseUrl: BASE.RISK_DATABASE_URL,
      logLevel: 'info',
      clockSkewToleranceMs: 1000,
      db: { connectionTimeoutMs: 2000, statementTimeoutMs: 4000, lockTimeoutMs: 3000 },
      http: { enabled: false },
    });
  });

  it('ambiente completo com HTTP', () => {
    expect(loadConfig(HTTP).http).toEqual({
      enabled: true,
      host: '127.0.0.1',
      bindScope: 'loopback',
      transport: null,
      port: 8080,
      maxBodyBytes: 65536,
      requestTimeoutMs: 5000,
      headersTimeoutMs: 3000,
      principalsFile: '/fixture/principals.json',
    });
  });

  it('variáveis HTTP não são exigidas com RISK_HTTP_ENABLED=false', () => {
    expect(() => loadConfig(BASE)).not.toThrow();
  });

  it.each(['RISK_HTTP_HOST', 'RISK_HTTP_PORT', 'RISK_HTTP_MAX_BODY_BYTES', 'RISK_HTTP_REQUEST_TIMEOUT_MS', 'RISK_HTTP_HEADERS_TIMEOUT_MS', 'RISK_PRINCIPALS_FILE'])(
    'HTTP habilitado sem %s falha',
    (k) => {
      expect(() => loadConfig(without(HTTP, k))).toThrow(ConfigError);
    },
  );

  it.each(['RISK_ENVIRONMENT', 'RISK_DATABASE_URL', 'RISK_LOG_LEVEL', 'RISK_HTTP_ENABLED', 'RISK_CLOCK_SKEW_TOLERANCE_MS', 'RISK_DB_CONNECTION_TIMEOUT_MS', 'RISK_DB_STATEMENT_TIMEOUT_MS', 'RISK_DB_LOCK_TIMEOUT_MS'])(
    'sem %s falha (sem default)',
    (k) => {
      expect(() => loadConfig(without(BASE, k))).toThrow(ConfigError);
    },
  );

  it.each(['LIVE', 'paper', 'PRODUCTION', ''])('RISK_ENVIRONMENT=%j é rejeitado', (v) => {
    expect(() => loadConfig({ ...BASE, RISK_ENVIRONMENT: v })).toThrow(ConfigError);
  });

  it('RISK_HTTP_ENABLED e RISK_LOG_LEVEL fora do enum', () => {
    expect(() => loadConfig({ ...BASE, RISK_HTTP_ENABLED: 'TRUE' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...BASE, RISK_LOG_LEVEL: 'trace' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...BASE, RISK_LOG_LEVEL: 'debug' })).toThrow(ConfigError);
  });

  it.each(['0.0.0.0', '::', '[::]', '0:0:0:0:0:0:0:0', '0', '0.0.0.00', '::0', 'localhost', '10.0.0.1', '192.168.1.1', '127.0.0.1.5', '127.0.0.01', 'example.com', '::2', '0::', '[::1]', '8.8.8.8', ' 127.0.0.1', '127.0.0.1 '])(
    'host %s é rejeitado (só IP de loopback)',
    (h) => {
      expect(() => loadConfig({ ...HTTP, RISK_HTTP_HOST: h })).toThrow(ConfigError);
    },
  );

  it.each(['127.0.0.1', '127.5.5.5', '::1', '0:0:0:0:0:0:0:1'])('host loopback %s é aceito', (h) => {
    expect(loadConfig({ ...HTTP, RISK_HTTP_HOST: h }).http).toMatchObject({ enabled: true, host: h });
  });

  it('headersTimeout acima do requestTimeout é rejeitado; igual é aceito', () => {
    expect(() => loadConfig({ ...HTTP, RISK_HTTP_HEADERS_TIMEOUT_MS: '5001' })).toThrow(ConfigError);
    expect(loadConfig({ ...HTTP, RISK_HTTP_HEADERS_TIMEOUT_MS: '5000' }).http).toMatchObject({ headersTimeoutMs: 5000 });
  });

  it.each(['RISK_DB_CONNECTION_TIMEOUT_MS', 'RISK_DB_STATEMENT_TIMEOUT_MS', 'RISK_DB_LOCK_TIMEOUT_MS'])('%s rejeita zero, exponencial e inválidos', (k) => {
    for (const v of ['0', '1e3', '-1', '1.5', '', ' 5']) {
      expect(() => loadConfig({ ...BASE, [k]: v }), `${k}=${JSON.stringify(v)}`).toThrow(ConfigError);
    }
  });

  it.each(['RISK_HTTP_PORT', 'RISK_HTTP_MAX_BODY_BYTES', 'RISK_HTTP_REQUEST_TIMEOUT_MS', 'RISK_HTTP_HEADERS_TIMEOUT_MS'])(
    '%s rejeita zero, exponencial, negativo, decimal, vazio e espaços',
    (k) => {
      for (const v of ['0', '1e3', '1E3', '-1', '1.5', '', ' 5', '5 ', '+5', '0x10', '00', '01']) {
        expect(() => loadConfig({ ...HTTP, [k]: v }), `${k}=${JSON.stringify(v)}`).toThrow(ConfigError);
      }
    },
  );

  it('RISK_CLOCK_SKEW_TOLERANCE_MS: zero é aceito; exponencial e inválidos não; sempre obrigatório', () => {
    expect(loadConfig({ ...BASE, RISK_CLOCK_SKEW_TOLERANCE_MS: '0' }).clockSkewToleranceMs).toBe(0);
    for (const v of ['1e3', '-1', '1.5', '', ' 1', '00']) {
      expect(() => loadConfig({ ...BASE, RISK_CLOCK_SKEW_TOLERANCE_MS: v }), v).toThrow(ConfigError);
    }
    expect(() => loadConfig(without(HTTP, 'RISK_CLOCK_SKEW_TOLERANCE_MS'))).toThrow(ConfigError);
  });

  it.each([['1', true], ['65535', true], ['65536', false], ['99999', false]])('porta %s', (p, ok) => {
    const run = () => loadConfig({ ...HTTP, RISK_HTTP_PORT: p });
    if (ok) expect(run().http).toMatchObject({ port: Number(p) });
    else expect(run).toThrow(ConfigError);
  });

  it.each(['BINANCE_API_KEY', 'EXCHANGE_URL', 'BROKER_TOKEN', 'MY_SECRET', 'api_secret', 'IBKR_PASSPHRASE', 'RISK_EXCHANGE_X', 'OANDA_ACCOUNT', 'ALPACA_URL', 'SOME_API_KEY', 'MY_PRIVATE_KEY', 'DB_PASSWORD', 'GITHUB_TOKEN', 'X_ACCESS_KEY'])(
    'env com nome de credencial %s impede o boot',
    (name) => {
      expect(() => loadConfig({ ...BASE, [name]: 'x' })).toThrow(ConfigError);
    },
  );

  it('mensagens citam nomes de variáveis, nunca valores', () => {
    const url = 'postgres://user:senha-fixture@127.0.0.1/x';
    for (const env of [{ ...BASE, RISK_DATABASE_URL: url, RISK_ENVIRONMENT: 'LIVE' }, { ...BASE, MY_SECRET: 'valor-secreto' }, { ...HTTP, RISK_HTTP_PORT: 'valor-ruim' }]) {
      try {
        loadConfig(env);
        expect.unreachable();
      } catch (e) {
        const m = (e as Error).message;
        expect(m).not.toContain('senha-fixture');
        expect(m).not.toContain('valor-secreto');
        expect(m).not.toContain('valor-ruim');
      }
    }
  });
});

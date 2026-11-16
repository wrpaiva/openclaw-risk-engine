import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../../../src/infrastructure/config/loadConfig.js';
import { healthProbeHost, isAcceptedWildcard, isLoopbackIp, resolveBind } from '../../../../src/infrastructure/config/httpBind.js';

// ADR-0011 (O2), plano §1. Valores FICTÍCIOS; não representam configuração aprovada.
const BASE = {
  RISK_ENVIRONMENT: 'PAPER',
  RISK_DATABASE_URL: 'postgres://fixture:senha-fixture-zz9@127.0.0.1:55432/openclaw_risk_test',
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
const OVERLAY = 'plaintext-encrypted-overlay';
const E_SCOPE = 'RISK_HTTP_BIND_SCOPE: valor inválido';
const E_TRANSPORT = 'RISK_HTTP_TRANSPORT: valor inválido';
const E_NEEDS = `RISK_HTTP_BIND_SCOPE=private-network exige RISK_HTTP_TRANSPORT=${OVERLAY} (ADR-0011)`;
const E_LOOP_TRANSPORT = 'RISK_HTTP_TRANSPORT só é permitido com RISK_HTTP_BIND_SCOPE=private-network';
const E_LOOP_HOST = 'RISK_HTTP_HOST: escopo loopback aceita só IP de loopback';
const E_PRIV_HOST = 'RISK_HTTP_HOST: escopo private-network aceita só 0.0.0.0';

const PRIVATE = { ...HTTP, RISK_HTTP_BIND_SCOPE: 'private-network', RISK_HTTP_TRANSPORT: OVERLAY, RISK_HTTP_HOST: '0.0.0.0' };

function errorOf(env: Record<string, string | undefined>): ConfigError {
  try {
    loadConfig(env);
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return e as ConfigError;
  }
  throw new Error('esperava ConfigError, mas loadConfig aceitou');
}
const messageOf = (env: Record<string, string | undefined>): string => errorOf(env).message;

describe('matriz do plano §1: ENABLED x SCOPE x TRANSPORT x HOST', () => {
  it('HTTP desligado, escopo ausente/válido e transporte coerente → ok, http.enabled=false', () => {
    expect(loadConfig(BASE).http).toEqual({ enabled: false });
    expect(loadConfig({ ...BASE, RISK_HTTP_BIND_SCOPE: 'loopback' }).http).toEqual({ enabled: false });
    expect(loadConfig({ ...BASE, RISK_HTTP_BIND_SCOPE: 'private-network', RISK_HTTP_TRANSPORT: OVERLAY }).http).toEqual({ enabled: false });
    // host irrelevante com HTTP desligado
    expect(loadConfig({ ...BASE, RISK_HTTP_HOST: '0.0.0.0' }).http).toEqual({ enabled: false });
  });

  it.each([false, true])('escopo inválido (HTTP %s) → mensagem fixa', (enabled) => {
    const env = { ...(enabled ? HTTP : BASE), RISK_HTTP_BIND_SCOPE: 'public' };
    expect(messageOf(env)).toBe(E_SCOPE);
  });

  it.each([false, true])('transporte presente e diferente do literal (HTTP %s) → mensagem fixa', (enabled) => {
    expect(messageOf({ ...(enabled ? HTTP : BASE), RISK_HTTP_TRANSPORT: 'tls' })).toBe(E_TRANSPORT);
    expect(messageOf({ ...(enabled ? PRIVATE : BASE), RISK_HTTP_BIND_SCOPE: 'private-network', RISK_HTTP_TRANSPORT: 'true' })).toBe(E_TRANSPORT);
  });

  it.each([false, true])('private-network sem transporte (HTTP %s) → exige transporte', (enabled) => {
    const env = { ...(enabled ? HTTP : BASE), RISK_HTTP_BIND_SCOPE: 'private-network', ...(enabled ? { RISK_HTTP_HOST: '0.0.0.0' } : {}) };
    expect(messageOf(env)).toBe(E_NEEDS);
  });

  it.each([false, true])('loopback (explícito ou ausente) com transporte (HTTP %s) → rejeitado por ambiguidade', (enabled) => {
    const b = enabled ? HTTP : BASE;
    expect(messageOf({ ...b, RISK_HTTP_TRANSPORT: OVERLAY })).toBe(E_LOOP_TRANSPORT);
    expect(messageOf({ ...b, RISK_HTTP_BIND_SCOPE: 'loopback', RISK_HTTP_TRANSPORT: OVERLAY })).toBe(E_LOOP_TRANSPORT);
  });

  it.each(['127.0.0.1', '127.5.5.5', '127.255.255.254', '::1'])('loopback com host %s → ok', (host) => {
    const http = loadConfig({ ...HTTP, RISK_HTTP_HOST: host }).http;
    expect(http).toMatchObject({ enabled: true, host, bindScope: 'loopback', transport: null });
  });

  it.each(['0.0.0.0', '::', '192.168.1.10', '10.0.0.5', '8.8.8.8', 'localhost', 'example.test', '128.0.0.1', '126.255.255.255', '127.0.0.1.1', '127.1', '0127.0.0.1', '127.000.000.001', '::ffff:127.0.0.1', '::1%lo', '127.0.0.1\0', '0.0.0.0\0'])(
    'loopback com host %s → rejeitado',
    (host) => {
      expect(messageOf({ ...HTTP, RISK_HTTP_HOST: host })).toBe(E_LOOP_HOST);
      expect(messageOf({ ...HTTP, RISK_HTTP_BIND_SCOPE: 'loopback', RISK_HTTP_HOST: host })).toBe(E_LOOP_HOST);
    },
  );

  it('private-network + transporte + 0.0.0.0 → ok, com bindScope e transport', () => {
    expect(loadConfig(PRIVATE).http).toEqual({
      enabled: true,
      host: '0.0.0.0',
      bindScope: 'private-network',
      transport: OVERLAY,
      port: 8080,
      maxBodyBytes: 65536,
      requestTimeoutMs: 5000,
      headersTimeoutMs: 3000,
      principalsFile: '/fixture/principals.json',
    });
  });

  it.each(['127.0.0.1', '::1', '::', '192.168.1.10', '10.0.0.5', 'localhost', 'example.test', '0.0.0.1', '0.0.0.0 ', ' 0.0.0.0', '0.0.0.0/0', '255.255.255.255', '127.0.0.1\0', '0.0.0.0\0', '::ffff:0.0.0.0', '::ffff:127.0.0.1'])(
    'private-network com host %j → rejeitado',
    (host) => {
      expect(messageOf({ ...PRIVATE, RISK_HTTP_HOST: host })).toBe(E_PRIV_HOST);
    },
  );

  it.each(['0', '0.0.0.00', '00.0.0.0', '0.0.0', '::', '::0', '[::]', '0:0:0:0:0:0:0:0', '0000:0000:0000:0000:0000:0000:0000:0000', '::ffff:0.0.0.0', '0x0.0.0.0', '0.0.0.0.'])(
    'variante de curinga %j em private-network → rejeitada (só a grafia canônica)',
    (host) => {
      expect(messageOf({ ...PRIVATE, RISK_HTTP_HOST: host })).toBe(E_PRIV_HOST);
      expect(isAcceptedWildcard(host)).toBe(false);
    },
  );

  it.each(['0', '0.0.0.00', '::', '::0', '[::]', '0:0:0:0:0:0:0:0'])('variante de curinga %j em loopback → rejeitada', (host) => {
    expect(messageOf({ ...HTTP, RISK_HTTP_HOST: host })).toBe(E_LOOP_HOST);
  });

  it('host vazio é rejeitado pelo schema HTTP (sem vazar valor) nos dois escopos', () => {
    expect(messageOf({ ...HTTP, RISK_HTTP_HOST: '' })).toMatch(/^configuração HTTP inválida: RISK_HTTP_HOST$/);
    expect(messageOf({ ...PRIVATE, RISK_HTTP_HOST: '' })).toMatch(/^configuração HTTP inválida: RISK_HTTP_HOST$/);
  });
});

describe('caixa, espaços e vazio em SCOPE e TRANSPORT (sem normalização)', () => {
  it.each(['Loopback', 'LOOPBACK', 'Private-Network', 'PRIVATE-NETWORK', ' loopback', 'loopback ', ' private-network ', 'private-network\n', 'private_network', ''])('SCOPE %j → inválido', (v) => {
    expect(messageOf({ ...PRIVATE, RISK_HTTP_BIND_SCOPE: v })).toBe(E_SCOPE);
    expect(messageOf({ ...HTTP, RISK_HTTP_BIND_SCOPE: v })).toBe(E_SCOPE);
    expect(messageOf({ ...BASE, RISK_HTTP_BIND_SCOPE: v })).toBe(E_SCOPE);
  });

  it.each(['Plaintext-Encrypted-Overlay', 'PLAINTEXT-ENCRYPTED-OVERLAY', ` ${OVERLAY}`, `${OVERLAY} `, `${OVERLAY}\n`, 'plaintext', 'true', '1', ''])('TRANSPORT %j → inválido', (v) => {
    expect(messageOf({ ...PRIVATE, RISK_HTTP_TRANSPORT: v })).toBe(E_TRANSPORT);
    expect(messageOf({ ...HTTP, RISK_HTTP_TRANSPORT: v })).toBe(E_TRANSPORT);
    expect(messageOf({ ...BASE, RISK_HTTP_TRANSPORT: v })).toBe(E_TRANSPORT);
  });

  it('TRANSPORT vazio em private-network é inválido (não equivale a ausente)', () => {
    expect(messageOf({ ...PRIVATE, RISK_HTTP_TRANSPORT: '' })).toBe(E_TRANSPORT);
  });

  it('chaves com undefined explícito equivalem a ausentes', () => {
    expect(loadConfig({ ...HTTP, RISK_HTTP_BIND_SCOPE: undefined, RISK_HTTP_TRANSPORT: undefined }).http).toMatchObject({ bindScope: 'loopback', transport: null });
  });
});

describe('não vaza o valor recebido', () => {
  const SENTINEL = 'VALOR-SENTINELA-ZZ9';
  it.each([
    ['RISK_HTTP_BIND_SCOPE', { ...HTTP, RISK_HTTP_BIND_SCOPE: SENTINEL }],
    ['RISK_HTTP_TRANSPORT', { ...HTTP, RISK_HTTP_TRANSPORT: SENTINEL }],
    ['RISK_HTTP_HOST loopback', { ...HTTP, RISK_HTTP_HOST: SENTINEL }],
    ['RISK_HTTP_HOST private', { ...PRIVATE, RISK_HTTP_HOST: SENTINEL }],
    ['SCOPE com HTTP desligado', { ...BASE, RISK_HTTP_BIND_SCOPE: SENTINEL }],
  ])('%s', (_name, env) => {
    const err = errorOf(env);
    expect(err.message).not.toContain(SENTINEL);
    expect((err.stack ?? '')).not.toContain(SENTINEL);
    expect(err.message).not.toContain('senha-fixture-zz9');
  });

  it('o erro de escopo prevalece e não cita o host nem a URL do banco', () => {
    const err = errorOf({ ...HTTP, RISK_HTTP_BIND_SCOPE: 'x', RISK_HTTP_HOST: '10.9.8.7' });
    expect(err.message).toBe(E_SCOPE);
    expect(err.message).not.toContain('10.9.8.7');
  });
});

describe('ordem de validação', () => {
  it('nomes proibidos e credencial de migração vêm antes do escopo', () => {
    expect(messageOf({ ...HTTP, RISK_HTTP_BIND_SCOPE: 'x', BINANCE_API_KEY: 'a' })).toMatch(/credencial de exchange/);
    expect(messageOf({ ...HTTP, RISK_HTTP_BIND_SCOPE: 'x', RISK_MIGRATION_DATABASE_URL: 'a' })).toMatch(/credencial de migração/);
  });

  it('schema base inválido vem antes do escopo', () => {
    expect(messageOf({ ...HTTP, RISK_ENVIRONMENT: 'LIVE', RISK_HTTP_BIND_SCOPE: 'x' })).toMatch(/^configuração inválida: RISK_ENVIRONMENT$/);
  });

  it('escopo/transporte vêm antes do schema HTTP, mesmo com campos HTTP ausentes', () => {
    expect(messageOf({ ...BASE, RISK_HTTP_ENABLED: 'true', RISK_HTTP_BIND_SCOPE: 'private-network' })).toBe(E_NEEDS);
    expect(messageOf({ ...BASE, RISK_HTTP_ENABLED: 'true', RISK_HTTP_BIND_SCOPE: 'x' })).toBe(E_SCOPE);
  });

  it('schema HTTP vem antes da validação do host por escopo', () => {
    const { RISK_HTTP_PORT: _p, ...semPorta } = PRIVATE;
    expect(messageOf({ ...semPorta, RISK_HTTP_HOST: '127.0.0.1' })).toMatch(/^configuração HTTP inválida: RISK_HTTP_PORT$/);
  });

  it('host por escopo vem antes da regra de headers <= request', () => {
    expect(messageOf({ ...PRIVATE, RISK_HTTP_HOST: '10.0.0.5', RISK_HTTP_HEADERS_TIMEOUT_MS: '9000' })).toBe(E_PRIV_HOST);
    expect(messageOf({ ...PRIVATE, RISK_HTTP_HEADERS_TIMEOUT_MS: '9000' })).toMatch(/RISK_HTTP_HEADERS_TIMEOUT_MS/);
  });
});

describe('default e campos retornados', () => {
  it('escopo ausente → loopback com transport null; explícito idem', () => {
    expect(loadConfig(HTTP).http).toMatchObject({ bindScope: 'loopback', transport: null });
    expect(loadConfig({ ...HTTP, RISK_HTTP_BIND_SCOPE: 'loopback' }).http).toMatchObject({ bindScope: 'loopback', transport: null });
  });

  it('com HTTP desligado, o objeto http não carrega bindScope nem transport', () => {
    const cfg = loadConfig({ ...BASE, RISK_HTTP_BIND_SCOPE: 'private-network', RISK_HTTP_TRANSPORT: OVERLAY });
    expect(Object.keys(cfg.http)).toEqual(['enabled']);
  });

  it('o segredo do banco não vira campo de escopo/transporte', () => {
    const cfg = loadConfig(PRIVATE);
    expect(JSON.stringify({ s: (cfg.http as { bindScope: string }).bindScope })).toBe('{"s":"private-network"}');
  });
});

describe('httpBind (funções puras)', () => {
  it('healthProbeHost: loopback → o host configurado; private-network → 127.0.0.1', () => {
    expect(healthProbeHost({ bindScope: 'loopback', host: '127.0.0.1' })).toBe('127.0.0.1');
    expect(healthProbeHost({ bindScope: 'loopback', host: '::1' })).toBe('::1');
    expect(healthProbeHost({ bindScope: 'loopback', host: '127.5.5.5' })).toBe('127.5.5.5');
    expect(healthProbeHost({ bindScope: 'private-network', host: '0.0.0.0' })).toBe('127.0.0.1');
  });

  it('healthProbeHost sobre a config carregada', () => {
    for (const host of ['127.0.0.1', '::1', '127.5.5.5']) {
      const http = loadConfig({ ...HTTP, RISK_HTTP_HOST: host }).http;
      if (!http.enabled) throw new Error('HTTP deveria estar habilitado');
      expect(healthProbeHost(http)).toBe(host);
    }
    const priv = loadConfig(PRIVATE).http;
    if (!priv.enabled) throw new Error('HTTP deveria estar habilitado');
    expect(healthProbeHost(priv)).toBe('127.0.0.1');
  });

  it('isLoopbackIp e isAcceptedWildcard', () => {
    for (const h of ['127.0.0.1', '127.5.5.5', '::1', '0:0:0:0:0:0:0:1']) expect(isLoopbackIp(h), h).toBe(true);
    for (const h of ['', '::', '0.0.0.0', '128.0.0.1', 'localhost', '::2', '127.0.0.1 ', '[::1]']) expect(isLoopbackIp(h), h).toBe(false);
    expect(isAcceptedWildcard('0.0.0.0')).toBe(true);
    for (const h of ['', '::', '0', ' 0.0.0.0', '127.0.0.1']) expect(isAcceptedWildcard(h), h).toBe(false);
  });

  it('resolveBind devolve mensagens fixas ou null', () => {
    expect(resolveBind('loopback', '127.0.0.1')).toBeNull();
    expect(resolveBind('loopback', '0.0.0.0')).toBe(E_LOOP_HOST);
    expect(resolveBind('private-network', '0.0.0.0')).toBeNull();
    expect(resolveBind('private-network', '127.0.0.1')).toBe(E_PRIV_HOST);
  });
});

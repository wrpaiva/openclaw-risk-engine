import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { loadConfig } from '../../../src/infrastructure/config/loadConfig.js';
import { acquireSuiteLock, adminPool, call, dockerRun, e2eEnv, EVALUATE, runImageCli } from '../support/env.js';
import { accountCounts, proposalAt, seedAccountFor, uniqueAccount } from '../support/data.js';
import { saveImage, type SavedImage } from '../support/imageLayers.js';

// Item §9.4 #10 — "Verificar explicitamente que não há credenciais nem caminho de execução real".
// Invariantes: I-07 (ALLOW_PAPER nunca autoriza conta real/ordem real), I-05 (ambiente ≠ PAPER e credencial de exchange =>
// recusa/boot falha), I-01 (nenhuma ordem sem decisão).
// Camadas: (a) imagem real (ambiente do processo, camadas, node_modules, dist, rotas expostas, CLI recusando config) e
// (c) loadConfig em processo. Critério final do §9.4: "nenhum caminho de ordem real".
// LACUNA: prova por ausência (varredura de nomes/padrões e rotas); não há SAST nem scanner de dependências (Q15 pendente), e
// a ausência de saída de rede para exchanges não é verificada por firewall (a app usa rede host por decisão D-10 adiada).
const env = e2eEnv();
let release: () => void;
let admin: pg.Pool;
let saved: SavedImage;

beforeAll(async () => {
  release = await acquireSuiteLock();
  admin = adminPool(3);
  saved = saveImage(env.image);
}, 240_000);
afterAll(async () => {
  saved.cleanup();
  await admin.end();
  release();
});

const execApp = (script: string): { code: number | null; stdout: string; stderr: string } => dockerRun(['exec', env.appContainer, 'sh', '-c', script]);
const CREDENTIAL_NAME = /API_?KEY|API_?SECRET|SECRET|PRIVATE_?KEY|ACCESS_?KEY|PASSPHRASE|BROKER|EXCHANGE|BINANCE|COINBASE|KRAKEN|BYBIT|BITFINEX|BITSTAMP|KUCOIN|OKX|ALPACA|IBKR|OANDA|TRADIER|_KEY$|_PASSWORD$|_TOKEN$/i;

describe('imagem: sem credenciais', () => {
  it('ambiente do processo e da imagem: nenhum nome de credencial; segredos só por arquivo (_FILE), nunca por valor', () => {
    const names = execApp('cat /proc/1/environ | tr "\\0" "\\n"').stdout.split('\n').map((l) => l.split('=')[0] ?? '').filter(Boolean);
    expect(names.length).toBeGreaterThan(3);
    expect(names.filter((n) => CREDENTIAL_NAME.test(n))).toEqual([]);
    expect(names).not.toContain('RISK_DATABASE_URL');
    expect(names).not.toContain('RISK_MIGRATION_DATABASE_URL');
    const values = execApp('cat /proc/1/environ | tr "\\0" "\\n"').stdout;
    expect(values).not.toContain(env.agentToken);
    expect(values).not.toContain(env.executorToken);
    expect(values).not.toMatch(/postgres(ql)?:\/\//);
  });

  it('camadas: nenhum arquivo de credencial em /app (fora de node_modules) e nenhum token/senha deste ciclo', () => {
    const files = saved.layers.flatMap((l) => saved.listFiles(l)).map((f) => f.replace(/^\.\//, ''));
    const app = files.filter((f) => f.startsWith('app/') && !f.startsWith('app/node_modules/'));
    // Nomes de ARQUIVO de segredo (não código que trata de credenciais, ex.: PrincipalCredentials.js).
    expect(app.filter((f) => /(^|\/)(credentials?(\.[a-z]+)?|secrets?(\.[a-z]+)?|\.npmrc|\.netrc|id_rsa|id_ed25519|\.env[^/]*|[^/]*\.(pem|key|p12|pfx))$/i.test(f))).toEqual([]);
    expect(files.filter((f) => /^(root|home\/[^/]+)\/\.(aws|ssh|npmrc|netrc|docker)/.test(f))).toEqual([]);
    const secrets = [env.agentToken, env.executorToken, new URL(env.databaseUrl).password, new URL(env.runtimeDatabaseUrl).password];
    expect(secrets.every((s) => s.length >= 16)).toBe(true);
    expect(saved.layers.map((l) => saved.countSecretHits(l, secrets))).toEqual(saved.layers.map(() => 0));
    expect(saved.configText).not.toMatch(/PASSWORD|SECRET|API_?KEY|postgres:\/\//i);
  });

  it('sem SDK de exchange nos pacotes instalados e sem hosts/clients de exchange no dist (nem cliente HTTP de saída genérico)', () => {
    const pkgs = execApp("cd /app/node_modules && find . -maxdepth 3 -name package.json | sed 's|^\\\\./||; s|/package.json$||'").stdout;
    expect(pkgs).toContain('pg');
    expect(pkgs).not.toMatch(/(^|[/-])(ccxt|binance|coinbase|kraken|bybit|kucoin|okx|bitfinex|bitstamp|alpaca|ibkr|oanda|tradier)([/-]|$)/im);
    // loadConfig.js é a única exceção: lista esses nomes justamente como PADRÕES PROIBIDOS no ambiente (ADR-0010).
    const exchangeHosts = execApp('grep -rIilE "binance|coinbase|kraken|bybit|kucoin|bitfinex|bitstamp|alpaca|interactivebrokers|ibkr|oanda|tradier|okx\\.com" /app/dist /app/migrations | grep -v "/dist/infrastructure/config/loadConfig\\.js"; echo done');
    expect(exchangeHosts.stdout.trim()).toBe('done');
    const config = execApp('cat /app/dist/infrastructure/config/loadConfig.js').stdout;
    expect(config).toMatch(/FORBIDDEN_CREDENTIAL_NAME/);
    // Só o servidor HTTP e o healthcheck em loopback usam node:http; nenhum node:https, fetch, undici, axios ou WebSocket.
    const clients = execApp('grep -rIlE "node:https|\\bfetch\\(|undici|axios|WebSocket|node:tls" /app/dist; echo done');
    expect(clients.stdout.trim()).toBe('done');
  });
});

describe('sem caminho de execução real', () => {
  it('rotas de ordem/execução/conta real não existem (404) ou não aceitam o método (405); nada vira ordem', async () => {
    for (const path of ['/v1/orders', '/v1/risk/orders', '/v1/live/orders', '/v1/execute', '/orders', '/api/trade', '/v1/accounts', '/v1/risk/live']) {
      for (const token of [env.agentToken, env.executorToken, null]) {
        const r = await call(env.baseUrl, 'POST', path, token, { symbol: 'FIXTURE-BTC-USD', side: 'BUY', quantity: '1' });
        expect(r.status, path).toBe(404);
      }
    }
  });

  it('o banco recusa conta real: risk_accounts só aceita environment PAPER (23514), mesmo para o superuser de teste', async () => {
    await expect(admin.query(`INSERT INTO risk_accounts (account_id, environment) VALUES ($1, 'LIVE')`, [`real-${uniqueAccount()}`])).rejects.toMatchObject({ code: '23514' });
    await expect(admin.query(`INSERT INTO risk_accounts (account_id, environment) VALUES ($1, 'live')`, [`real-${uniqueAccount()}`])).rejects.toMatchObject({ code: '23514' });
  });

  it('proposta com environment ≠ PAPER, conta inexistente ou conta "real" → nunca autoriza e nada é gravado', async () => {
    const real = uniqueAccount();
    const before = await accountCounts(admin, real);
    for (const environment of ['LIVE', 'PRODUCTION', 'paper', '']) {
      const r = await call(env.baseUrl, 'POST', EVALUATE, env.agentToken, proposalAt(Date.now(), { accountId: real, agentId: env.agentId, environment }));
      expect([403, 422], environment).toContain(r.status);
      expect(r.text).not.toContain('ALLOW_PAPER');
    }
    // Conta inexistente com ambiente PAPER: sem grant => 403, nada gravado.
    const r = await call(env.baseUrl, 'POST', EVALUATE, env.agentToken, proposalAt(Date.now(), { accountId: real, agentId: env.agentId }));
    expect(r.status).toBe(403);
    expect(await accountCounts(admin, real)).toEqual(before);
  });

  it('a imagem real nunca devolve ALLOW_PAPER (fontes Unconfigured): BLOCK com reserva nula', async () => {
    const acct = uniqueAccount();
    await seedAccountFor(admin, { accountId: acct, agents: [env.agentId] });
    const r = await call(env.baseUrl, 'POST', EVALUATE, env.agentToken, proposalAt(Date.now(), { accountId: acct, agentId: env.agentId }));
    expect(r.json).toMatchObject({ status: 'BLOCK', reservationId: null, authorizationExpiresAt: null });
  });
});

describe('configuração recusa credenciais e ambiente real', { timeout: 240_000 }, () => {
  const VALID = {
    RISK_ENVIRONMENT: 'PAPER',
    RISK_DATABASE_URL: 'postgres://user:senha-fixture@127.0.0.1:5432/openclaw_risk_x_test',
    RISK_LOG_LEVEL: 'error',
    RISK_HTTP_ENABLED: 'false',
    RISK_CLOCK_SKEW_TOLERANCE_MS: '1000',
    RISK_DB_CONNECTION_TIMEOUT_MS: '3000',
    RISK_DB_STATEMENT_TIMEOUT_MS: '10000',
    RISK_DB_LOCK_TIMEOUT_MS: '5000',
  };
  const SUSPECT = ['BINANCE_API_KEY', 'EXCHANGE_URL', 'BROKER_ID', 'MY_SECRET', 'X_PASSPHRASE', 'ALPACA_KEY_ID', 'KRAKEN_PRIVATE_KEY', 'OANDA_ACCESS_KEY', 'IBKR_ACCOUNT', 'OKX_X', 'TRADIER_TOKEN', 'SERVICE_TOKEN', 'DB_PASSWORD', 'SOME_KEY', 'api_key', 'coinbase_pro'];

  it('baseline válido é aceito (controle do teste)', () => {
    expect(() => loadConfig(VALID)).not.toThrow();
  });

  it.each(SUSPECT)('loadConfig recusa %s sem ecoar o valor', (name) => {
    const secret = 'valor-secreto-fixture-123';
    let message = '';
    try {
      loadConfig({ ...VALID, [name]: secret });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain(secret);
  });

  it('RISK_ENVIRONMENT ≠ PAPER (LIVE, paper, vazio, ausente) → ConfigError', () => {
    for (const value of ['LIVE', 'PRODUCTION', 'paper', 'Paper', '']) expect(() => loadConfig({ ...VALID, RISK_ENVIRONMENT: value }), value).toThrow();
    const { RISK_ENVIRONMENT: _omit, ...without } = VALID;
    expect(() => loadConfig(without)).toThrow();
  });

  it('pela IMAGEM (CLI): credencial de exchange no ambiente → exit 2 sem ecoar o valor; RISK_ENVIRONMENT=LIVE → exit 2', () => {
    const url = env.runtimeDatabaseUrl;
    const base = {
      RISK_ENVIRONMENT: 'PAPER',
      RISK_DATABASE_URL: url,
      RISK_LOG_LEVEL: 'error',
      RISK_HTTP_ENABLED: 'false',
      RISK_CLOCK_SKEW_TOLERANCE_MS: '1000',
      RISK_DB_CONNECTION_TIMEOUT_MS: '3000',
      RISK_DB_STATEMENT_TIMEOUT_MS: '10000',
      RISK_DB_LOCK_TIMEOUT_MS: '5000',
    };
    const secret = 'valor-secreto-fixture-xyz-987';
    const extras: Record<string, string>[] = [{ BINANCE_API_KEY: secret }, { EXCHANGE_API_SECRET: secret }, { BROKER_TOKEN: secret }];
    for (const extra of extras) {
      const r = runImageCli(['verify-runtime-privileges'], { ...base, ...extra });
      expect(r.code, JSON.stringify(Object.keys(extra))).toBe(2);
      expect(`${r.stdout}${r.stderr}`).not.toContain(secret);
      expect(`${r.stdout}${r.stderr}`).not.toContain(new URL(url).password);
    }
    for (const environment of ['LIVE', 'paper']) {
      const r = runImageCli(['verify-runtime-privileges'], { ...base, RISK_ENVIRONMENT: environment });
      expect(r.code, environment).toBe(2);
      expect(`${r.stdout}${r.stderr}`).not.toContain(new URL(url).password);
    }
    // Controle: a mesma configuração válida passa (prova de que o exit 2 acima vem do ambiente suspeito).
    expect(runImageCli(['verify-runtime-privileges'], base).code).toBe(0);
  });
});

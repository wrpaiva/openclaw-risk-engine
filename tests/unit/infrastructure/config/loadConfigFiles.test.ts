import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, loadMigrationConfig, type SecretFileReader } from '../../../../src/infrastructure/config/loadConfig.js';

// Valores FICTÍCIOS. As "URLs" abaixo contêm marcadores únicos para provar que nunca aparecem em mensagens.
const RUNTIME_URL = 'postgres://rt-user-zz9:rt-pass-zz9@127.0.0.1:55432/openclaw_risk_test';
const MIGRATION_URL = 'postgres://mig-user-zz9:mig-pass-zz9@127.0.0.1:55432/openclaw_risk_test';
const SECRET_PATH = '/run/secrets/segredo-caminho-zz9';
const BASE = {
  RISK_ENVIRONMENT: 'PAPER',
  RISK_LOG_LEVEL: 'info',
  RISK_HTTP_ENABLED: 'false',
  RISK_CLOCK_SKEW_TOLERANCE_MS: '1000',
  RISK_DB_CONNECTION_TIMEOUT_MS: '2000',
  RISK_DB_STATEMENT_TIMEOUT_MS: '4000',
  RISK_DB_LOCK_TIMEOUT_MS: '3000',
};
const reader =
  (content: string): SecretFileReader =>
  () =>
    content;
const failing: SecretFileReader = () => {
  throw Object.assign(new Error(`EACCES: permission denied, open '${SECRET_PATH}'`), { code: 'EACCES' });
};
const messageOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).message;
  }
  throw new Error('não lançou');
};
const noLeak = (message: string) => {
  for (const marker of ['zz9', 'rt-pass', 'mig-pass', 'postgres://', 'EACCES', '/run/secrets']) expect(message).not.toContain(marker);
};

describe('loadConfig: RISK_DATABASE_URL_FILE', () => {
  it('arquivo válido é usado como URL de runtime', () => {
    const cfg = loadConfig({ ...BASE, RISK_DATABASE_URL_FILE: SECRET_PATH }, reader(RUNTIME_URL));
    expect(cfg.databaseUrl).toBe(RUNTIME_URL);
  });

  it('o leitor recebe exatamente o caminho informado', () => {
    let seen = '';
    loadConfig({ ...BASE, RISK_DATABASE_URL_FILE: SECRET_PATH }, (p) => {
      seen = p;
      return RUNTIME_URL;
    });
    expect(seen).toBe(SECRET_PATH);
  });

  it.each([['\n'], ['\r\n'], ['\n\n']])('quebras de linha finais (%j) são removidas', (tail) => {
    expect(loadConfig({ ...BASE, RISK_DATABASE_URL_FILE: SECRET_PATH }, reader(RUNTIME_URL + tail)).databaseUrl).toBe(RUNTIME_URL);
  });

  it('espaços no fim NÃO são removidos (valor literal preservado)', () => {
    expect(loadConfig({ ...BASE, RISK_DATABASE_URL_FILE: SECRET_PATH }, reader(`${RUNTIME_URL} `)).databaseUrl).toBe(`${RUNTIME_URL} `);
  });

  it('as duas variáveis juntas → erro de exclusividade, sem ler arquivo', () => {
    let read = false;
    const msg = messageOf(() =>
      loadConfig({ ...BASE, RISK_DATABASE_URL: RUNTIME_URL, RISK_DATABASE_URL_FILE: SECRET_PATH }, () => {
        read = true;
        return RUNTIME_URL;
      }),
    );
    expect(msg).toContain('mutuamente exclusivos');
    expect(read).toBe(false);
    noLeak(msg);
  });

  it('nenhuma das duas → erro de obrigatoriedade', () => {
    const msg = messageOf(() => loadConfig({ ...BASE }, reader(RUNTIME_URL)));
    expect(msg).toContain('RISK_DATABASE_URL');
    expect(msg).toContain('obrigatório');
  });

  it('variável direta continua funcionando', () => {
    expect(loadConfig({ ...BASE, RISK_DATABASE_URL: RUNTIME_URL }).databaseUrl).toBe(RUNTIME_URL);
  });

  it('arquivo ilegível → ConfigError fixo sem mensagem do SO nem caminho', () => {
    const msg = messageOf(() => loadConfig({ ...BASE, RISK_DATABASE_URL_FILE: SECRET_PATH }, failing));
    expect(msg).toBe('RISK_DATABASE_URL_FILE: arquivo ilegível');
    noLeak(msg);
  });

  it.each([[''], ['\n'], ['\r\n\r\n']])('arquivo vazio ou só quebras (%j) → conteúdo inválido, nunca URL vazia', (content) => {
    const msg = messageOf(() => loadConfig({ ...BASE, RISK_DATABASE_URL_FILE: SECRET_PATH }, reader(content)));
    expect(msg).toBe('RISK_DATABASE_URL_FILE: conteúdo inválido');
  });

  it.each([[`${RUNTIME_URL}\noutra-linha`], [`linha1\r\n${RUNTIME_URL}`], [`${RUNTIME_URL}\rx`]])('arquivo multilinha (%j) → conteúdo inválido sem eco do conteúdo', (content) => {
    const msg = messageOf(() => loadConfig({ ...BASE, RISK_DATABASE_URL_FILE: SECRET_PATH }, reader(content)));
    expect(msg).toBe('RISK_DATABASE_URL_FILE: conteúdo inválido');
    noLeak(msg);
  });

  it('arquivo real: ilegível (inexistente/diretório) e válido com newline final', () => {
    const dir = mkdtempSync(join(tmpdir(), 'risk-cfg-'));
    try {
      const file = join(dir, 'url');
      writeFileSync(file, `${RUNTIME_URL}\n`);
      chmodSync(file, 0o600);
      expect(loadConfig({ ...BASE, RISK_DATABASE_URL_FILE: file }).databaseUrl).toBe(RUNTIME_URL);
      for (const bad of [join(dir, 'nao-existe'), dir]) {
        const msg = messageOf(() => loadConfig({ ...BASE, RISK_DATABASE_URL_FILE: bad }));
        expect(msg).toBe('RISK_DATABASE_URL_FILE: arquivo ilegível');
        expect(msg).not.toContain(dir);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('loadMigrationConfig', () => {
  const TIMEOUTS = { RISK_DB_CONNECTION_TIMEOUT_MS: '2000', RISK_DB_STATEMENT_TIMEOUT_MS: '4000', RISK_DB_LOCK_TIMEOUT_MS: '3000' };
  const env = { RISK_ENVIRONMENT: 'PAPER', ...TIMEOUTS };

  it('variável direta e _FILE válidos', () => {
    expect(loadMigrationConfig({ ...env, RISK_MIGRATION_DATABASE_URL: MIGRATION_URL }).databaseUrl).toBe(MIGRATION_URL);
    expect(loadMigrationConfig({ ...env, RISK_MIGRATION_DATABASE_URL_FILE: SECRET_PATH }, reader(`${MIGRATION_URL}\n`)).databaseUrl).toBe(MIGRATION_URL);
  });

  it('exclusividade e obrigatoriedade', () => {
    expect(messageOf(() => loadMigrationConfig({ ...env, RISK_MIGRATION_DATABASE_URL: MIGRATION_URL, RISK_MIGRATION_DATABASE_URL_FILE: SECRET_PATH }))).toContain('mutuamente exclusivos');
    expect(messageOf(() => loadMigrationConfig({ ...env }))).toContain('obrigatório');
  });

  it('strings vazias contam como ausentes (nunca como URL vazia)', () => {
    expect(messageOf(() => loadMigrationConfig({ ...env, RISK_MIGRATION_DATABASE_URL: '' }))).toContain('obrigatório');
    expect(loadMigrationConfig({ ...env, RISK_MIGRATION_DATABASE_URL: '', RISK_MIGRATION_DATABASE_URL_FILE: SECRET_PATH }, reader(MIGRATION_URL)).databaseUrl).toBe(MIGRATION_URL);
  });

  it('exige RISK_ENVIRONMENT=PAPER', () => {
    for (const environment of [undefined, 'LIVE', 'paper', '']) {
      expect(() => loadMigrationConfig({ ...TIMEOUTS, ...(environment === undefined ? {} : { RISK_ENVIRONMENT: environment }), RISK_MIGRATION_DATABASE_URL: MIGRATION_URL })).toThrow(ConfigError);
    }
  });

  it('arquivo ilegível, vazio ou multilinha → mensagem fixa sem valor nem caminho', () => {
    const e = { ...env, RISK_MIGRATION_DATABASE_URL_FILE: SECRET_PATH };
    const unreadable = messageOf(() => loadMigrationConfig(e, failing));
    const empty = messageOf(() => loadMigrationConfig(e, reader('\n')));
    const multi = messageOf(() => loadMigrationConfig(e, reader(`${MIGRATION_URL}\nx`)));
    expect(unreadable).toBe('RISK_MIGRATION_DATABASE_URL_FILE: arquivo ilegível');
    expect(empty).toBe('RISK_MIGRATION_DATABASE_URL_FILE: conteúdo inválido');
    expect(multi).toBe('RISK_MIGRATION_DATABASE_URL_FILE: conteúdo inválido');
    for (const m of [unreadable, empty, multi]) noLeak(m);
  });

  it('não exige as demais variáveis do runtime (CLI de migração é independente)', () => {
    expect(() => loadMigrationConfig({ ...env, RISK_MIGRATION_DATABASE_URL: MIGRATION_URL })).not.toThrow();
  });

  it('devolve db com os três prazos numéricos', () => {
    const cfg = loadMigrationConfig({ ...env, RISK_MIGRATION_DATABASE_URL: MIGRATION_URL });
    expect(cfg.db).toEqual({ connectionTimeoutMs: 2000, statementTimeoutMs: 4000, lockTimeoutMs: 3000 });
    expect(cfg.environment).toBe('PAPER');
  });

  it.each(Object.keys(TIMEOUTS))('sem %s → ConfigError que cita só o nome (sem valores, URL ou caminho)', (name) => {
    const partial: Record<string, string | undefined> = Object.fromEntries(Object.entries({ ...env, RISK_MIGRATION_DATABASE_URL: MIGRATION_URL }).filter(([k]) => k !== name));
    const msg = messageOf(() => loadMigrationConfig(partial));
    expect(msg).toContain(name);
    for (const other of Object.keys(TIMEOUTS).filter((n) => n !== name)) expect(msg).not.toContain(other);
    noLeak(msg);
    expect(msg).not.toContain('4000');
  });

  it('sem nenhum dos três prazos → ConfigError citando os três nomes e nenhum valor', () => {
    const msg = messageOf(() => loadMigrationConfig({ RISK_ENVIRONMENT: 'PAPER', RISK_MIGRATION_DATABASE_URL: MIGRATION_URL }));
    for (const name of Object.keys(TIMEOUTS)) expect(msg).toContain(name);
    noLeak(msg);
  });

  it.each([['0'], ['-1'], ['1.5'], ['abc'], [''], ['1e3'], [' 5']])('prazo inválido %j → ConfigError citando só o nome', (value) => {
    const msg = messageOf(() => loadMigrationConfig({ ...env, RISK_DB_LOCK_TIMEOUT_MS: value, RISK_MIGRATION_DATABASE_URL: MIGRATION_URL }));
    expect(msg).toContain('RISK_DB_LOCK_TIMEOUT_MS');
    noLeak(msg);
    if (value !== '') expect(msg).not.toContain(`"${value}"`);
  });

  it('variável com padrão de credencial de exchange ainda impede a migração', () => {
    expect(() => loadMigrationConfig({ ...env, RISK_MIGRATION_DATABASE_URL: MIGRATION_URL, BINANCE_API_KEY: 'x' })).toThrow(ConfigError);
  });
});

describe('loadConfig recusa a credencial de migração no ambiente de runtime', () => {
  it.each(['RISK_MIGRATION_DATABASE_URL', 'RISK_MIGRATION_DATABASE_URL_FILE'])('%s presente → ConfigError fixo', (name) => {
    const msg = messageOf(() => loadConfig({ ...BASE, RISK_DATABASE_URL: RUNTIME_URL, [name]: MIGRATION_URL }, reader(RUNTIME_URL)));
    expect(msg).toBe('credencial de migração não pertence ao ambiente de runtime');
    noLeak(msg);
  });

  it('recusa mesmo com valor vazio (presença da variável basta)', () => {
    expect(() => loadConfig({ ...BASE, RISK_DATABASE_URL: RUNTIME_URL, RISK_MIGRATION_DATABASE_URL: '' })).toThrow(ConfigError);
  });

  it('recusa sem ler o arquivo de runtime (falha antes de qualquer E/S)', () => {
    let read = false;
    expect(() =>
      loadConfig({ ...BASE, RISK_DATABASE_URL_FILE: SECRET_PATH, RISK_MIGRATION_DATABASE_URL: MIGRATION_URL }, () => {
        read = true;
        return RUNTIME_URL;
      }),
    ).toThrow(ConfigError);
    expect(read).toBe(false);
  });
});

describe('nomes novos não casam o padrão proibido de credencial de exchange', () => {
  it.each(['RISK_DATABASE_URL', 'RISK_DATABASE_URL_FILE', 'RISK_MIGRATION_DATABASE_URL', 'RISK_MIGRATION_DATABASE_URL_FILE'])('%s é aceito como nome', (name) => {
    // loadMigrationConfig roda o filtro sobre o ambiente inteiro: se o nome casasse, lançaria a mensagem de exchange.
    const msg = (() => {
      try {
        loadMigrationConfig({ RISK_ENVIRONMENT: 'PAPER', [name]: name.endsWith('_FILE') ? '' : MIGRATION_URL });
        return '';
      } catch (e) {
        return (e as Error).message;
      }
    })();
    expect(msg).not.toContain('exchange/corretora');
  });

  it('o filtro continua barrando nomes de credencial de exchange ao lado dos novos', () => {
    expect(() => loadConfig({ ...BASE, RISK_DATABASE_URL_FILE: SECRET_PATH, EXCHANGE_TOKEN: 'x' }, reader(RUNTIME_URL))).toThrow(/exchange\/corretora/);
  });
});


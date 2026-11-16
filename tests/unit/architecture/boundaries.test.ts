import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../../..');
const SRC = join(ROOT, 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const specifiers = [...text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? '');
  return specifiers.filter((s) => s !== '');
}

const allFiles = sourceFiles(SRC);
const pureFiles = allFiles.filter((f) => /^(domain|rules)\//.test(relative(SRC, f)));
const applicationFiles = allFiles.filter((f) => relative(SRC, f).startsWith('application/'));

// Domínio e regras: puros, sem rede, banco, processo, filesystem ou camadas externas (ADR-0002).
const FORBIDDEN_IN_PURE = /^(node:)?(net|http|https|http2|dgram|dns|tls|fs|fs\/promises|child_process|worker_threads)$|^(pg|pg-pool|postgres|ioredis|redis|undici|axios|node-fetch|openai|@anthropic-ai\/.*)$|\/(application|infrastructure|interfaces)\//;

describe('fronteiras arquiteturais', () => {
  it('encontra arquivos de domínio para verificar', () => {
    expect(pureFiles.length).toBeGreaterThan(0);
  });

  it.each(allFiles.map((f) => [relative(ROOT, f), f]))('%s não importa pixel-agents/pixel-events (ADR-0001, ADR-0007)', (_name, file) => {
    expect(importsOf(file).filter((s) => /pixel-(agents|events)/.test(s))).toEqual([]);
  });

  it.each(pureFiles.map((f) => [relative(ROOT, f), f]))('%s não faz I/O nem depende de camadas externas', (_name, file) => {
    expect(importsOf(file).filter((s) => FORBIDDEN_IN_PURE.test(s))).toEqual([]);
  });

  it.each(applicationFiles.map((f) => [relative(ROOT, f), f]))('%s (aplicação) não depende de infraestrutura nem de driver', (_name, file) => {
    expect(importsOf(file).filter((s) => /\/(infrastructure|interfaces)\/|^pg$|^(node:)?(net|http|https|fs)$/.test(s))).toEqual([]);
  });

  it.each(pureFiles.map((f) => [relative(ROOT, f), f]))('%s não usa relógio, aleatoriedade ou fetch implícitos', (_name, file) => {
    const text = readFileSync(file, 'utf8');
    expect(text).not.toMatch(/Date\.now\(|new Date\(\)|Math\.random\(|\bfetch\(/);
  });

  it('nenhuma variável de ambiente de credencial de exchange/broker (ADR-0010)', () => {
    const env = readFileSync(join(ROOT, '.env.example'), 'utf8');
    expect(env).not.toMatch(/API_KEY|API_SECRET|SECRET|BROKER|EXCHANGE|PASSPHRASE/i);
  });

  it('application não importa interfaces nem infrastructure (verificação explícita)', () => {
    expect(applicationFiles.length).toBeGreaterThan(0);
    for (const file of applicationFiles) {
      expect(importsOf(file).filter((s) => /(^|\/)(interfaces|infrastructure)(\/|$)/.test(s)), relative(ROOT, file)).toEqual([]);
    }
  });

  it('process.env só aparece em infrastructure/config, interfaces/http/main.ts e interfaces/cli/main.ts', () => {
    const allowed = (rel: string) => rel.startsWith('infrastructure/config/') || rel === 'interfaces/http/main.ts' || rel === 'interfaces/cli/main.ts';
    const offenders = allFiles.filter((f) => !allowed(relative(SRC, f)) && /process\s*\.\s*env|process\s*\[\s*['"]env['"]\s*\]/.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
    // O próprio main.ts não pode ler variáveis individualmente: só repassa o ambiente ao loadConfig.
    const main = readFileSync(join(SRC, 'interfaces/http/main.ts'), 'utf8');
    expect(main.match(/process\.env/g)).toEqual(['process.env']);
    expect(main).toContain('loadConfig(process.env)');
    // A CLI também só repassa o ambiente inteiro aos carregadores de config (nunca lê variáveis individuais).
    const cli = readFileSync(join(SRC, 'interfaces/cli/main.ts'), 'utf8');
    const uses = cli.match(/process\.env/g) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    expect(cli.match(/(loadConfig|loadMigrationConfig)\(process\.env\)/g)?.length).toBe(uses.length);
    expect(cli).not.toMatch(/process\.env\s*(\.|\[)/);
  });

  it("literais de curinga ('0.0.0.0' e '::') só podem aparecer em infrastructure/config/httpBind.ts", () => {
    // O arquivo pode ainda não existir; nesse caso nenhum arquivo é permitido.
    const offenders = allFiles
      .filter((f) => relative(SRC, f) !== 'infrastructure/config/httpBind.ts')
      .filter((f) => /(['"`])(0\.0\.0\.0|::)\1/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  it('interfaces/http/main.ts faz listen apenas com o host vindo da config (sem literal de host)', () => {
    const main = readFileSync(join(SRC, 'interfaces/http/main.ts'), 'utf8');
    const calls = [...main.matchAll(/\.listen\(([^)]*)\)?/g)].map((m) => m[1] ?? '');
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) {
      expect(args, args).not.toMatch(/['"`]/);
      const parts = args.split(',').map((x) => x.trim());
      expect(parts[1], args).toMatch(/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*\.host$|^host$/);
    }
  });

  it("interfaces/cli/main.ts não contém o literal '127.0.0.1' (a sonda usa healthProbeHost)", () => {
    const cli = readFileSync(join(SRC, 'interfaces/cli/main.ts'), 'utf8');
    expect(cli).not.toMatch(/(['"`])127\.0\.0\.1\1/);
    expect(cli).toContain('healthProbeHost');
  });

  it('I-08: nenhuma menção a pixel-events/pixel-agents em código, config ou scripts do pacote', () => {
    const extra = ['package.json', 'scripts/check.sh', 'scripts/test-integration.sh', 'scripts/test-db.sh'].map((f) => join(ROOT, f));
    for (const file of [...allFiles, ...extra]) {
      expect(readFileSync(file, 'utf8'), relative(ROOT, file)).not.toMatch(/pixel[-_]?(agents|events)/i);
    }
  });

  it('padrões de credencial do loadConfig e do .env.example estão sincronizados', () => {
    const terms = [
      'API_?KEY', 'API_?SECRET', 'SECRET', 'PRIVATE_?KEY', 'ACCESS_?KEY', 'PASSPHRASE', 'BROKER', 'EXCHANGE',
      'BINANCE', 'COINBASE', 'KRAKEN', 'BYBIT', 'BITFINEX', 'BITSTAMP', 'KUCOIN', 'OKX', 'ALPACA', 'IBKR', 'OANDA', 'TRADIER',
      '_KEY$', '_PASSWORD$', '_TOKEN$',
    ];
    const config = readFileSync(join(SRC, 'infrastructure/config/loadConfig.ts'), 'utf8');
    for (const term of terms) expect(config, term).toContain(`'${term}'`);
    const pattern = new RegExp(terms.join('|'), 'i');
    const env = readFileSync(join(ROOT, '.env.example'), 'utf8');
    const names = env.split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => l.split('=')[0] ?? '');
    expect(names.filter((n) => pattern.test(n))).toEqual([]);
    // Todas as variáveis RISK_* legítimas passam no filtro.
    for (const n of names.filter((n) => n.startsWith('RISK_'))) expect(pattern.test(n), n).toBe(false);
  });
});

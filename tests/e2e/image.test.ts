import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acquireSuiteLock, assertOwnedContainer, docker, dockerRun, e2eEnv, startApp } from './support/env.js';
import { saveImage, type SavedImage } from './support/imageLayers.js';

// T5 — a IMAGEM real (SPEC §9.4 itens 3, 7 e 10; ADR-0009). Camada (a). Invariantes: I-07 (paper-only, sem credencial/caminho
// real), I-02 (a imagem só emite BLOCK: verificado nos itens 3/6). Lacunas: sem scanner de vulnerabilidades (Q15 pendente);
// a imagem não é assinada nem publicada (decisão da etapa).
const env = e2eEnv();
let release: () => void;
let saved: SavedImage;

beforeAll(async () => {
  release = await acquireSuiteLock();
  await startApp();
  saved = saveImage(env.image);
}, 240_000);
afterAll(() => {
  saved.cleanup();
  release();
});

const execApp = (script: string): { code: number | null; stdout: string; stderr: string } => dockerRun(['exec', env.appContainer, 'sh', '-c', script]);
const inspect = (format: string): unknown => JSON.parse(docker(['image', 'inspect', '--format', format, env.image]));

// Nomes de variável de credencial (mesmos termos do loadConfig/ADR-0010).
const CREDENTIAL_NAME = /API_?KEY|API_?SECRET|SECRET|PRIVATE_?KEY|ACCESS_?KEY|PASSPHRASE|BROKER|EXCHANGE|BINANCE|COINBASE|KRAKEN|BYBIT|BITFINEX|BITSTAMP|KUCOIN|OKX|ALPACA|IBKR|OANDA|TRADIER|_KEY$|_PASSWORD$|_TOKEN$/i;

const EXCHANGE_SDK = /(^|[/-])(ccxt|binance|coinbase|kraken|bybit|kucoin|okx|bitfinex|bitstamp|alpaca|ibkr|ib-api|oanda|tradier|metaapi|ccxws)([/-]|$)/i;

/** Pacotes realmente instalados (package.json presente); pastas de escopo vazias não contam. */
function installedPackages(): string[] {
  const out = execApp("cd /app/node_modules && find . -maxdepth 3 -name package.json -not -path '*/node_modules/*/node_modules/*' | sed 's|^\\./||; s|/package.json$||'").stdout;
  return out.split('\n').filter((n) => n !== '' && !n.startsWith('.'));
}

describe('metadados da imagem', () => {
  it('usuário numérico não-root (1000:1000), entrypoint fixo, NODE_ENV=production', () => {
    const cfg = inspect('{{json .Config}}') as { User: string; Entrypoint: string[]; Env: string[]; ExposedPorts: unknown };
    expect(cfg.User).toBe('1000:1000');
    expect(cfg.Entrypoint).toEqual(['node', 'dist/interfaces/http/main.js']);
    expect(cfg.Env).toContain('NODE_ENV=production');
    // D-10 adiada: nenhuma porta é declarada pela imagem.
    expect(cfg.ExposedPorts ?? null).toBeNull();
  });

  it('labels OCI: título, descrição, versão (= package.json) e base', () => {
    const labels = inspect('{{json .Config.Labels}}') as Record<string, string>;
    expect(labels['org.opencontainers.image.title']).toBe('openclaw-risk-engine');
    expect(labels['org.opencontainers.image.version']).toBe('0.1.0');
    expect(labels['org.opencontainers.image.description']).toMatch(/paper trading/i);
    expect(labels['org.opencontainers.image.base.name']).toMatch(/node:22-bookworm-slim/);
    expect(env.image).toBe(`openclaw-risk-engine:${labels['org.opencontainers.image.version']}`);
  });

  it('HEALTHCHECK presente em /health/live (via CLI) e sem valores numéricos fixados na imagem', () => {
    const hc = inspect('{{json .Config.Healthcheck}}') as Record<string, unknown>;
    expect(hc['Test']).toEqual(['CMD', 'node', 'dist/interfaces/cli/main.js', 'healthcheck']);
    for (const k of ['Interval', 'Timeout', 'Retries', 'StartPeriod']) expect(hc[k] ?? 0, k).toBe(0);
  });

  it('nenhuma variável de ambiente embutida na imagem com nome de credencial nem RISK_* de runtime', () => {
    const env2 = (inspect('{{json .Config.Env}}') as string[]).map((e) => e.split('=')[0] ?? '');
    expect(env2.filter((n) => CREDENTIAL_NAME.test(n))).toEqual([]);
    expect(env2.filter((n) => n.startsWith('RISK_'))).toEqual([]);
  });
});

describe('contêiner em execução (pelo script)', () => {
  it('somente leitura, sem capacidades, sem novos privilégios; processo roda como não-root (uid do host, não fixo)', () => {
    const host = JSON.parse(docker(['inspect', '--format', '{{json .HostConfig}}', env.appContainer])) as { ReadonlyRootfs: boolean; CapDrop: string[]; SecurityOpt: string[]; Privileged: boolean };
    expect(host.ReadonlyRootfs).toBe(true);
    expect(host.CapDrop).toEqual(['ALL']);
    expect(host.SecurityOpt).toContain('no-new-privileges');
    expect(host.Privileged).toBe(false);
    // O script sobe a app com o uid:gid do host (--user): o uid em execução não é fixo, mas nunca pode ser root.
    // O 1000:1000 permanece só como Config.User da IMAGEM (teste de metadados acima).
    const uid = execApp('id -u').stdout.trim();
    expect(uid).toMatch(/^[1-9][0-9]*$/);
    expect(Number(uid)).not.toBe(0);
    expect(execApp('id -g').stdout.trim()).not.toBe('0');
    const configured = docker(['inspect', '--format', '{{.Config.User}}', env.appContainer]).trim();
    expect(configured).toMatch(/^[1-9][0-9]*:[0-9]+$/);
    expect(configured.split(':')[0]).toBe(uid);
  });

  it('sem gerenciadores de pacote na imagem: npm, npx, corepack e yarn ausentes (PATH e disco)', () => {
    for (const bin of ['npm', 'npx', 'corepack', 'yarn', 'yarnpkg']) {
      expect(execApp(`command -v ${bin}`).code, `command -v ${bin}`).not.toBe(0);
      for (const dir of ['/usr/local/bin', '/usr/bin', '/bin', '/opt']) expect(execApp(`test -e ${dir}/${bin}`).code, `${dir}/${bin}`).not.toBe(0);
    }
    for (const path of ['/usr/local/lib/node_modules/npm', '/usr/local/lib/node_modules/corepack']) expect(execApp(`test -e ${path}`).code, path).not.toBe(0);
    expect(execApp('ls -d /opt/yarn-v* 2>/dev/null').stdout.trim()).toBe('');
    // O próprio node continua presente (ENTRYPOINT e HEALTHCHECK dependem só dele).
    expect(execApp('command -v node').code).toBe(0);
  });

  it('segredos montados somente leitura, em diretório 0700 com arquivos 0400 (outros usuários do host não os leem)', () => {
    const mounts = JSON.parse(docker(['inspect', '--format', '{{json .Mounts}}', env.appContainer])) as { Source: string; Destination: string; RW: boolean }[];
    const secrets = mounts.find((m) => m.Destination === '/run/secrets');
    expect(secrets).toBeDefined();
    expect(secrets?.RW).toBe(false);
    const dir = secrets?.Source ?? '';
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const files = readdirSync(dir);
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const f of files) expect(statSync(join(dir, f)).mode & 0o777, f).toBe(0o400);
    // Dentro do contêiner o processo (uid do host) lê os arquivos que o script monta para ele.
    expect(execApp('cat /run/secrets/runtime_database_url >/dev/null').code).toBe(0);
    expect(execApp('echo x >> /run/secrets/runtime_database_url').code).not.toBe(0);
  });

  it('não consegue escrever no sistema de arquivos (/app, /tmp, /)', () => {
    for (const path of ['/app/x', '/tmp/x', '/x']) expect(execApp(`touch ${path}`).code, path).not.toBe(0);
  });

  it('/app contém só dist, migrations, node_modules, package.json e package-lock.json', () => {
    const entries = execApp('ls -A /app').stdout.split('\n').filter(Boolean).sort();
    expect(entries).toEqual(['dist', 'migrations', 'node_modules', 'package-lock.json', 'package.json']);
  });

  it('sem testes, docs, .env, .claude, fontes TypeScript, scripts ou chaves em /app (fora de node_modules)', () => {
    const files = execApp('find /app -path /app/node_modules -prune -o -print').stdout.split('\n').filter(Boolean);
    const bad = files.filter((f) => /\/(tests?|docs|src|scripts|deploy|\.claude|\.git)(\/|$)|\/\.env|\.test\.|\.spec\.|\.pem$|\.key$|\.ts$(?<!\.d\.ts)/.test(f));
    expect(bad).toEqual([]);
    expect(files.some((f) => f.endsWith('.js'))).toBe(true);
  });

  it('node_modules só de produção: decimal.js, pg e zod presentes; sem typescript, vitest, eslint, @types, vite, esbuild', () => {
    const top = installedPackages();
    for (const p of ['decimal.js', 'pg', 'zod']) expect(top, p).toContain(p);
    const dev = top.filter((n) => /^(typescript|vitest|vite|esbuild|rollup|rolldown|eslint|typescript-eslint|tsx|ts-node|jest|prettier)$|^@(types|eslint|typescript-eslint|vitest)\//.test(n));
    expect(dev).toEqual([]);
    expect(execApp('test -e /app/node_modules/.bin/tsc || test -e /app/node_modules/.bin/vitest').code).not.toBe(0);
  });

  it('dependências do package.json da imagem = só produção', () => {
    const pkg = JSON.parse(execApp('cat /app/package.json').stdout) as { dependencies: Record<string, string>; devDependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['decimal.js', 'pg', 'zod']);
  });

  it('sem SDK de exchange/corretora entre os pacotes instalados nem nos nomes do package-lock', () => {
    const lock = JSON.parse(execApp('cat /app/package-lock.json').stdout) as { packages: Record<string, unknown> };
    const names = [...installedPackages(), ...Object.keys(lock.packages)];
    expect(names.filter((n) => EXCHANGE_SDK.test(n))).toEqual([]);
  });

  it('processo da app: ambiente sem nome de credencial; só RISK_*_FILE para segredos', () => {
    const names = execApp('cat /proc/1/environ | tr "\\0" "\\n"').stdout.split('\n').map((l) => l.split('=')[0] ?? '').filter(Boolean);
    expect(names.filter((n) => CREDENTIAL_NAME.test(n))).toEqual([]);
    expect(names).toContain('RISK_DATABASE_URL_FILE');
    expect(names).toContain('RISK_PRINCIPALS_FILE');
    expect(names.filter((n) => n.startsWith('RISK_MIGRATION'))).toEqual([]);
  });
});

describe('label por ciclo e trava de posse dos contêineres', () => {
  it('RISK_E2E_LABEL é a label exclusiva do ciclo (e2e-run=<pid>) e está em app e banco, não só a genérica', () => {
    expect(env.label).toMatch(/^com\.openclaw-risk-engine\.e2e-run=[0-9]+$/);
    const [key, value] = env.label.split('=') as [string, string];
    for (const name of [env.appContainer, env.dbContainer]) {
      expect(docker(['inspect', '--format', `{{index .Config.Labels "${key}"}}`, name]).trim(), name).toBe(value);
      expect(docker(['inspect', '--format', '{{index .Config.Labels "com.openclaw-risk-engine.test"}}', name]).trim()).toBe('1');
    }
    expect(env.label).not.toBe('com.openclaw-risk-engine.test=1');
  });

  it('assertOwnedContainer aceita os do ciclo e recusa nomes fora da convenção, inexistentes e labels de outro ciclo', () => {
    expect(() => {
      assertOwnedContainer(env.appContainer);
    }).not.toThrow();
    expect(() => {
      assertOwnedContainer(env.dbContainer);
    }).not.toThrow();
    for (const name of ['aegis-postgres', 'openclaw-risk-backup-1', 'openclaw-risk-restore-1', 'postgres', '', 'x-openclaw-risk-e2e-app']) {
      expect(() => {
        assertOwnedContainer(name);
      }, name).toThrow(/recusado/);
    }
    expect(() => {
      assertOwnedContainer('openclaw-risk-e2e-inexistente-zz9');
    }).toThrow();
    // Um ciclo vizinho (outro pid) teria outro valor da mesma chave: o valor deste ciclo não pode ser genérico/curinga.
    const [, value] = env.label.split('=') as [string, string];
    expect(value).not.toBe('');
    expect(value).not.toBe('1');
  });
});

describe('camadas (docker save)', () => {
  it('existem camadas e a configuração não embute segredos (history sem ARG/ENV de credencial)', () => {
    expect(saved.layers.length).toBeGreaterThan(0);
    expect(saved.configText).not.toMatch(/PASSWORD|API_?KEY|SECRET|PRIVATE KEY|postgres:\/\//i);
  });

  it('nenhuma camada contém caminhos proibidos (.env, tests, docs, .claude, src, scripts, deploy, .git, /run/secrets)', () => {
    const forbidden = /^(app\/(\.env|\.claude|\.git|tests|docs|src|scripts|deploy|README|CLAUDE)|run\/secrets)/;
    const all = saved.layers.flatMap((l) => saved.listFiles(l).map((f) => f.replace(/^\.\//, '')));
    expect(all.filter((f) => forbidden.test(f))).toEqual([]);
    expect(all.some((f) => f.startsWith('app/dist/'))).toBe(true);
    expect(all.some((f) => f.startsWith('app/migrations/'))).toBe(true);
  });

  it('nenhuma camada contém tokens/senhas de fixture deste ciclo (agente, executor, logins do banco)', () => {
    const secrets = [env.agentToken, env.executorToken];
    for (const raw of [env.databaseUrl, env.runtimeDatabaseUrl]) {
      const pw = new URL(raw).password;
      if (pw.length >= 16) secrets.push(pw);
    }
    expect(secrets.every((s) => s.length >= 16)).toBe(true);
    const hits = saved.layers.map((l) => saved.countSecretHits(l, secrets));
    expect(hits).toEqual(saved.layers.map(() => 0));
  });
});

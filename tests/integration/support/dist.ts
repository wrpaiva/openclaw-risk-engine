import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { copyFileSync, cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '../../..');

export interface Dist {
  /** Diretório temporário (fora do repositório) com dist/, migrations/ e node_modules/ ligados. */
  readonly work: string;
  readonly httpMain: string;
  readonly cliMain: string;
  cleanup(): void;
}

/**
 * Compila src/ para um diretório temporário (o dist/ do repositório não é tocado) e liga node_modules e migrations,
 * que o main/CLI resolvem relativos ao próprio arquivo compilado (`../../../migrations`).
 */
export function buildDist(prefix: string, options: { readonly copyMigrations?: boolean } = {}): Dist {
  const work = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const build = spawnSync('npx', ['tsc', '-p', 'tsconfig.build.json', '--outDir', join(work, 'dist')], { cwd: ROOT, encoding: 'utf8' });
  if (build.status !== 0) throw new Error(`build falhou: ${build.stdout}`);
  symlinkSync(join(ROOT, 'node_modules'), join(work, 'node_modules'));
  if (options.copyMigrations) {
    // Cópia real, para o teste poder acrescentar/alterar migrações sem tocar no repositório.
    cpSync(join(ROOT, 'migrations'), join(work, 'migrations'), { recursive: true });
  } else {
    symlinkSync(join(ROOT, 'migrations'), join(work, 'migrations'));
  }
  copyFileSync(join(ROOT, 'package.json'), join(work, 'package.json'));
  return {
    work,
    httpMain: join(work, 'dist/interfaces/http/main.js'),
    cliMain: join(work, 'dist/interfaces/cli/main.js'),
    cleanup: () => {
      rmSync(work, { recursive: true, force: true });
    },
  };
}

/** Arquivo de principais com só hashes FICTÍCIOS. */
export function writePrincipals(work: string, principals: readonly unknown[] = [{ principalId: 'agent-fixture-crypto', kind: 'AGENT', tokenSha256: ['0'.repeat(64)] }]): string {
  const file = join(work, 'principals.json');
  writeFileSync(file, JSON.stringify({ version: 1, principals }));
  return file;
}

export async function freePort(): Promise<number> {
  return new Promise<number>((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const p = (probe.address() as { port: number }).port;
      probe.close(() => {
        resolve(p);
      });
    });
  });
}

/** Ambiente mínimo e explícito (nada herdado do processo de teste). Valores FICTÍCIOS de teste. */
export function runtimeEnv(extra: Record<string, string>): Record<string, string> {
  return {
    PATH: process.env['PATH'] ?? '',
    RISK_ENVIRONMENT: 'PAPER',
    RISK_LOG_LEVEL: 'error',
    RISK_HTTP_ENABLED: 'true',
    RISK_CLOCK_SKEW_TOLERANCE_MS: '1000',
    RISK_DB_CONNECTION_TIMEOUT_MS: '5000',
    RISK_DB_STATEMENT_TIMEOUT_MS: '10000',
    RISK_DB_LOCK_TIMEOUT_MS: '10000',
    RISK_HTTP_HOST: '127.0.0.1',
    RISK_HTTP_MAX_BODY_BYTES: '65536',
    RISK_HTTP_REQUEST_TIMEOUT_MS: '5000',
    RISK_HTTP_HEADERS_TIMEOUT_MS: '3000',
    ...extra,
  };
}

export interface RunResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Executa `node script args` com o ambiente dado e espera o término (mata com SIGKILL no timeout → code null). */
export function runNode(script: string, args: readonly string[], env: Record<string, string>, timeoutMs = 20_000): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('node', [script, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

export interface RunningMain {
  readonly child: ChildProcess;
  readonly stderr: () => string;
  readonly stdout: () => string;
  exited(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/** Inicia o processo e devolve o handle; o chamador é responsável por encerrá-lo (kill em afterAll). */
export function startNode(script: string, env: Record<string, string>): RunningMain {
  const child = spawn('node', [script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => {
      resolve({ code, signal });
    });
  });
  return { child, stderr: () => stderr, stdout: () => stdout, exited: () => done };
}

export async function waitForStatus(url: string, status: number, attempts = 80): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(url)).status === status) return;
    } catch {
      // ainda subindo
    }
    if (i > attempts) throw new Error(`timeout esperando ${status} de ${url}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

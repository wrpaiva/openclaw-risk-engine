import { createHash } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { vi } from 'vitest';
import type { PrincipalAuthenticator } from '../../src/application/ports/PrincipalAuthenticator.js';
import { Sha256TokenAuthenticator } from '../../src/infrastructure/auth/Sha256TokenAuthenticator.js';
import { createRiskHttpServer, type RiskHttpServerDeps } from '../../src/interfaces/http/server.js';
import { CryptoIdGenerator } from '../../src/infrastructure/system/CryptoIdGenerator.js';
import { CapturingLogger } from '../integration/support/harness.js';

// Tokens e principais FICTÍCIOS.
export const AGENT_TOKEN = 'tok-fixture-agent-0001';
export const EXECUTOR_TOKEN = 'tok-fixture-executor-0001';
export const AGENT_ID = 'agent-fixture-crypto';
export const EXECUTOR_ID = 'executor-fixture';
export const LIMITS = { maxBodyBytes: 1024, requestTimeoutMs: 5000, headersTimeoutMs: 3000 } as const;

const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');
export const fixtureAuthenticator = (): PrincipalAuthenticator =>
  new Sha256TokenAuthenticator([
    { principalId: AGENT_ID, kind: 'AGENT', tokenSha256: [sha(AGENT_TOKEN)] },
    { principalId: EXECUTOR_ID, kind: 'PAPER_EXECUTOR', tokenSha256: [sha(EXECUTOR_TOKEN)] },
  ]);

export const DECISION_ID = '5b3f4a52-6c63-4a39-8d3a-4a4f3b7d2c11';
export const RESERVATION_ID = '9d0c3b7e-1f55-4b7b-9f5a-1a2b3c4d5e6f';
export const HASH = `sha256:${'a'.repeat(64)}`;

export const fakeDecision = (overrides: Record<string, unknown> = {}) => ({
  decisionId: DECISION_ID,
  proposalId: '3dd99fb7-2fa8-4700-9d4f-4baf9a4e35f6',
  correlationId: 'corr-fixture-001',
  status: 'BLOCK',
  violations: [{ code: 'MARKET_DATA_STALE', message: 'fixture' }],
  ...overrides,
});

export interface TestServer {
  readonly url: string;
  readonly port: number;
  readonly logger: CapturingLogger;
  readonly evaluate: ReturnType<typeof vi.fn>;
  readonly consume: ReturnType<typeof vi.fn>;
  readonly release: ReturnType<typeof vi.fn>;
  readonly getDecision: ReturnType<typeof vi.fn>;
  readonly raw: Server;
  close(): Promise<void>;
}

/** Sobe o servidor real em 127.0.0.1:0 com casos de uso falsos (por padrão, indisponíveis). */
export async function startServer(overrides: Partial<RiskHttpServerDeps> = {}): Promise<TestServer> {
  const logger = new CapturingLogger();
  const unavailable = () => vi.fn(() => Promise.resolve({ kind: 'UNAVAILABLE' }));
  const evaluate = unavailable();
  const consume = unavailable();
  const release = unavailable();
  const getDecision = unavailable();
  const server = createRiskHttpServer({
    authenticator: fixtureAuthenticator(),
    evaluate: { execute: evaluate },
    consume: { execute: consume },
    release: { execute: release },
    getDecision: { execute: getDecision },
    logger,
    ids: new CryptoIdGenerator(),
    limits: LIMITS,
    ...overrides,
  } as RiskHttpServerDeps);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    logger,
    evaluate,
    consume,
    release,
    getDecision,
    raw: server,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

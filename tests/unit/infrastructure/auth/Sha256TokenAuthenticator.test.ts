import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const timingSpy = vi.hoisted(() => ({ calls: 0 }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    timingSafeEqual: (a: Parameters<typeof actual.timingSafeEqual>[0], b: Parameters<typeof actual.timingSafeEqual>[1]) => {
      timingSpy.calls += 1;
      return actual.timingSafeEqual(a, b);
    },
  };
});

import {
  loadPrincipalCredentials,
  parsePrincipalCredentials,
  PrincipalCredentialsError,
} from '../../../../src/infrastructure/auth/PrincipalCredentials.js';
import { Sha256TokenAuthenticator } from '../../../../src/infrastructure/auth/Sha256TokenAuthenticator.js';

// Tokens e hashes FICTÍCIOS de teste.
const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');
const TOKEN_A = 'token-fixture-agent-a';
const TOKEN_A_NEW = 'token-fixture-agent-a-rotated';
const TOKEN_B = 'token-fixture-executor';

const file = (principals: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ version: 1, principals, ...extra });
const principalA = { principalId: 'agent-a', kind: 'AGENT', tokenSha256: [sha(TOKEN_A), sha(TOKEN_A_NEW)] };
const principalB = { principalId: 'executor-b', kind: 'PAPER_EXECUTOR', tokenSha256: [sha(TOKEN_B)] };

describe('Sha256TokenAuthenticator', () => {
  const auth = () => new Sha256TokenAuthenticator(parsePrincipalCredentials(file([principalA, principalB])));
  beforeEach(() => {
    timingSpy.calls = 0;
  });

  it('token certo devolve o principal com kind e principalId', () => {
    expect(auth().authenticate(TOKEN_A)).toEqual({ kind: 'AGENT', principalId: 'agent-a' });
    expect(auth().authenticate(TOKEN_B)).toEqual({ kind: 'PAPER_EXECUTOR', principalId: 'executor-b' });
  });

  it('rotação: ambos os hashes do mesmo principal autenticam', () => {
    expect(auth().authenticate(TOKEN_A_NEW)).toEqual({ kind: 'AGENT', principalId: 'agent-a' });
    expect(auth().authenticate(TOKEN_A)).toEqual({ kind: 'AGENT', principalId: 'agent-a' });
  });

  it.each([
    ['errado', 'token-errado'],
    ['vazio', ''],
    ['muito longo', 'x'.repeat(1_000_000)],
    ['prefixo do válido', TOKEN_A.slice(0, -1)],
    ['válido com espaço', ` ${TOKEN_A}`],
    ['válido em maiúsculas', TOKEN_A.toUpperCase()],
  ])('token %s → null', (_l, token) => {
    expect(auth().authenticate(token)).toBeNull();
  });

  it('percorre todos os hashes, inclusive após acerto e em erro', () => {
    auth().authenticate(TOKEN_A); // acerto no primeiro de 3 hashes
    expect(timingSpy.calls).toBe(3);
    timingSpy.calls = 0;
    auth().authenticate('errado');
    expect(timingSpy.calls).toBe(3);
  });
});

describe('parsePrincipalCredentials', () => {
  const bad = (raw: string) => () => {
    parsePrincipalCredentials(raw);
  };

  it('aceita arquivo válido', () => {
    expect(parsePrincipalCredentials(file([principalA, principalB]))).toHaveLength(2);
  });

  it.each([
    ['JSON inválido', '{nope'],
    ['vazio', ''],
    ['version 2', JSON.stringify({ version: 2, principals: [principalA] })],
    ['sem version', JSON.stringify({ principals: [principalA] })],
    ['lista vazia', file([])],
    ['campo extra na raiz', file([principalA], { extra: 1 })],
    ['campo extra no principal', file([{ ...principalA, token: 'x' }])],
    ['kind inválido', file([{ ...principalA, kind: 'ADMIN' }])],
    ['principalId inválido', file([{ ...principalA, principalId: 'com espaço' }])],
    ['principalId vazio', file([{ ...principalA, principalId: '' }])],
    ['sem hashes', file([{ ...principalA, tokenSha256: [] }])],
    ['hash curto', file([{ ...principalA, tokenSha256: ['abc'] }])],
    ['hash maiúsculo', file([{ ...principalA, tokenSha256: [sha(TOKEN_A).toUpperCase()] }])],
    ['hash não-hex', file([{ ...principalA, tokenSha256: ['g'.repeat(64)] }])],
    ['hash duplicado entre principais', file([principalA, { ...principalB, tokenSha256: [sha(TOKEN_A)] }])],
    ['hash duplicado no mesmo principal', file([{ ...principalA, tokenSha256: [sha(TOKEN_A), sha(TOKEN_A)] }])],
    ['principalId repetido', file([principalA, { ...principalB, principalId: 'agent-a' }])],
  ])('rejeita %s', (_l, raw) => {
    expect(bad(raw)).toThrow(PrincipalCredentialsError);
  });

  it('mensagens de erro não contêm hash, token nem trecho do arquivo', () => {
    const secretHash = sha(TOKEN_A);
    const raws = [
      file([principalA, { ...principalB, tokenSha256: [secretHash] }]),
      file([{ ...principalA, tokenSha256: [secretHash.toUpperCase()] }]),
      file([{ ...principalA, token: TOKEN_A }]),
      `{"token":"${TOKEN_A}"`,
    ];
    for (const raw of raws) {
      let message = '';
      try {
        parsePrincipalCredentials(raw);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).not.toBe('');
      expect(message).not.toContain(secretHash);
      expect(message.toLowerCase()).not.toContain(secretHash);
      expect(message).not.toContain(TOKEN_A);
      expect(message).not.toContain('agent-a');
    }
  });
});

describe('loadPrincipalCredentials', () => {
  const dir = mkdtempSync(join(tmpdir(), 'risk-principals-test-'));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('lê arquivo válido', () => {
    const p = join(dir, 'ok.json');
    writeFileSync(p, file([principalA]));
    expect(loadPrincipalCredentials(p)).toHaveLength(1);
  });

  it('arquivo ausente → PrincipalCredentialsError sem vazar o caminho', () => {
    const p = join(dir, 'ausente.json');
    expect(() => loadPrincipalCredentials(p)).toThrow(PrincipalCredentialsError);
    try {
      loadPrincipalCredentials(p);
    } catch (e) {
      expect((e as Error).message).not.toContain(dir);
    }
  });

  it('diretório no lugar do arquivo → PrincipalCredentialsError', () => {
    expect(() => loadPrincipalCredentials(dir)).toThrow(PrincipalCredentialsError);
  });

  it('conteúdo inválido no arquivo → PrincipalCredentialsError', () => {
    const p = join(dir, 'bad.json');
    writeFileSync(p, '{"version":1,"principals":[]}');
    expect(() => loadPrincipalCredentials(p)).toThrow(PrincipalCredentialsError);
  });
});

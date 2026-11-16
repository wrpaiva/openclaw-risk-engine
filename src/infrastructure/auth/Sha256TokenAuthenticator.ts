import { createHash, timingSafeEqual } from 'node:crypto';
import type { AuthenticatedPrincipal } from '../../application/ports/AuthenticatedAgentContext.js';
import type { PrincipalAuthenticator } from '../../application/ports/PrincipalAuthenticator.js';
import type { PrincipalCredential } from './PrincipalCredentials.js';

interface Entry {
  readonly hash: Buffer;
  readonly principal: AuthenticatedPrincipal;
}

/** Compara o SHA-256 do token com TODOS os hashes configurados, sem sair cedo. */
export class Sha256TokenAuthenticator implements PrincipalAuthenticator {
  private readonly entries: readonly Entry[];

  constructor(credentials: readonly PrincipalCredential[]) {
    this.entries = credentials.flatMap((c) =>
      c.tokenSha256.map((h) => ({ hash: Buffer.from(h, 'hex'), principal: { kind: c.kind, principalId: c.principalId } })),
    );
  }

  authenticate(bearerToken: string): AuthenticatedPrincipal | null {
    const presented = createHash('sha256').update(bearerToken, 'utf8').digest();
    let found: AuthenticatedPrincipal | null = null;
    for (const entry of this.entries) {
      if (timingSafeEqual(presented, entry.hash) && found === null) found = entry.principal;
    }
    return found;
  }
}

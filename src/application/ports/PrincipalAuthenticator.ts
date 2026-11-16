import type { AuthenticatedPrincipal } from './AuthenticatedAgentContext.js';

export interface PrincipalAuthenticator {
  /** `null` = credencial desconhecida. Nunca lança com o token na mensagem. */
  authenticate(bearerToken: string): AuthenticatedPrincipal | null;
}

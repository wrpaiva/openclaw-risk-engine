/**
 * Identidade estabelecida pelo transporte autenticado (SPEC §4.1, §6.2).
 * O `agentId` do payload nunca substitui este valor.
 */
export interface AuthenticatedAgentContext {
  readonly agentId: string;
}

export type AccessRole = 'AGENT' | 'PAPER_EXECUTOR';

/** Principal estabelecido pela autenticação do transporte; o papel vem da credencial, nunca do payload. */
export type AuthenticatedPrincipal =
  | { readonly kind: 'AGENT'; readonly principalId: string }
  | { readonly kind: 'PAPER_EXECUTOR'; readonly principalId: string };

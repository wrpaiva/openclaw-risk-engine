import { validateRiskDecision, type RiskDecisionV1 } from '../domain/RiskDecision.js';
import { isUuid } from '../domain/schemaSupport.js';
import type { AuthenticatedPrincipal } from './ports/AuthenticatedAgentContext.js';
import type { Logger } from './ports/Logger.js';
import type { TransactionManager } from './ports/TransactionManager.js';

/** Sem oráculo de existência: decisão inexistente, de outro agente ou de conta sem grant são todas `NOT_FOUND`. */
export type GetRiskDecisionResult =
  | { readonly kind: 'FOUND'; readonly decision: RiskDecisionV1 }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'UNAVAILABLE' };

/**
 * AGENT lê apenas as próprias decisões (com grant AGENT ativo na conta); PAPER_EXECUTOR lê as das
 * contas em que tem grant. Leitura pura: não grava nada.
 */
export class GetRiskDecision {
  constructor(private readonly deps: { readonly transactions: TransactionManager; readonly logger: Logger }) {}

  async execute(request: { readonly decisionId: string; readonly principal: AuthenticatedPrincipal }): Promise<GetRiskDecisionResult> {
    if (!isUuid(request.decisionId)) return { kind: 'NOT_FOUND' };
    const { principal } = request;
    try {
      return await this.deps.transactions.run(async (uow) => {
        const raw = await uow.findDecisionById(request.decisionId);
        if (raw === null) return { kind: 'NOT_FOUND' } as const;
        // Nada lido do banco é devolvido sem revalidar; inválida → falha de infraestrutura (503).
        const checked = validateRiskDecision(raw);
        if (!checked.ok) throw new Error('decisão persistida inválida');
        const decision = checked.value;
        const ownerOk = principal.kind === 'PAPER_EXECUTOR' || decision.agentId === principal.principalId;
        if (!ownerOk || !(await uow.hasActiveGrant(principal.principalId, principal.kind, decision.accountId))) {
          this.deps.logger.warn('decision.read.denied', { decisionId: request.decisionId, principalId: principal.principalId, outcome: 'NOT_VISIBLE' });
          return { kind: 'NOT_FOUND' } as const;
        }
        return { kind: 'FOUND', decision } as const;
      });
    } catch (error) {
      this.deps.logger.error('decision.read.unavailable', {
        decisionId: request.decisionId,
        principalId: principal.principalId,
        errorKind: error instanceof Error ? error.name : 'NonError',
      });
      return { kind: 'UNAVAILABLE' };
    }
  }
}

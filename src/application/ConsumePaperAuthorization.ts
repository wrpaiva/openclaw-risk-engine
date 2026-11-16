import { validateRiskDecision } from '../domain/RiskDecision.js';
import { isUuid } from '../domain/schemaSupport.js';
import { UtcInstant } from '../domain/value-objects/UtcInstant.js';
import type { AuthenticatedPrincipal } from './ports/AuthenticatedAgentContext.js';
import type { Clock } from './ports/Clock.js';
import type { IdGenerator } from './ports/IdGenerator.js';
import type { Logger } from './ports/Logger.js';
import type { RiskMetrics } from './ports/RiskMetrics.js';
import { UniqueConflictError, type RiskUnitOfWork } from './ports/RiskUnitOfWork.js';
import type { TransactionManager } from './ports/TransactionManager.js';
import { safeMetrics } from './SafeMetrics.js';

/**
 * Resultado para o futuro paper executor (I-01, I-04). Só `CONSUMED` permite registrar a ordem simulada.
 * Repetir com o mesmo `paperOrderId` é idempotente (`replayed: true`).
 */
export type ConsumeResult =
  | { readonly kind: 'CONSUMED'; readonly reservationId: string; readonly replayed: boolean }
  | { readonly kind: 'FORBIDDEN' }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'NOT_AUTHORIZED'; readonly reason: 'BLOCKED' | 'EXPIRED' | 'RELEASED' | 'PROPOSAL_MISMATCH' }
  | { readonly kind: 'CONFLICT' }
  | { readonly kind: 'UNAVAILABLE' };

export interface ConsumeRequest {
  readonly decisionId: string;
  readonly accountId: string;
  /** Identificador único da ordem simulada que consome a autorização. */
  readonly paperOrderId: string;
  /**
   * Hash da proposta autorizada. PROVISÓRIO (D-09): o protocolo de consume (`paperOrderId` + `proposalHash`)
   * será revisto quando o contrato do executor paper for decidido.
   */
  readonly proposalHash: string;
}

export class ConsumePaperAuthorization {
  private readonly metrics: RiskMetrics;

  constructor(
    private readonly deps: { readonly transactions: TransactionManager; readonly clock: Clock; readonly ids: IdGenerator; readonly logger: Logger; readonly metrics?: RiskMetrics },
  ) {
    this.metrics = safeMetrics(deps.metrics);
  }

  async execute(request: ConsumeRequest & { readonly principal: AuthenticatedPrincipal }): Promise<ConsumeResult> {
    const result = await this.run(request);
    switch (result.kind) {
      case 'CONSUMED':
        this.metrics.reservationOp('CONSUME', 'OK');
        break;
      case 'CONFLICT':
        this.metrics.reservationConflict('CONSUME');
        this.metrics.reservationOp('CONSUME', 'CONFLICT');
        break;
      case 'NOT_AUTHORIZED':
        this.metrics.reservationOp('CONSUME', 'CONFLICT');
        break;
      case 'FORBIDDEN':
        this.metrics.reservationOp('CONSUME', 'FORBIDDEN');
        break;
      case 'UNAVAILABLE':
        this.metrics.reservationOp('CONSUME', 'UNAVAILABLE');
        break;
      case 'NOT_FOUND':
        break;
    }
    return result;
  }

  private async run(request: ConsumeRequest & { readonly principal: AuthenticatedPrincipal }): Promise<ConsumeResult> {
    if (request.principal.kind !== 'PAPER_EXECUTOR') return this.forbidden(request, 'WRONG_ROLE');
    if (!isUuid(request.decisionId)) return { kind: 'NOT_FOUND' };
    if (request.paperOrderId === '') return { kind: 'CONFLICT' };
    try {
      return await this.deps.transactions.run((uow) => this.consume(uow, request));
    } catch (error) {
      if (error instanceof UniqueConflictError) return { kind: 'CONFLICT' };
      this.deps.logger.error('consume.unavailable', {
        accountId: request.accountId,
        decisionId: request.decisionId,
        principalId: request.principal.principalId,
        errorKind: error instanceof Error ? error.name : 'NonError',
      });
      return { kind: 'UNAVAILABLE' };
    }
  }

  private forbidden(request: { readonly accountId: string; readonly principal: AuthenticatedPrincipal }, outcome: string): ConsumeResult {
    this.deps.logger.warn('consume.forbidden', { accountId: request.accountId, principalId: request.principal.principalId, outcome });
    return { kind: 'FORBIDDEN' };
  }

  private async consume(uow: RiskUnitOfWork, request: ConsumeRequest & { readonly principal: AuthenticatedPrincipal }): Promise<ConsumeResult> {
    // Lock e grant primeiro, na conta informada: sem grant nada da decisão é revelado.
    await uow.lockAccount(request.accountId);
    if (!(await uow.hasActiveGrant(request.principal.principalId, 'PAPER_EXECUTOR', request.accountId))) {
      return this.forbidden(request, 'NO_GRANT');
    }
    // Consulta a decisão persistida no servidor; nunca confia em decisão enviada pelo cliente (SPEC §4.4).
    const raw = await uow.findDecisionById(request.decisionId);
    if (raw === null) return { kind: 'NOT_FOUND' };
    // Decisão persistida inválida → falha de infraestrutura (503), nunca autorização.
    const checked = validateRiskDecision(raw);
    if (!checked.ok) throw new Error('decisão persistida inválida');
    const decision = checked.value;
    if (decision.accountId !== request.accountId) {
      // Sem oráculo de existência: decisão de outra conta é indistinguível de inexistente.
      this.deps.logger.warn('consume.account_mismatch', { accountId: request.accountId, decisionId: request.decisionId, principalId: request.principal.principalId });
      return { kind: 'NOT_FOUND' };
    }
    if (decision.proposalHash !== request.proposalHash) return { kind: 'NOT_AUTHORIZED', reason: 'PROPOSAL_MISMATCH' };
    if (decision.status !== 'ALLOW_PAPER') return { kind: 'NOT_AUTHORIZED', reason: 'BLOCKED' };

    const reservation = await uow.findReservationByDecision(decision.decisionId);
    if (reservation === null) throw new Error('ALLOW_PAPER sem reserva persistida');
    if (
      reservation.reservationId !== decision.reservationId ||
      reservation.accountId !== decision.accountId ||
      reservation.decisionId !== decision.decisionId ||
      !sameInstant(reservation.expiresAt, decision.authorizationExpiresAt)
    ) {
      throw new Error('reserva divergente da decisão');
    }

    switch (reservation.status) {
      case 'CONSUMED':
        return reservation.paperOrderId === request.paperOrderId
          ? { kind: 'CONSUMED', reservationId: reservation.reservationId, replayed: true }
          : { kind: 'CONFLICT' };
      case 'EXPIRED':
        return { kind: 'NOT_AUTHORIZED', reason: 'EXPIRED' };
      case 'RELEASED':
        return { kind: 'NOT_AUTHORIZED', reason: 'RELEASED' };
      case 'ACTIVE':
        break;
    }

    const now = this.deps.clock.now();
    const at = now.toISOString();
    const base = {
      correlationId: decision.correlationId,
      accountId: decision.accountId,
      proposalId: decision.proposalId,
      decisionId: decision.decisionId,
      reservationId: reservation.reservationId,
      createdAt: at,
    };

    // Autorização vencida (UT-020): expira a reserva nesta transação e não consome.
    // A expiração da reserva é a fonte de verdade (já exigida igual à da decisão acima).
    const expiresAt = UtcInstant.parse(reservation.expiresAt);
    if (!expiresAt.ok || !now.isBefore(expiresAt.value)) {
      if (!(await uow.closeReservation(reservation.reservationId, 'EXPIRED', at, null))) throw new Error('reserva mudou sob lock');
      await uow.appendAudit({ ...base, eventId: this.deps.ids.uuid(), eventType: 'RESERVATION_EXPIRED', details: { trigger: 'consume-after-ttl' } });
      return { kind: 'NOT_AUTHORIZED', reason: 'EXPIRED' };
    }

    if (!(await uow.closeReservation(reservation.reservationId, 'CONSUMED', at, request.paperOrderId))) {
      throw new Error('reserva mudou sob lock');
    }
    await uow.appendAudit({ ...base, eventId: this.deps.ids.uuid(), eventType: 'RESERVATION_CONSUMED', details: { paperOrderId: request.paperOrderId } });
    await uow.appendOutbox({
      eventId: this.deps.ids.uuid(),
      aggregateId: decision.decisionId,
      eventType: 'risk.authorization.consumed',
      payload: { decisionId: decision.decisionId, reservationId: reservation.reservationId, paperOrderId: request.paperOrderId },
      createdAt: at,
    });
    return { kind: 'CONSUMED', reservationId: reservation.reservationId, replayed: false };
  }
}

function sameInstant(a: string, b: string | null): boolean {
  if (b === null) return false;
  const x = UtcInstant.parse(a);
  const y = UtcInstant.parse(b);
  return x.ok && y.ok && x.value.equals(y.value);
}

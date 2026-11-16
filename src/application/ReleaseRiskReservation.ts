import { UtcInstant } from '../domain/value-objects/UtcInstant.js';
import { isUuid } from '../domain/schemaSupport.js';
import type { AuthenticatedPrincipal } from './ports/AuthenticatedAgentContext.js';
import type { Clock } from './ports/Clock.js';
import type { IdGenerator } from './ports/IdGenerator.js';
import type { Logger } from './ports/Logger.js';
import type { RiskMetrics } from './ports/RiskMetrics.js';
import type { RiskUnitOfWork } from './ports/RiskUnitOfWork.js';
import type { TransactionManager } from './ports/TransactionManager.js';
import { safeMetrics } from './SafeMetrics.js';

export type ReleaseResult =
  | { readonly kind: 'RELEASED'; readonly replayed: boolean }
  | { readonly kind: 'FORBIDDEN' }
  /** Também devolvido quando o principal não tem grant na conta da reserva (sem oráculo de existência). */
  | { readonly kind: 'NOT_FOUND' }
  /** Reserva já consumida ou expirada: liberar de novo duplicaria capacidade. */
  | { readonly kind: 'CONFLICT'; readonly status: 'CONSUMED' | 'EXPIRED' }
  | { readonly kind: 'UNAVAILABLE' };

/** Cancelamento/falha do executor: devolve capacidade uma única vez (SPEC §3.1, §7.2.8). */
export class ReleaseRiskReservation {
  private readonly metrics: RiskMetrics;

  constructor(
    private readonly deps: { readonly transactions: TransactionManager; readonly clock: Clock; readonly ids: IdGenerator; readonly logger: Logger; readonly metrics?: RiskMetrics },
  ) {
    this.metrics = safeMetrics(deps.metrics);
  }

  async execute(request: { readonly reservationId: string; readonly reason: string; readonly principal: AuthenticatedPrincipal }): Promise<ReleaseResult> {
    const result = await this.run(request);
    switch (result.kind) {
      case 'RELEASED':
        this.metrics.reservationOp('RELEASE', 'OK');
        break;
      case 'CONFLICT':
        this.metrics.reservationConflict('RELEASE');
        this.metrics.reservationOp('RELEASE', 'CONFLICT');
        break;
      case 'FORBIDDEN':
        this.metrics.reservationOp('RELEASE', 'FORBIDDEN');
        break;
      case 'UNAVAILABLE':
        this.metrics.reservationOp('RELEASE', 'UNAVAILABLE');
        break;
      case 'NOT_FOUND':
        break;
    }
    return result;
  }

  private async run(request: { readonly reservationId: string; readonly reason: string; readonly principal: AuthenticatedPrincipal }): Promise<ReleaseResult> {
    if (request.principal.kind !== 'PAPER_EXECUTOR') {
      this.deps.logger.warn('release.forbidden', { reservationId: request.reservationId, principalId: request.principal.principalId, outcome: 'WRONG_ROLE' });
      return { kind: 'FORBIDDEN' };
    }
    if (!isUuid(request.reservationId)) return { kind: 'NOT_FOUND' };
    try {
      return await this.deps.transactions.run((uow) => this.release(uow, request));
    } catch (error) {
      this.deps.logger.error('release.unavailable', {
        reservationId: request.reservationId,
        principalId: request.principal.principalId,
        errorKind: error instanceof Error ? error.name : 'NonError',
      });
      return { kind: 'UNAVAILABLE' };
    }
  }

  private async release(
    uow: RiskUnitOfWork,
    request: { readonly reservationId: string; readonly reason: string; readonly principal: AuthenticatedPrincipal },
  ): Promise<ReleaseResult> {
    const found = await uow.findReservation(request.reservationId);
    if (found === null) return { kind: 'NOT_FOUND' };
    await uow.lockAccount(found.accountId);
    if (!(await uow.hasActiveGrant(request.principal.principalId, 'PAPER_EXECUTOR', found.accountId))) {
      this.deps.logger.warn('release.forbidden', {
        reservationId: request.reservationId,
        accountId: found.accountId,
        principalId: request.principal.principalId,
        outcome: 'NO_GRANT',
      });
      return { kind: 'NOT_FOUND' };
    }
    // Releitura sob o lock: evita TOCTOU com consume/expire concorrentes.
    const reservation = await uow.findReservation(request.reservationId);
    if (reservation === null) throw new Error('reserva desapareceu sob lock');

    if (reservation.status === 'RELEASED') return { kind: 'RELEASED', replayed: true };
    if (reservation.status !== 'ACTIVE') return { kind: 'CONFLICT', status: reservation.status };

    const now = this.deps.clock.now();
    const at = now.toISOString();
    // TTL vencido: fecha como EXPIRED (como no consume) e responde CONFLICT/EXPIRED; nunca RELEASED.
    const expiresAt = UtcInstant.parse(reservation.expiresAt);
    if (!expiresAt.ok || !now.isBefore(expiresAt.value)) {
      if (!(await uow.closeReservation(reservation.reservationId, 'EXPIRED', at, null))) throw new Error('reserva mudou sob lock');
      await uow.appendAudit({
        eventId: this.deps.ids.uuid(),
        eventType: 'RESERVATION_EXPIRED',
        correlationId: null,
        accountId: reservation.accountId,
        proposalId: null,
        decisionId: reservation.decisionId,
        reservationId: reservation.reservationId,
        details: { trigger: 'release-after-ttl' },
        createdAt: at,
      });
      return { kind: 'CONFLICT', status: 'EXPIRED' };
    }
    if (!(await uow.closeReservation(reservation.reservationId, 'RELEASED', at, null))) throw new Error('reserva mudou sob lock');
    await uow.appendAudit({
      eventId: this.deps.ids.uuid(),
      eventType: 'RESERVATION_RELEASED',
      correlationId: null,
      accountId: reservation.accountId,
      proposalId: null,
      decisionId: reservation.decisionId,
      reservationId: reservation.reservationId,
      // Motivo truncado: metadado curto, nunca texto livre extenso de agente.
      details: { reason: request.reason.slice(0, 64) },
      createdAt: at,
    });
    return { kind: 'RELEASED', replayed: false };
  }
}

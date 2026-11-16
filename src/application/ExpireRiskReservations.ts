import type { Clock } from './ports/Clock.js';
import type { IdGenerator } from './ports/IdGenerator.js';
import type { RiskMetrics } from './ports/RiskMetrics.js';
import type { TransactionManager } from './ports/TransactionManager.js';
import { safeMetrics } from './SafeMetrics.js';

/**
 * Varredura de reservas ACTIVE vencidas. Até ela rodar, reservas vencidas continuam ocupando
 * capacidade (conservador): só um fluxo transacional e auditado devolve capacidade (SPEC §7.2.8).
 */
export class ExpireRiskReservations {
  private readonly metrics: RiskMetrics;

  constructor(
    private readonly deps: { readonly transactions: TransactionManager; readonly clock: Clock; readonly ids: IdGenerator; readonly metrics?: RiskMetrics },
  ) {
    this.metrics = safeMetrics(deps.metrics);
  }

  /** Devolve quantas reservas expiraram; exceção = nada confirmado. */
  async execute(): Promise<number> {
    let expired: number;
    try {
      expired = await this.runSweep();
    } catch (error) {
      this.metrics.reservationOp('EXPIRE', 'UNAVAILABLE');
      throw error;
    }
    // Só após COMMIT bem-sucedido: uma expiração não confirmada não conta.
    for (let i = 0; i < expired; i += 1) this.metrics.reservationOp('EXPIRE', 'OK');
    return expired;
  }

  private runSweep(): Promise<number> {
    return this.deps.transactions.run(async (uow) => {
      // Primeiro: com restore_pending (ou estado ilegível) a varredura falha de forma determinística, mesmo sem
      // reservas vencidas (senão exit 0 mascararia o estado). A leitura é refeita sob lock em lockAccount.
      await uow.assertOperational();
      const now = this.deps.clock.now().toISOString();
      let expired = 0;
      // Ordem determinística de locks evita deadlock com outras varreduras. `sort()` é por code units UTF-16 e pode
      // divergir do ORDER BY do banco (collation) usado em PgRestoreReconciliation; sem risco de deadlock lá porque a
      // reconciliação trava o estado operacional antes e esta varredura falha com restore_pending (assertOperational).
      // Se as duas rotinas passarem a disputar locks de conta, unifique a ordenação (COLLATE "C" + sort()).
      const accounts = [...(await uow.findAccountsWithExpiredReservations(now))].sort();
      for (const accountId of accounts) {
        await uow.lockAccount(accountId);
        for (const reservation of await uow.findExpiredActiveReservations(accountId, now)) {
          if (!(await uow.closeReservation(reservation.reservationId, 'EXPIRED', now, null))) continue;
          expired += 1;
          await uow.appendAudit({
            eventId: this.deps.ids.uuid(),
            eventType: 'RESERVATION_EXPIRED',
            correlationId: null,
            accountId,
            proposalId: null,
            decisionId: reservation.decisionId,
            reservationId: reservation.reservationId,
            details: { trigger: 'sweep' },
            createdAt: now,
          });
        }
      }
      return expired;
    });
  }
}

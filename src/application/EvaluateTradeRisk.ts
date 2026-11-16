import { validateRiskDecision, type RiskDecisionV1 } from '../domain/RiskDecision.js';
import { validateRiskPolicy } from '../domain/RiskPolicy.js';
import type { RiskViolationV1 } from '../domain/RiskViolation.js';
import { computeProposalHash, parseTradeProposalContract, payloadAgentMatches, type TradeProposalV1 } from '../domain/TradeProposal.js';
import { DecimalAmount } from '../domain/value-objects/DecimalAmount.js';
import type { UtcInstant } from '../domain/value-objects/UtcInstant.js';
import type { RiskEvaluation, RiskEvaluator } from '../rules/RiskEvaluator.js';
import type { AccountSnapshot, AccountSnapshotProvider } from './ports/AccountSnapshotProvider.js';
import type { Clock } from './ports/Clock.js';
import type { IdGenerator } from './ports/IdGenerator.js';
import type { InstrumentCatalog } from './ports/InstrumentCatalog.js';
import type { Logger } from './ports/Logger.js';
import type { RiskMetrics } from './ports/RiskMetrics.js';
import { safeMetrics } from './SafeMetrics.js';
import type { MarketDataProvider } from './ports/MarketDataProvider.js';
import { UniqueConflictError, type ReservedExposure, type RiskUnitOfWork } from './ports/RiskUnitOfWork.js';
import type { TransactionManager } from './ports/TransactionManager.js';

/**
 * Resultado para o transporte (SPEC §3.2). Somente `DECISION` com status `ALLOW_PAPER` autoriza,
 * e apenas depois do COMMIT. Os demais nunca autorizam:
 * - REJECTED → 401/403 (identidade) ou 400/422 (contrato), sem persistência;
 * - IDEMPOTENCY_CONFLICT → 409, sem nova avaliação;
 * - UNAVAILABLE → 503, rollback completo.
 */
export type EvaluateTradeRiskResult =
  | { readonly kind: 'DECISION'; readonly decision: RiskDecisionV1; readonly replayed: boolean }
  | { readonly kind: 'REJECTED'; readonly reason: 'UNAUTHENTICATED' | 'FORBIDDEN' | 'INVALID_CONTRACT'; readonly violations: readonly RiskViolationV1[] }
  | { readonly kind: 'IDEMPOTENCY_CONFLICT' }
  | { readonly kind: 'UNAVAILABLE' };

export interface EvaluateTradeRiskDeps {
  readonly transactions: TransactionManager;
  readonly evaluator: RiskEvaluator;
  readonly snapshots: AccountSnapshotProvider;
  readonly marketData: MarketDataProvider;
  readonly catalog: InstrumentCatalog;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  /** Obrigatória e explícita; sem valor padrão. */
  readonly clockSkewToleranceMs: number;
  /** Opcional; sem coletor, nada é emitido. */
  readonly metrics?: RiskMetrics;
}

export class EvaluateTradeRisk {
  private readonly metrics: RiskMetrics;

  constructor(private readonly deps: EvaluateTradeRiskDeps) {
    this.metrics = safeMetrics(deps.metrics);
  }

  async execute(request: { readonly proposal: unknown; readonly authenticatedAgentId: string }): Promise<EvaluateTradeRiskResult> {
    const started = performance.now();
    const result = await this.run(request);
    this.observe(result, (performance.now() - started) / 1000);
    return result;
  }

  private observe(result: EvaluateTradeRiskResult, seconds: number): void {
    switch (result.kind) {
      case 'DECISION':
        if (result.replayed) {
          this.metrics.idempotencyReplay();
          return;
        }
        if (result.decision.violations.length === 0) this.metrics.evaluation(result.decision.status, 'NONE');
        else for (const v of result.decision.violations) this.metrics.evaluation(result.decision.status, v.code);
        this.metrics.evaluationDuration(seconds);
        return;
      case 'REJECTED':
        this.metrics.transportError(result.reason === 'INVALID_CONTRACT' ? 'CONTRACT' : 'AUTH');
        return;
      case 'IDEMPOTENCY_CONFLICT':
        this.metrics.transportError('CONFLICT');
        return;
      case 'UNAVAILABLE':
        this.metrics.transportError('UNAVAILABLE');
        return;
    }
  }

  private async run(request: { readonly proposal: unknown; readonly authenticatedAgentId: string }): Promise<EvaluateTradeRiskResult> {
    // Identidade e contrato antes de qualquer gravação: impede que um agente ocupe
    // a chave idempotente de outro gravando um BLOCK em seu nome.
    const identity = this.checkIdentity(request.proposal, request.authenticatedAgentId);
    if (identity) return identity;

    const contract = parseTradeProposalContract(request.proposal);
    if (!contract.ok) return { kind: 'REJECTED', reason: 'INVALID_CONTRACT', violations: contract.error };
    const proposal = contract.value;
    const proposalHash = computeProposalHash(proposal);

    try {
      return await this.deps.transactions.run((uow) => this.decide(uow, proposal, proposalHash, request.authenticatedAgentId));
    } catch (error) {
      if (error instanceof UniqueConflictError) return { kind: 'IDEMPOTENCY_CONFLICT' };
      // Falha de banco, dependência ou COMMIT: rollback já ocorreu; nenhuma autorização.
      // Só a classe do erro é logada: a mensagem pode conter dados de conexão ou do payload.
      this.deps.logger.error('evaluate.unavailable', {
        correlationId: proposal.correlationId,
        proposalId: proposal.proposalId,
        accountId: proposal.accountId,
        principalId: request.authenticatedAgentId,
        errorKind: error instanceof Error ? error.name : 'NonError',
      });
      return { kind: 'UNAVAILABLE' };
    }
  }

  private checkIdentity(proposal: unknown, authenticatedAgentId: string): EvaluateTradeRiskResult | null {
    if (authenticatedAgentId === '') {
      return { kind: 'REJECTED', reason: 'UNAUTHENTICATED', violations: [{ code: 'UNAUTHORIZED_AGENT', message: 'sem identidade autenticada' }] };
    }
    if (!payloadAgentMatches(proposal, authenticatedAgentId)) {
      this.deps.logger.warn('evaluate.forbidden', { principalId: authenticatedAgentId, outcome: 'AGENT_ID_MISMATCH' });
      return {
        kind: 'REJECTED',
        reason: 'FORBIDDEN',
        violations: [{ code: 'UNAUTHORIZED_AGENT', field: 'agentId', message: 'agentId do payload diverge da identidade autenticada' }],
      };
    }
    return null;
  }

  private async decide(
    uow: RiskUnitOfWork,
    proposal: TradeProposalV1,
    proposalHash: string,
    authenticatedAgentId: string,
  ): Promise<EvaluateTradeRiskResult> {
    // 1–3: lock da conta primeiro; a verificação idempotente sob o lock não sofre corrida.
    const account = await uow.lockAccount(proposal.accountId);

    // Grant AGENT na conta, sob o lock e antes da idempotência: sem grant nada é gravado nem revelado.
    // Negação só vai para o log (decisão do usuário), nunca para a auditoria em banco.
    const granted = await uow.hasActiveGrant(authenticatedAgentId, 'AGENT', proposal.accountId);
    if (!granted) {
      this.deps.logger.warn('evaluate.forbidden', {
        correlationId: proposal.correlationId,
        proposalId: proposal.proposalId,
        accountId: proposal.accountId,
        principalId: authenticatedAgentId,
        outcome: 'NO_GRANT',
      });
      return {
        kind: 'REJECTED',
        reason: 'FORBIDDEN',
        violations: [{ code: 'UNAUTHORIZED_AGENT', message: 'agente sem concessão ativa para a conta' }],
      };
    }

    const replay = await this.checkIdempotency(uow, proposal, proposalHash);
    if (replay) return replay;

    // 4: política fixa e snapshots dentro da transação, já sob o lock.
    const policyDocument = await uow.findActivePolicyDocument(proposal.accountId);
    const instrument = await this.deps.catalog.find(proposal.instrument);
    const snapshot = await this.deps.snapshots.getSnapshot(proposal.accountId, proposal.instrument, proposal.strategyId);
    const reserved = await uow.sumActiveReservations(proposal.accountId, proposal.instrument, proposal.strategyId);
    const quote = await this.deps.marketData.quote(proposal.instrument);
    const conversion = await this.loadConversion(policyDocument, instrument, proposal.accountId);

    // Relógio lido uma única vez, depois de carregar os dados: freshness medida no momento da decisão.
    const now = this.deps.clock.now();
    const evaluation = this.deps.evaluator.evaluate({
      proposal,
      authenticatedAgentId,
      accountAgentGrant: { accountId: proposal.accountId, agentId: authenticatedAgentId },
      account,
      policy: policyDocument,
      // Sem snapshot → ACCOUNT_SNAPSHOT_STALE; sem cotação → contexto sem `market` → MARKET_DATA_UNAVAILABLE.
      context: snapshot ? buildContext(snapshot, reserved, quote, conversion) : null,
      instrument,
      now,
      clockSkewToleranceMs: this.deps.clockSkewToleranceMs,
    });

    // 5–6: decisão, reserva, auditoria e outbox no mesmo COMMIT.
    const decision = this.toDecision(evaluation, proposal, proposalHash);
    const checked = validateRiskDecision(decision);
    if (!checked.ok) throw new Error('decisão violaria invariantes; abortando sem autorização');

    await uow.insertProposal(proposal, proposalHash, now.toISOString());
    if (evaluation.outcome === 'ELIGIBLE' && decision.reservationId !== null && decision.authorizationExpiresAt !== null) {
      await uow.insertReservation({
        reservationId: decision.reservationId,
        decisionId: decision.decisionId,
        accountId: evaluation.reservation.accountId,
        instrument: evaluation.reservation.instrument,
        strategyId: evaluation.reservation.strategyId,
        exposureBase: evaluation.reservation.exposureBase,
        riskBase: evaluation.reservation.tradeRiskBase,
        expiresAt: decision.authorizationExpiresAt,
        createdAt: now.toISOString(),
      });
    }
    await uow.insertDecision(decision);
    await this.recordEvents(uow, decision, now);
    // 7: o retorno só chega ao chamador depois do COMMIT feito pelo TransactionManager.
    return { kind: 'DECISION', decision, replayed: false };
  }

  private async checkIdempotency(
    uow: RiskUnitOfWork,
    proposal: TradeProposalV1,
    proposalHash: string,
  ): Promise<EvaluateTradeRiskResult | null> {
    const byKey = await uow.findProposalByIdempotencyKey(proposal.accountId, proposal.idempotencyKey);
    const byId = byKey ?? (await uow.findProposalById(proposal.proposalId));
    if (byId === null) return null;

    const sameRequest =
      byId.proposalHash === proposalHash &&
      byId.accountId === proposal.accountId &&
      byId.idempotencyKey === proposal.idempotencyKey &&
      byId.proposalId === proposal.proposalId;
    if (!sameRequest) {
      // Auditoria do conflito sem o payload divergente.
      await uow.appendAudit({
        eventId: this.deps.ids.uuid(),
        eventType: 'IDEMPOTENCY_CONFLICT',
        correlationId: proposal.correlationId,
        accountId: proposal.accountId,
        // proposalId pertencente a outra conta não é gravado na auditoria desta conta.
        proposalId: byId.accountId === proposal.accountId ? byId.proposalId : null,
        decisionId: null,
        reservationId: null,
        details: { idempotencyKey: proposal.idempotencyKey, attemptedProposalId: proposal.proposalId },
        createdAt: this.deps.clock.now().toISOString(),
      });
      return { kind: 'IDEMPOTENCY_CONFLICT' };
    }

    // Replay devolve a decisão original, revalidada: nada lido do banco é aceito sem checagem.
    const original = validateRiskDecision(await uow.findDecisionByProposalId(byId.proposalId));
    if (!original.ok) throw new Error('decisão persistida ausente ou inválida');
    return { kind: 'DECISION', decision: original.value, replayed: true };
  }

  private async loadConversion(policyDocument: unknown, instrument: unknown, accountId: string) {
    // Câmbio só é buscado quando política e instrumento válidos indicam moedas diferentes.
    const policy = validateRiskPolicy(policyDocument, { now: this.deps.clock.now(), accountId });
    if (!policy.ok || !isRecord(instrument) || typeof instrument['quoteCurrency'] !== 'string') return null;
    if (instrument['quoteCurrency'] === policy.value.baseCurrency) return null;
    return this.deps.marketData.fxRate(instrument['quoteCurrency'], policy.value.baseCurrency);
  }

  private toDecision(evaluation: RiskEvaluation, proposal: TradeProposalV1, proposalHash: string): RiskDecisionV1 {
    const b = evaluation.bindings;
    const base = {
      schemaVersion: 1 as const,
      decisionId: this.deps.ids.uuid(),
      proposalId: proposal.proposalId,
      accountId: proposal.accountId,
      agentId: b.agentId,
      proposalHash,
      policyId: b.policyId,
      policyVersion: b.policyVersion,
      policyHash: b.policyHash,
      evaluatedAt: evaluation.evaluatedAt,
      marketDataAsOf: b.marketDataAsOf,
      snapshotVersion: b.snapshotVersion,
      correlationId: proposal.correlationId,
    };
    if (evaluation.outcome === 'ELIGIBLE') {
      return {
        ...base,
        status: 'ALLOW_PAPER',
        violations: [],
        reservationId: this.deps.ids.uuid(),
        authorizationExpiresAt: evaluation.authorizationExpiresAt,
      };
    }
    return { ...base, status: 'BLOCK', violations: evaluation.violations, reservationId: null, authorizationExpiresAt: null };
  }

  private async recordEvents(uow: RiskUnitOfWork, decision: RiskDecisionV1, now: UtcInstant): Promise<void> {
    const at = now.toISOString();
    const common = {
      correlationId: decision.correlationId,
      accountId: decision.accountId,
      proposalId: decision.proposalId,
      decisionId: decision.decisionId,
      reservationId: decision.reservationId,
      createdAt: at,
    };
    await uow.appendAudit({
      ...common,
      eventId: this.deps.ids.uuid(),
      eventType: 'DECISION_RECORDED',
      details: {
        status: decision.status,
        agentId: decision.agentId,
        policyVersion: decision.policyVersion,
        violationCodes: decision.violations.map((v) => v.code),
      },
    });
    if (decision.reservationId !== null) {
      await uow.appendAudit({
        ...common,
        eventId: this.deps.ids.uuid(),
        eventType: 'RESERVATION_CREATED',
        details: { expiresAt: decision.authorizationExpiresAt },
      });
    }
    // Evento sanitizado e não autorizativo; publicado só depois do COMMIT por um relay futuro.
    await uow.appendOutbox({
      eventId: this.deps.ids.uuid(),
      aggregateId: decision.decisionId,
      eventType: 'risk.decision.recorded',
      payload: {
        decisionId: decision.decisionId,
        proposalId: decision.proposalId,
        accountId: decision.accountId,
        agentId: decision.agentId,
        status: decision.status,
        violationCodes: decision.violations.map((v) => v.code),
        correlationId: decision.correlationId,
      },
      createdAt: at,
    });
  }
}

function buildContext(
  snapshot: AccountSnapshot,
  reserved: ReservedExposure,
  quote: Awaited<ReturnType<MarketDataProvider['quote']>>,
  conversion: Awaited<ReturnType<MarketDataProvider['fxRate']>>,
): Record<string, unknown> {
  return {
    accountId: snapshot.accountId,
    snapshotVersion: snapshot.snapshotVersion,
    asOf: snapshot.asOf,
    equityBase: snapshot.equityBase,
    availableCashBase: snapshot.availableCashBase,
    realizedDailyPnlBase: snapshot.realizedDailyPnlBase,
    unrealizedPnlBase: snapshot.unrealizedPnlBase,
    openGrossExposureBase: snapshot.openGrossExposureBase,
    pendingReservedExposureBase: reserved.totalBase,
    instrumentExposureBase: addDecimals(snapshot.openInstrumentExposureBase, reserved.instrumentBase),
    strategyExposureBase: addDecimals(snapshot.openStrategyExposureBase, reserved.strategyBase),
    ...(quote ? { market: quote } : {}),
    ...(conversion ? { conversion } : {}),
  };
}

/** Soma exata; entrada inválida produz valor que o schema do contexto rejeita (fail-closed). */
function addDecimals(a: string, b: string): string {
  const x = DecimalAmount.parse(a);
  const y = DecimalAmount.parse(b);
  return x.ok && y.ok ? x.value.plus(y.value).toString() : 'INVALID';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

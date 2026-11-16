import { validateInstrumentSpec, type InstrumentSpec } from '../domain/InstrumentSpec.js';
import { validateRiskContext, type RiskContextV1 } from '../domain/RiskContext.js';
import { validateRiskPolicy, type RiskPolicyV1 } from '../domain/RiskPolicy.js';
import type { RiskViolationCode, RiskViolationV1 } from '../domain/RiskViolation.js';
import { computeProposalHash, validateTradeProposal, type TradeProposalV1 } from '../domain/TradeProposal.js';
import { DecimalAmount } from '../domain/value-objects/DecimalAmount.js';
import type { UtcInstant } from '../domain/value-objects/UtcInstant.js';
import { CashAndMarginRule } from './CashAndMarginRule.js';
import { DailyLossRule } from './DailyLossRule.js';
import { ExposureRule } from './ExposureRule.js';
import { FxRateRule } from './FxRateRule.js';
import { InstrumentRule } from './InstrumentRule.js';
import { MarketDataRule } from './MarketDataRule.js';
import { MarketFreshnessRule } from './MarketFreshnessRule.js';
import { OrderNotionalRule } from './OrderNotionalRule.js';
import { PerTradeRiskRule } from './PerTradeRiskRule.js';
import { PolicyApplicabilityRule } from './PolicyApplicabilityRule.js';
import type { RiskRule, RiskRuleInput } from './RiskRule.js';
import { instant, violation } from './ruleSupport.js';
import { computeTradeMetrics } from './tradeMetrics.js';
import { StopLossRule } from './StopLossRule.js';

/** Ordem fixa da SPEC §5 (regras 2–11). A regra 1 é feita antes; a 12 (reserva) é transacional (etapa 2.3). */
export const DEFAULT_RULES: readonly RiskRule[] = Object.freeze([
  PolicyApplicabilityRule,
  MarketFreshnessRule,
  InstrumentRule,
  MarketDataRule,
  FxRateRule,
  StopLossRule,
  OrderNotionalRule,
  PerTradeRiskRule,
  CashAndMarginRule,
  ExposureRule,
  DailyLossRule,
]);

/** Registro da conta lido no servidor; o campo declarado na proposta não prova que a conta é PAPER. */
export interface ServerAccountRecord {
  readonly accountId: string;
  readonly environment: string;
}

/** Entradas brutas: tudo exceto `now` e identidade é validado aqui. Ausência = `null`. */
export interface RiskEvaluationRequest {
  readonly proposal: unknown;
  readonly authenticatedAgentId: string;
  /** Grant ativo (conta, agente) lido sob o lock da conta; `null` = sem grant e bloqueia tudo. */
  readonly accountAgentGrant: { readonly accountId: string; readonly agentId: string } | null;
  readonly account: ServerAccountRecord | null;
  readonly policy: unknown;
  readonly context: unknown;
  readonly instrument: unknown;
  readonly now: UtcInstant;
  readonly clockSkewToleranceMs: number;
}

export interface EvaluationBindings {
  readonly accountId: string | null;
  readonly agentId: string;
  readonly proposalId: string | null;
  readonly proposalHash: string | null;
  readonly correlationId: string | null;
  readonly policyId: string | null;
  readonly policyVersion: string | null;
  readonly policyHash: string | null;
  readonly marketDataAsOf: string | null;
  readonly snapshotVersion: string | null;
}

/** Valores a reservar na etapa 2.3, em moeda-base, como strings decimais exatas. */
export interface ReservationRequest {
  readonly accountId: string;
  readonly instrument: string;
  readonly strategyId: string;
  readonly exposureBase: string;
  readonly tradeRiskBase: string;
}

/**
 * Resultado puro. `ELIGIBLE` NÃO é autorização: `ALLOW_PAPER` só existe após a reserva
 * transacional persistida (etapa 2.3, SPEC §4.4).
 */
export type RiskEvaluation =
  | {
      readonly outcome: 'ELIGIBLE';
      readonly violations: readonly [];
      readonly evaluatedAt: string;
      readonly bindings: { readonly [K in keyof EvaluationBindings]: NonNullable<EvaluationBindings[K]> };
      /** min(now + maxAuthorizationTtlMs, proposal.expiresAt): autorização não sobrevive à proposta. */
      readonly authorizationExpiresAt: string;
      readonly reservation: ReservationRequest;
    }
  | {
      readonly outcome: 'BLOCK';
      readonly violations: readonly [RiskViolationV1, ...RiskViolationV1[]];
      readonly evaluatedAt: string;
      readonly bindings: EvaluationBindings;
    };

export interface RiskEvaluator {
  evaluate(request: RiskEvaluationRequest): RiskEvaluation;
}

/** Avaliador determinístico: mesma entrada → mesmo resultado. Qualquer exceção → BLOCK. */
export function createRiskEvaluator(rules: readonly RiskRule[] = DEFAULT_RULES): RiskEvaluator {
  // Pipeline vazio aprovaria tudo sem verificar risco.
  if (rules.length === 0) throw new RangeError('avaliador exige ao menos uma regra');
  const pipeline = Object.freeze([...rules]);
  return {
    evaluate(request) {
      const evaluatedAt = request.now.toISOString();
      let bindings: EvaluationBindings = {
        accountId: null,
        agentId: request.authenticatedAgentId,
        proposalId: null,
        proposalHash: null,
        correlationId: null,
        policyId: null,
        policyVersion: null,
        policyHash: null,
        marketDataAsOf: null,
        snapshotVersion: null,
      };
      const block = (violations: readonly RiskViolationV1[]): RiskEvaluation => {
        const [first, ...rest] = violations;
        const safe: [RiskViolationV1, ...RiskViolationV1[]] = first
          ? [first, ...rest]
          : [{ code: 'INTERNAL_EVALUATION_FAILURE', message: 'bloqueio sem motivo registrado' }];
        return { outcome: 'BLOCK', violations: safe, evaluatedAt, bindings };
      };

      try {
        // Regra 1: contrato, identidade autenticada, grant agente×conta e conta PAPER no servidor.
        const pre: RiskViolationV1[] = [];
        const grant = request.accountAgentGrant;
        let unauthorized = grant === null || grant.agentId !== request.authenticatedAgentId;
        if (unauthorized) {
          pre.push(violation('UNAUTHORIZED_AGENT', 'agentId', 'agente autenticado sem grant para a conta'));
        }
        const proposalResult = validateTradeProposal(request.proposal, {
          now: request.now,
          clockSkewToleranceMs: request.clockSkewToleranceMs,
          authenticatedAgentId: request.authenticatedAgentId,
        });
        if (!proposalResult.ok) return block([...pre, ...proposalResult.error]);

        const proposal = proposalResult.value;
        bindings = {
          ...bindings,
          accountId: proposal.accountId,
          proposalId: proposal.proposalId,
          proposalHash: computeProposalHash(proposal),
          correlationId: proposal.correlationId,
        };
        if (!unauthorized && grant?.accountId !== proposal.accountId) {
          unauthorized = true;
          pre.push(violation('UNAUTHORIZED_AGENT', 'agentId', 'agente autenticado sem grant para a conta'));
        }
        const account = request.account;
        if (account?.accountId !== proposal.accountId || account.environment !== 'PAPER') {
          pre.push(violation('NON_PAPER_ENVIRONMENT', 'accountId', 'conta não confirmada como PAPER no servidor', proposal.accountId));
        }
        if (pre.length > 0) return block(pre);

        // Regra 2: política íntegra e aplicável.
        const policyResult = validateRiskPolicy(request.policy, { now: request.now, accountId: proposal.accountId });
        if (!policyResult.ok) return block(policyResult.error);
        const policy = policyResult.value;
        bindings = { ...bindings, policyId: policy.policyId, policyVersion: policy.version, policyHash: policy.policyHash };

        // Contexto e catálogo: lacunas estruturais bloqueiam antes das regras.
        const loaded = loadInputs(request);
        if (!loaded.ok) return block(loaded.violations);
        const { context, instrument } = loaded;
        bindings = { ...bindings, marketDataAsOf: context.market.asOf, snapshotVersion: context.snapshotVersion };

        const input: RiskRuleInput = Object.freeze({
          proposal,
          policy,
          context,
          instrument,
          now: request.now,
          clockSkewToleranceMs: request.clockSkewToleranceMs,
        });

        const violations: RiskViolationV1[] = [];
        for (const rule of pipeline) {
          // Defensivo: regra que não devolve array nunca é tratada como "sem violações".
          const result: unknown = rule.evaluate(input);
          if (!Array.isArray(result)) throw new TypeError(`regra ${rule.id} retornou resultado inválido`);
          violations.push(...(result as readonly RiskViolationV1[]));
          if (rule.haltOnViolation && violations.length > 0) break;
        }
        if (violations.length > 0) return block(violations);

        return eligible(proposal, policy, context, input, evaluatedAt, bindings);
      } catch (error) {
        // Nunca registrar a entrada bruta: apenas o tipo do erro.
        const kind = error instanceof Error ? error.name : typeof error;
        return block([{ code: 'INTERNAL_EVALUATION_FAILURE', message: `falha inesperada na avaliação (${kind}); sem autorização` }]);
      }
    },
  };
}

type Loaded =
  | { readonly ok: true; readonly context: RiskContextV1; readonly instrument: InstrumentSpec }
  | { readonly ok: false; readonly violations: readonly RiskViolationV1[] };

function loadInputs(request: RiskEvaluationRequest): Loaded {
  const violations: RiskViolationV1[] = [];

  let context: RiskContextV1 | undefined;
  if (request.context === null || request.context === undefined) {
    violations.push(violation('ACCOUNT_SNAPSHOT_STALE', 'context', 'snapshot da conta indisponível'));
  } else {
    const r = validateRiskContext(request.context);
    if (r.ok) context = r.value;
    else for (const issue of r.error) violations.push(violation(contextCode(issue.field), issue.field ?? 'context', issue.message));
  }

  let instrument: InstrumentSpec | undefined;
  if (request.instrument === null || request.instrument === undefined) {
    violations.push(violation('INSTRUMENT_NOT_ALLOWED', 'instrument', 'instrumento desconhecido no catálogo'));
  } else {
    const r = validateInstrumentSpec(request.instrument);
    if (r.ok) instrument = r.value;
    else violations.push(violation('INSTRUMENT_NOT_ALLOWED', 'instrument', 'especificação de catálogo inválida'));
  }

  if (violations.length > 0 || !context || !instrument) {
    return { ok: false, violations: dedupe(violations) };
  }
  return { ok: true, context, instrument };
}

function contextCode(field: string | undefined): RiskViolationCode {
  if (field?.startsWith('market') === true) return 'MARKET_DATA_UNAVAILABLE';
  if (field?.startsWith('conversion') === true) return 'FX_RATE_UNAVAILABLE';
  return 'ACCOUNT_SNAPSHOT_STALE';
}

function dedupe(violations: readonly RiskViolationV1[]): RiskViolationV1[] {
  const seen = new Set<string>();
  return violations.filter((v) => {
    const key = `${v.code}|${v.field ?? ''}|${v.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function eligible(
  proposal: TradeProposalV1,
  policy: RiskPolicyV1,
  context: RiskContextV1,
  input: RiskRuleInput,
  evaluatedAt: string,
  bindings: EvaluationBindings,
): RiskEvaluation {
  const { accountId, proposalId, proposalHash, correlationId, policyId, policyVersion, policyHash, marketDataAsOf, snapshotVersion } = bindings;
  if (
    accountId === null || proposalId === null || proposalHash === null || correlationId === null ||
    policyId === null || policyVersion === null || policyHash === null || marketDataAsOf === null || snapshotVersion === null
  ) {
    throw new Error('vínculos incompletos para decisão elegível');
  }

  const ttlEnd = input.now.plusMillis(policy.maxAuthorizationTtlMs);
  const proposalEnd = instant(proposal.expiresAt);
  const authorizationExpiresAt = (ttlEnd.isBefore(proposalEnd) ? ttlEnd : proposalEnd).toISOString();
  const metrics = computeTradeMetrics(input);

  return {
    outcome: 'ELIGIBLE',
    violations: [],
    evaluatedAt,
    bindings: {
      accountId, agentId: bindings.agentId, proposalId, proposalHash, correlationId,
      policyId, policyVersion, policyHash, marketDataAsOf, snapshotVersion,
    },
    authorizationExpiresAt,
    reservation: {
      accountId: context.accountId,
      instrument: proposal.instrument,
      strategyId: proposal.strategyId,
      // Produtos podem exceder a escala técnica; arredondar para cima nunca subestima a reserva.
      exposureBase: metrics.notionalBase.roundUpToScale(DecimalAmount.MAX_SCALE).toString(),
      tradeRiskBase: metrics.tradeRiskBase.roundUpToScale(DecimalAmount.MAX_SCALE).toString(),
    },
  };
}

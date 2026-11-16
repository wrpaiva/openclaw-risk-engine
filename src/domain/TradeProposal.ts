import { z } from 'zod';
import { sha256Canonical } from './canonicalHash.js';
import { err, ok, type Result } from './Result.js';
import type { RiskViolationV1 } from './RiskViolation.js';
import {
  assertNonNegativeSafeInteger,
  decimalString,
  instantString,
  issueField,
  mustParseInstant,
  opaqueId,
} from './schemaSupport.js';
import type { UtcInstant } from './value-objects/UtcInstant.js';

export const MARKETS = ['CRYPTO', 'FOREX', 'METALS'] as const;
export type Market = (typeof MARKETS)[number];
export type Side = 'BUY' | 'SELL';
export type Environment = 'PAPER';

export interface TradeProposalV1 {
  readonly schemaVersion: 1;
  readonly proposalId: string;
  readonly idempotencyKey: string;
  readonly accountId: string;
  readonly agentId: string;
  readonly environment: Environment;
  readonly market: Market;
  readonly instrument: string;
  readonly side: Side;
  readonly orderType: 'MARKET' | 'LIMIT';
  readonly quantity: string;
  readonly limitPrice?: string | undefined;
  readonly referencePrice: string;
  readonly stopLossPrice: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly strategyId: string;
  readonly correlationId: string;
}

const positiveDecimal = () => decimalString({ positive: true });

// Escala por instrumento é verificada contra o catálogo na regra de instrumento (etapa 2.2).
const tradeProposalSchema = z.strictObject({
  schemaVersion: z.literal(1),
  proposalId: z.uuid(),
  idempotencyKey: opaqueId(),
  accountId: opaqueId(),
  agentId: opaqueId(),
  environment: z.literal('PAPER'),
  market: z.enum(MARKETS),
  instrument: opaqueId(),
  side: z.enum(['BUY', 'SELL']),
  orderType: z.enum(['MARKET', 'LIMIT']),
  quantity: positiveDecimal(),
  limitPrice: positiveDecimal().optional(),
  referencePrice: positiveDecimal(),
  stopLossPrice: positiveDecimal(),
  createdAt: instantString(),
  expiresAt: instantString(),
  strategyId: opaqueId(),
  correlationId: opaqueId(),
}) satisfies z.ZodType<TradeProposalV1>;

export interface ProposalValidationContext {
  readonly now: UtcInstant;
  /** Tolerância de relógio para `createdAt` no futuro. Obrigatória; sem padrão. */
  readonly clockSkewToleranceMs: number;
  /** Identidade vinda da autenticação do transporte, nunca do payload. */
  readonly authenticatedAgentId: string;
}

/**
 * Contrato estrutural, sem relógio nem identidade: schema v1, ambiente PAPER e coerência interna.
 * Usado pelo adaptador para rejeitar (400/422) antes de qualquer persistência.
 */
export function parseTradeProposalContract(input: unknown): Result<TradeProposalV1, readonly RiskViolationV1[]> {
  const parsed = tradeProposalSchema.safeParse(input);
  if (!parsed.success) {
    return err(
      parsed.error.issues.map((issue): RiskViolationV1 => {
        const field = issueField(issue);
        return field === 'environment'
          ? { code: 'NON_PAPER_ENVIRONMENT', field, message: 'somente o ambiente PAPER é aceito' }
          : { code: 'INVALID_PROPOSAL', ...(field ? { field } : {}), message: `contrato inválido: ${issue.message}` };
      }),
    );
  }

  const proposal = parsed.data;
  const violations: RiskViolationV1[] = [];
  if (proposal.orderType === 'LIMIT' && proposal.limitPrice === undefined) {
    violations.push({ code: 'INVALID_PROPOSAL', field: 'limitPrice', message: 'limitPrice é obrigatório para LIMIT' });
  }
  if (proposal.orderType === 'MARKET' && proposal.limitPrice !== undefined) {
    violations.push({ code: 'INVALID_PROPOSAL', field: 'limitPrice', message: 'limitPrice não é permitido em MARKET' });
  }
  if (!mustParseInstant(proposal.expiresAt).isAfter(mustParseInstant(proposal.createdAt))) {
    violations.push({ code: 'INVALID_PROPOSAL', field: 'expiresAt', message: 'expiresAt deve ser posterior a createdAt' });
  }
  return violations.length > 0 ? err(violations) : ok(proposal);
}

/** Identidade do payload confere com a do transporte (nunca o contrário). */
export function payloadAgentMatches(input: unknown, authenticatedAgentId: string): boolean {
  return authenticatedAgentId !== '' && isRecord(input) && input['agentId'] === authenticatedAgentId;
}

/**
 * Valida contrato, ambiente, identidade e janela temporal (regra 1 da SPEC §5).
 * Grant agente×conta e confirmação server-side da conta PAPER ficam no avaliador.
 */
export function validateTradeProposal(
  input: unknown,
  context: ProposalValidationContext,
): Result<TradeProposalV1, readonly RiskViolationV1[]> {
  assertNonNegativeSafeInteger(context.clockSkewToleranceMs, 'clockSkewToleranceMs');

  const violations: RiskViolationV1[] = [];
  if (isRecord(input) && !payloadAgentMatches(input, context.authenticatedAgentId)) {
    violations.push({
      code: 'UNAUTHORIZED_AGENT',
      field: 'agentId',
      message: 'agentId do payload não corresponde à identidade autenticada',
    });
  }

  // Schema inválido impede as verificações temporais; incoerências internas não.
  const parsed = tradeProposalSchema.safeParse(input);
  const contract = parseTradeProposalContract(input);
  if (!contract.ok) violations.push(...contract.error);
  if (!parsed.success) return err(violations);

  const proposal = parsed.data;
  const createdAt = mustParseInstant(proposal.createdAt);
  const expiresAt = mustParseInstant(proposal.expiresAt);
  if (createdAt.isAfter(context.now.plusMillis(context.clockSkewToleranceMs))) {
    violations.push({
      code: 'INVALID_PROPOSAL',
      field: 'createdAt',
      message: 'createdAt no futuro além da tolerância de relógio',
      observed: proposal.createdAt,
      limit: context.now.plusMillis(context.clockSkewToleranceMs).toISOString(),
    });
  }
  if (!context.now.isBefore(expiresAt)) {
    violations.push({
      code: 'PROPOSAL_EXPIRED',
      field: 'expiresAt',
      message: 'proposta vencida',
      observed: proposal.expiresAt,
      limit: context.now.toISOString(),
    });
  }

  return violations.length > 0 ? err(violations) : ok(proposal);
}

/** SHA-256 do JSON canônico da proposta validada (vínculo I-06 e idempotência). */
export function computeProposalHash(proposal: TradeProposalV1): string {
  return sha256Canonical(
    Object.fromEntries(Object.entries(proposal).filter(([, v]) => v !== undefined)),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

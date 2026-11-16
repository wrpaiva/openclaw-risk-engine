import { z } from 'zod';
import { sha256Canonical } from './canonicalHash.js';
import { err, ok, type Result } from './Result.js';
import type { RiskViolationV1 } from './RiskViolation.js';
import { decimalString, instantString, issueField, mustParseInstant, opaqueId } from './schemaSupport.js';
import { MARKETS, type Market } from './TradeProposal.js';
import type { UtcInstant } from './value-objects/UtcInstant.js';

/**
 * Política versionada e imutável (SPEC §4.2, ADR-0005).
 * Não existem valores financeiros padrão: política incompleta nunca é habilitável.
 */
export interface RiskPolicyV1 {
  readonly policyId: string;
  readonly version: string;
  readonly policyHash: string;
  readonly status: 'ACTIVE' | 'RETIRED';
  readonly validFrom: string;
  readonly validUntil?: string | undefined;
  readonly accountId: string;
  readonly baseCurrency: string;
  readonly maxOrderNotionalBase: string;
  readonly maxGrossExposureBase: string;
  readonly maxInstrumentExposureBase: string;
  readonly maxStrategyExposureBase: string;
  readonly maxDailyLossBase: string;
  readonly maxRiskPerTradeBase: string;
  readonly minAvailableCashBase: string;
  readonly maxMarketDataAgeMs: number;
  readonly maxAccountSnapshotAgeMs: number;
  readonly maxFxRateAgeMs: number;
  readonly maxProposalTtlMs: number;
  readonly maxAuthorizationTtlMs: number;
  readonly mandatoryStopLoss: true;
  readonly allowedMarkets: readonly Market[];
  readonly allowedInstruments: readonly string[];
  readonly enabled: boolean;
}

const limit = () => decimalString({ positive: true });
const durationMs = () => z.number().int().positive();
const uniqueNonEmpty = <T extends z.ZodType>(item: T) =>
  z
    .array(item)
    .min(1)
    .refine((xs) => new Set(xs).size === xs.length, { message: 'itens duplicados' });

const riskPolicySchema = z.strictObject({
  policyId: opaqueId(),
  version: opaqueId(),
  policyHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  status: z.enum(['ACTIVE', 'RETIRED']),
  validFrom: instantString(),
  validUntil: instantString().optional(),
  accountId: opaqueId(),
  baseCurrency: z.string().regex(/^[A-Z][A-Z0-9]{2,9}$/),
  maxOrderNotionalBase: limit(),
  maxGrossExposureBase: limit(),
  maxInstrumentExposureBase: limit(),
  maxStrategyExposureBase: limit(),
  maxDailyLossBase: limit(),
  maxRiskPerTradeBase: limit(),
  minAvailableCashBase: decimalString({}),
  maxMarketDataAgeMs: durationMs(),
  maxAccountSnapshotAgeMs: durationMs(),
  maxFxRateAgeMs: durationMs(),
  maxProposalTtlMs: durationMs(),
  maxAuthorizationTtlMs: durationMs(),
  mandatoryStopLoss: z.literal(true),
  allowedMarkets: uniqueNonEmpty(z.enum(MARKETS)),
  allowedInstruments: uniqueNonEmpty(opaqueId()),
  enabled: z.boolean(),
}) satisfies z.ZodType<RiskPolicyV1>;

/** SHA-256 do JSON canônico da política, excluindo o próprio `policyHash` e campos ausentes. */
export function computePolicyHash(policy: Omit<RiskPolicyV1, 'policyHash'>): string {
  const document = Object.fromEntries(
    // Documento chega de fontes não tipadas (DB/fixtures): campos `undefined` equivalem a ausentes.
    Object.entries(policy as Readonly<Record<string, unknown>>).filter(([key, value]) => key !== 'policyHash' && value !== undefined),
  );
  return sha256Canonical(document);
}

export interface PolicyValidationContext {
  readonly now: UtcInstant;
  readonly accountId: string;
}

/** Regra 2 da SPEC §5: política válida, completa, íntegra, aplicável e ativa. */
export function validateRiskPolicy(
  input: unknown,
  context: PolicyValidationContext,
): Result<RiskPolicyV1, readonly RiskViolationV1[]> {
  if (input === null || input === undefined) {
    return err([{ code: 'POLICY_MISSING', message: 'nenhuma política aplicável encontrada' }]);
  }

  const parsed = riskPolicySchema.safeParse(input);
  if (!parsed.success) {
    return err(
      parsed.error.issues.map((issue): RiskViolationV1 => {
        const field = issueField(issue);
        return { code: 'POLICY_INVALID', ...(field ? { field } : {}), message: `política inválida: ${issue.message}` };
      }),
    );
  }

  const policy = parsed.data;
  const violations: RiskViolationV1[] = [];
  const invalid = (field: string, message: string, observed?: string, limitValue?: string) =>
    violations.push({
      code: 'POLICY_INVALID',
      field,
      message,
      ...(observed !== undefined ? { observed } : {}),
      ...(limitValue !== undefined ? { limit: limitValue } : {}),
    });

  const expectedHash = computePolicyHash(policy);
  if (policy.policyHash !== expectedHash) {
    invalid('policyHash', 'hash não corresponde ao documento canônico', policy.policyHash, expectedHash);
  }
  if (policy.status !== 'ACTIVE') invalid('status', 'política não está ACTIVE', policy.status);
  if (!policy.enabled) invalid('enabled', 'política desabilitada');
  if (policy.accountId !== context.accountId) {
    invalid('accountId', 'política pertence a outra conta', policy.accountId, context.accountId);
  }

  const validFrom = mustParseInstant(policy.validFrom);
  const validUntil = policy.validUntil === undefined ? undefined : mustParseInstant(policy.validUntil);
  if (validUntil !== undefined && !validUntil.isAfter(validFrom)) {
    invalid('validUntil', 'validUntil deve ser posterior a validFrom');
  }
  if (context.now.isBefore(validFrom)) {
    invalid('validFrom', 'política ainda não vigente', context.now.toISOString(), policy.validFrom);
  }
  if (validUntil !== undefined && !context.now.isBefore(validUntil)) {
    invalid('validUntil', 'política expirada', context.now.toISOString(), policy.validUntil);
  }

  return violations.length > 0 ? err(violations) : ok(policy);
}

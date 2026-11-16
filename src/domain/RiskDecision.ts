import { z } from 'zod';
import { err, ok, type Result } from './Result.js';
import { RISK_VIOLATION_CODES, type RiskViolationV1 } from './RiskViolation.js';
import { instantString, issueField, mustParseInstant, opaqueId } from './schemaSupport.js';

export type DecisionStatus = 'ALLOW_PAPER' | 'BLOCK';

/** Decisão do motor (SPEC §4.4). `ALLOW_PAPER` nunca autoriza ordem real (I-07). */
export interface RiskDecisionV1 {
  readonly schemaVersion: 1;
  readonly decisionId: string;
  readonly proposalId: string;
  readonly accountId: string;
  readonly agentId: string;
  readonly proposalHash: string;
  readonly policyId: string | null;
  readonly policyVersion: string | null;
  readonly policyHash: string | null;
  readonly status: DecisionStatus;
  readonly violations: readonly RiskViolationV1[];
  readonly evaluatedAt: string;
  readonly marketDataAsOf: string | null;
  readonly snapshotVersion: string | null;
  readonly reservationId: string | null;
  readonly authorizationExpiresAt: string | null;
  readonly correlationId: string;
}

const sha256 = () => z.string().regex(/^sha256:[0-9a-f]{64}$/);

const riskViolationSchema = z.strictObject({
  code: z.enum(RISK_VIOLATION_CODES),
  field: z.string().min(1).optional(),
  message: z.string().min(1),
  observed: z.string().optional(),
  limit: z.string().optional(),
});

const riskDecisionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  decisionId: z.uuid(),
  proposalId: z.uuid(),
  accountId: opaqueId(),
  agentId: opaqueId(),
  proposalHash: sha256(),
  policyId: opaqueId().nullable(),
  policyVersion: opaqueId().nullable(),
  policyHash: sha256().nullable(),
  status: z.enum(['ALLOW_PAPER', 'BLOCK']),
  violations: z.array(riskViolationSchema),
  evaluatedAt: instantString(),
  marketDataAsOf: instantString().nullable(),
  snapshotVersion: opaqueId().nullable(),
  reservationId: z.uuid().nullable(),
  authorizationExpiresAt: instantString().nullable(),
  correlationId: opaqueId(),
}) satisfies z.ZodType<RiskDecisionV1>;

export interface DecisionInvariantError {
  readonly field?: string;
  readonly message: string;
}

/**
 * Valida contrato e invariantes da decisão (SPEC §4.4, I-02, I-06):
 * `ALLOW_PAPER` exige zero violações, reserva, TTL futuro e vínculos completos;
 * `BLOCK` exige motivo e nunca carrega reserva ou autorização.
 * A existência da reserva persistida é verificada na etapa de persistência (2.3).
 */
export function validateRiskDecision(input: unknown): Result<RiskDecisionV1, readonly DecisionInvariantError[]> {
  const parsed = riskDecisionSchema.safeParse(input);
  if (!parsed.success) {
    return err(
      parsed.error.issues.map((issue): DecisionInvariantError => {
        const field = issueField(issue);
        return { ...(field ? { field } : {}), message: `decisão inválida: ${issue.message}` };
      }),
    );
  }

  const decision = parsed.data;
  const errors: DecisionInvariantError[] = [];
  const fail = (field: string, message: string) => errors.push({ field, message });

  if (decision.status === 'ALLOW_PAPER') {
    if (decision.violations.length > 0) fail('violations', 'ALLOW_PAPER exige violations=[]');
    for (const field of [
      'reservationId',
      'authorizationExpiresAt',
      'policyId',
      'policyVersion',
      'policyHash',
      'marketDataAsOf',
      'snapshotVersion',
    ] as const) {
      if (decision[field] === null) fail(field, `ALLOW_PAPER exige ${field}`);
    }
    if (decision.authorizationExpiresAt !== null) {
      const evaluatedAt = mustParseInstant(decision.evaluatedAt);
      const expiresAt = mustParseInstant(decision.authorizationExpiresAt);
      if (!expiresAt.isAfter(evaluatedAt)) {
        fail('authorizationExpiresAt', 'autorização deve expirar depois de evaluatedAt');
      }
    }
  } else {
    if (decision.violations.length === 0) fail('violations', 'BLOCK exige ao menos uma violação');
    if (decision.reservationId !== null) fail('reservationId', 'BLOCK não pode carregar reserva');
    if (decision.authorizationExpiresAt !== null) {
      fail('authorizationExpiresAt', 'BLOCK não pode carregar autorização');
    }
  }

  return errors.length > 0 ? err(errors) : ok(decision);
}

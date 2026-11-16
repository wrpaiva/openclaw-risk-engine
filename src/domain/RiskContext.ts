import { z } from 'zod';
import { err, ok, type Result } from './Result.js';
import { decimalString, instantString, issueField, opaqueId } from './schemaSupport.js';

/**
 * Contexto montado exclusivamente por adaptadores confiáveis (SPEC §4.3).
 * Nunca derivado do payload do agente; `referencePrice` da proposta não substitui `market.bid/ask`.
 */
export interface RiskContextV1 {
  readonly accountId: string;
  readonly snapshotVersion: string;
  readonly asOf: string;
  readonly equityBase: string;
  readonly availableCashBase: string;
  readonly realizedDailyPnlBase: string;
  readonly unrealizedPnlBase: string;
  readonly openGrossExposureBase: string;
  readonly pendingReservedExposureBase: string;
  readonly instrumentExposureBase: string;
  readonly strategyExposureBase: string;
  readonly market: {
    readonly instrument: string;
    readonly bid: string;
    readonly ask: string;
    readonly asOf: string;
    readonly source: string;
    readonly sourceSequence?: string | undefined;
  };
  readonly conversion?:
    | {
        readonly fromCurrency: string;
        readonly toCurrency: string;
        readonly rate: string;
        readonly asOf: string;
        readonly source: string;
      }
    | undefined;
}

const currency = () => z.string().regex(/^[A-Z][A-Z0-9]{2,9}$/);
const nonNegative = () => decimalString({});
const signed = () => decimalString({ allowNegative: true });
const positive = () => decimalString({ positive: true });

const riskContextSchema = z.strictObject({
  accountId: opaqueId(),
  snapshotVersion: opaqueId(),
  asOf: instantString(),
  equityBase: signed(),
  availableCashBase: signed(),
  realizedDailyPnlBase: signed(),
  unrealizedPnlBase: signed(),
  openGrossExposureBase: nonNegative(),
  pendingReservedExposureBase: nonNegative(),
  instrumentExposureBase: nonNegative(),
  strategyExposureBase: nonNegative(),
  market: z.strictObject({
    instrument: opaqueId(),
    bid: positive(),
    ask: positive(),
    asOf: instantString(),
    source: opaqueId(),
    sourceSequence: opaqueId().optional(),
  }),
  conversion: z
    .strictObject({
      fromCurrency: currency(),
      toCurrency: currency(),
      rate: positive(),
      asOf: instantString(),
      source: opaqueId(),
    })
    .optional(),
}) satisfies z.ZodType<RiskContextV1>;

export interface RiskContextError {
  readonly field?: string;
  readonly message: string;
}

/**
 * Validação estrutural do contexto. Freshness, spread, coerência bid/ask e câmbio
 * são regras do motor (etapa 2.2); aqui apenas lacunas e formatos são rejeitados.
 */
export function validateRiskContext(input: unknown): Result<RiskContextV1, readonly RiskContextError[]> {
  const parsed = riskContextSchema.safeParse(input);
  if (parsed.success) return ok(parsed.data);
  return err(
    parsed.error.issues.map((issue): RiskContextError => {
      const field = issueField(issue);
      return { ...(field ? { field } : {}), message: `contexto inválido: ${issue.message}` };
    }),
  );
}

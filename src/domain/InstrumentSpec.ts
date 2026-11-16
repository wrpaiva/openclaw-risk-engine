import { z } from 'zod';
import { err, ok, type Result } from './Result.js';
import { decimalString, issueField, opaqueId } from './schemaSupport.js';
import { MARKETS, type Market } from './TradeProposal.js';
import { DecimalAmount } from './value-objects/DecimalAmount.js';

/**
 * Especificação de instrumento do catálogo (SPEC §4.1, §5.1, ADR-0004).
 * Universo de instrumentos (D-02) e política de shorts/alavancagem (D-06) estão em aberto:
 * por isso só `SPOT` sem venda a descoberto é modelável nesta versão. Novos modelos de
 * produto/margem exigem decisão aprovada e nova versão de schema — nunca valores padrão.
 */
export interface InstrumentSpec {
  readonly schemaVersion: 1;
  readonly instrument: string;
  readonly market: Market;
  readonly productType: 'SPOT';
  readonly baseAsset: string;
  readonly quoteCurrency: string;
  /** Incremento mínimo de preço. */
  readonly tickSize: string;
  /** Incremento mínimo de quantidade. */
  readonly lotSize: string;
  readonly minQuantity: string;
  readonly priceScale: number;
  readonly quantityScale: number;
  readonly contractMultiplier: string;
  /** Sem modelo de margem/short aprovado, venda a descoberto é bloqueada (UT-017). */
  readonly shortSelling: 'UNSUPPORTED';
  readonly enabled: boolean;
}

const currency = () => z.string().regex(/^[A-Z][A-Z0-9]{2,9}$/);
const scale = () => z.number().int().min(0).max(DecimalAmount.MAX_SCALE);
const positive = () => decimalString({ positive: true });

const instrumentSpecSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    instrument: opaqueId(),
    market: z.enum(MARKETS),
    productType: z.literal('SPOT'),
    baseAsset: currency(),
    quoteCurrency: currency(),
    tickSize: positive(),
    lotSize: positive(),
    minQuantity: positive(),
    priceScale: scale(),
    quantityScale: scale(),
    contractMultiplier: positive(),
    shortSelling: z.literal('UNSUPPORTED'),
    enabled: z.boolean(),
  })
  .superRefine((spec, ctx) => {
    // Incrementos precisam caber na escala declarada; caso contrário o catálogo é incoerente.
    // Zod executa o refinamento mesmo com campos já inválidos: escala inválida foi reportada acima.
    const fits = (field: 'tickSize' | 'lotSize' | 'minQuantity', maxScale: number) => {
      if (!Number.isInteger(maxScale) || maxScale < 0 || maxScale > DecimalAmount.MAX_SCALE) return;
      if (typeof spec[field] !== 'string') return;
      if (!DecimalAmount.parse(spec[field], { positive: true, maxScale }).ok) {
        ctx.addIssue({ code: 'custom', path: [field], message: `${field} excede a escala declarada` });
      }
    };
    fits('tickSize', spec.priceScale);
    fits('lotSize', spec.quantityScale);
    fits('minQuantity', spec.quantityScale);
  }) satisfies z.ZodType<InstrumentSpec>;

export interface InstrumentSpecError {
  readonly field?: string;
  readonly message: string;
}

/** Valida uma entrada do catálogo; entrada inválida torna o instrumento desconhecido (fail-closed). */
export function validateInstrumentSpec(input: unknown): Result<InstrumentSpec, readonly InstrumentSpecError[]> {
  const parsed = instrumentSpecSchema.safeParse(input);
  if (parsed.success) return ok(parsed.data);
  return err(
    parsed.error.issues.map((issue): InstrumentSpecError => {
      const field = issueField(issue);
      return { ...(field ? { field } : {}), message: `instrumento inválido: ${issue.message}` };
    }),
  );
}

import { describe, expect, it } from 'vitest';
import { computePolicyHash, validateRiskPolicy } from '../../../src/domain/RiskPolicy.js';
import type { RiskViolationCode } from '../../../src/domain/RiskViolation.js';
import { UtcInstant } from '../../../src/domain/value-objects/UtcInstant.js';
import { FIXTURE_ACCOUNT_ID, hashedPolicy, unhashedPolicy } from '../../fixtures/policies.js';
import { fixtureNow } from '../../fixtures/proposals.js';

const ctx = { now: fixtureNow(), accountId: FIXTURE_ACCOUNT_ID };

function codesOf(input: unknown, context = ctx): RiskViolationCode[] {
  const r = validateRiskPolicy(input, context);
  return r.ok ? [] : r.error.map((v) => v.code);
}

function fieldsOf(input: unknown): (string | undefined)[] {
  const r = validateRiskPolicy(input, ctx);
  return r.ok ? [] : r.error.map((v) => v.field);
}

function at(iso: string) {
  const r = UtcInstant.parse(iso);
  if (!r.ok) throw new Error(iso);
  return { ...ctx, now: r.value };
}

describe('validateRiskPolicy — política íntegra', () => {
  it('aceita política completa, ativa, vigente, da conta e com hash correto', () => {
    const r = validateRiskPolicy(hashedPolicy(), ctx);
    expect(r.ok).toBe(true);
  });

  it('aceita política sem validUntil (vigência aberta)', () => {
    expect(codesOf(hashedPolicy({ validUntil: undefined }))).toEqual([]);
  });

  it('aceita minAvailableCashBase igual a zero', () => {
    expect(codesOf(hashedPolicy({ minAvailableCashBase: '0' }))).toEqual([]);
  });
});

describe('validateRiskPolicy — ausência (UT-007)', () => {
  it.each([null, undefined])('retorna POLICY_MISSING para %s', (input) => {
    expect(codesOf(input)).toEqual(['POLICY_MISSING']);
  });
});

describe('validateRiskPolicy — política sem limites aprovados não ativa', () => {
  const required = [
    'maxOrderNotionalBase',
    'maxGrossExposureBase',
    'maxInstrumentExposureBase',
    'maxStrategyExposureBase',
    'maxDailyLossBase',
    'maxRiskPerTradeBase',
    'minAvailableCashBase',
    'maxMarketDataAgeMs',
    'maxAccountSnapshotAgeMs',
    'maxFxRateAgeMs',
    'maxProposalTtlMs',
    'maxAuthorizationTtlMs',
    'baseCurrency',
    'allowedMarkets',
    'allowedInstruments',
    'mandatoryStopLoss',
  ] as const;

  it.each(required)('rejeita política sem %s', (field) => {
    const input = hashedPolicy({ [field]: undefined });
    expect(codesOf(input)).toEqual(['POLICY_INVALID']);
    expect(fieldsOf(input)).toContain(field);
  });
});

describe('validateRiskPolicy — valores inválidos', () => {
  it.each([
    ['limite zero', { maxOrderNotionalBase: '0' }, 'maxOrderNotionalBase'],
    ['limite negativo', { maxDailyLossBase: '-1' }, 'maxDailyLossBase'],
    ['limite exponencial', { maxGrossExposureBase: '5e3' }, 'maxGrossExposureBase'],
    ['limite como number JS', { maxRiskPerTradeBase: 20 }, 'maxRiskPerTradeBase'],
    ['caixa mínimo negativo', { minAvailableCashBase: '-1' }, 'minAvailableCashBase'],
    ['duração zero', { maxMarketDataAgeMs: 0 }, 'maxMarketDataAgeMs'],
    ['duração como string', { maxProposalTtlMs: '60000' }, 'maxProposalTtlMs'],
    ['stop opcional', { mandatoryStopLoss: false }, 'mandatoryStopLoss'],
    ['mercados vazios', { allowedMarkets: [] }, 'allowedMarkets'],
    ['mercado desconhecido', { allowedMarkets: ['EQUITIES'] }, 'allowedMarkets.0'],
    ['mercado duplicado', { allowedMarkets: ['CRYPTO', 'CRYPTO'] }, 'allowedMarkets'],
    ['instrumentos vazios', { allowedInstruments: [] }, 'allowedInstruments'],
    ['instrumento duplicado', { allowedInstruments: ['A', 'A'] }, 'allowedInstruments'],
    ['moeda-base malformada', { baseCurrency: 'us dollar' }, 'baseCurrency'],
    ['status desconhecido', { status: 'DRAFT' }, 'status'],
    ['validFrom sem offset', { validFrom: '2026-11-01T00:00:00' }, 'validFrom'],
  ])('rejeita %s', (_label, override, field) => {
    const input = hashedPolicy(override);
    expect(codesOf(input)).toEqual(['POLICY_INVALID']);
    expect(fieldsOf(input)).toContain(field);
  });

  it('rejeita duração fracionária (antes mesmo de calcular o hash)', () => {
    const input = { ...unhashedPolicy({ maxFxRateAgeMs: 1.5 }), policyHash: `sha256:${'0'.repeat(64)}` };
    expect(codesOf(input)).toEqual(['POLICY_INVALID']);
    expect(fieldsOf(input)).toContain('maxFxRateAgeMs');
  });

  it('rejeita campos adicionais', () => {
    expect(codesOf({ ...hashedPolicy(), defaultLimit: '1' })).toEqual(['POLICY_INVALID']);
  });
});

describe('validateRiskPolicy — estado e vigência (UT-007)', () => {
  it('rejeita política RETIRED', () => {
    expect(fieldsOf(hashedPolicy({ status: 'RETIRED' }))).toEqual(['status']);
  });

  it('rejeita política desabilitada', () => {
    expect(fieldsOf(hashedPolicy({ enabled: false }))).toEqual(['enabled']);
  });

  it('rejeita antes de validFrom', () => {
    expect(codesOf(hashedPolicy(), at('2026-10-31T23:59:59.999Z'))).toEqual(['POLICY_INVALID']);
  });

  it('aceita exatamente em validFrom', () => {
    expect(codesOf(hashedPolicy(), at('2026-11-01T00:00:00.000Z'))).toEqual([]);
  });

  it('rejeita exatamente em validUntil (expirada; intervalo semiaberto)', () => {
    expect(codesOf(hashedPolicy(), at('2026-12-01T00:00:00.000Z'))).toEqual(['POLICY_INVALID']);
  });

  it('rejeita validUntil anterior ou igual a validFrom', () => {
    expect(fieldsOf(hashedPolicy({ validUntil: '2026-11-01T00:00:00.000Z' }))).toContain('validUntil');
  });

  it('rejeita política de outra conta', () => {
    expect(codesOf(hashedPolicy(), { ...ctx, accountId: 'paper-outra' })).toEqual(['POLICY_INVALID']);
  });
});

describe('validateRiskPolicy — integridade do hash', () => {
  it('rejeita documento alterado depois do hash', () => {
    const tampered = { ...hashedPolicy(), maxDailyLossBase: '1000000' };
    expect(fieldsOf(tampered)).toEqual(['policyHash']);
  });

  it('rejeita hash ausente ou malformado', () => {
    expect(fieldsOf({ ...hashedPolicy(), policyHash: undefined })).toContain('policyHash');
    expect(fieldsOf({ ...hashedPolicy(), policyHash: 'md5:abc' })).toContain('policyHash');
  });
});

describe('computePolicyHash', () => {
  it('não depende da ordem das chaves', () => {
    const doc = unhashedPolicy();
    const reversed = Object.fromEntries(Object.entries(doc).reverse());
    expect(computePolicyHash(doc as never)).toBe(computePolicyHash(reversed as never));
  });

  it('ignora o próprio campo policyHash', () => {
    const doc = unhashedPolicy();
    expect(computePolicyHash({ ...doc, policyHash: 'sha256:x' } as never)).toBe(computePolicyHash(doc as never));
  });

  it('muda quando a versão ou um limite muda', () => {
    const base = computePolicyHash(unhashedPolicy() as never);
    expect(computePolicyHash(unhashedPolicy({ version: '1.0.1-fixture' }) as never)).not.toBe(base);
    expect(computePolicyHash(unhashedPolicy({ maxDailyLossBase: '100.0' }) as never)).not.toBe(base);
  });
});

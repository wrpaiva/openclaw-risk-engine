import { describe, expect, it } from 'vitest';
import type { RiskViolationCode } from '../../../src/domain/RiskViolation.js';
import { UtcInstant } from '../../../src/domain/value-objects/UtcInstant.js';
import { createRiskEvaluator, DEFAULT_RULES, type RiskEvaluationRequest } from '../../../src/rules/RiskEvaluator.js';
import type { RiskRule } from '../../../src/rules/RiskRule.js';
import { evaluationRequest } from '../../fixtures/evaluation.js';

const evaluator = createRiskEvaluator();
const evaluate = (req: RiskEvaluationRequest) => evaluator.evaluate(req);
const codes = (req: RiskEvaluationRequest): RiskViolationCode[] => evaluate(req).violations.map((v) => v.code);
const at = (iso: string) => {
  const r = UtcInstant.parse(iso);
  if (!r.ok) throw new Error(iso);
  return r.value;
};

describe('fluxo elegível (UT-013)', () => {
  it('é ELIGIBLE com todos os inputs confiáveis, vínculos completos, TTL e reserva', () => {
    const r = evaluate(evaluationRequest());
    expect(r.outcome).toBe('ELIGIBLE');
    if (r.outcome !== 'ELIGIBLE') return;
    expect(r.violations).toEqual([]);
    expect(r.bindings.policyHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(r.bindings.proposalHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(r.bindings.snapshotVersion).toBe('snapshot-fixture-1');
    expect(r.bindings.marketDataAsOf).toBe('2026-11-13T21:59:59.500Z');
    // now + 30s (política) == expiresAt da proposta → limite é o menor dos dois.
    expect(r.authorizationExpiresAt).toBe('2026-11-13T22:00:30.000Z');
    // 0.01 × ask 100.01 × 1 × 1; risco (100.01 − 95) × 0.01.
    expect(r.reservation).toEqual({
      accountId: 'paper-fixture',
      instrument: 'FIXTURE-BTC-USD',
      strategyId: 'strategy-fixture',
      exposureBase: '1.0001',
      tradeRiskBase: '0.0501',
    });
  });

  it('autorização não sobrevive à política: usa now + maxAuthorizationTtlMs quando menor', () => {
    const r = evaluate(evaluationRequest({ policy: { maxAuthorizationTtlMs: 10_000 } }));
    expect(r.outcome === 'ELIGIBLE' && r.authorizationExpiresAt).toBe('2026-11-13T22:00:10.000Z');
  });

  it('LIMIT BUY usa limitPrice como entrada conservadora', () => {
    const r = evaluate(evaluationRequest({ proposal: { orderType: 'LIMIT', limitPrice: '101.00' } }));
    expect(r.outcome === 'ELIGIBLE' && r.reservation.exposureBase).toBe('1.01');
  });

  it('nunca usa referencePrice do agente como preço de mercado', () => {
    const r = evaluate(evaluationRequest({ proposal: { referencePrice: '1.00' } }));
    expect(r.outcome === 'ELIGIBLE' && r.reservation.exposureBase).toBe('1.0001');
  });

  it('é determinístico e não muta a entrada', () => {
    const req = evaluationRequest();
    const snapshot = structuredClone({ ...req, now: undefined });
    expect(evaluate(req)).toEqual(evaluate(req));
    expect({ ...req, now: undefined }).toEqual(snapshot);
  });
});

describe('contrato, identidade e conta (regra 1)', () => {
  it('UT-015: agentId do payload ≠ identidade autenticada', () => {
    expect(codes(evaluationRequest({ authenticatedAgentId: 'agent-fixture-forex' }))).toContain('UNAUTHORIZED_AGENT');
  });

  it('grant ausente (null) bloqueia (fail-closed)', () => {
    const r = evaluate(evaluationRequest({ accountAgentGrant: null }));
    expect(r.outcome).toBe('BLOCK');
    expect(codes(evaluationRequest({ accountAgentGrant: null }))).toContain('UNAUTHORIZED_AGENT');
  });

  it('grant de outra conta (mesmo agente) → UNAUTHORIZED_AGENT', () => {
    const req = evaluationRequest({ accountAgentGrant: { accountId: 'paper-other', agentId: 'agent-fixture-crypto' } });
    expect(evaluate(req).outcome).toBe('BLOCK');
    expect(codes(req)).toContain('UNAUTHORIZED_AGENT');
  });

  it('grant de outro agente (mesma conta) → UNAUTHORIZED_AGENT', () => {
    const req = evaluationRequest({ accountAgentGrant: { accountId: 'paper-fixture', agentId: 'agent-fixture-forex' } });
    expect(evaluate(req).outcome).toBe('BLOCK');
    expect(codes(req)).toContain('UNAUTHORIZED_AGENT');
  });

  it('grant correto + resto válido → ELIGIBLE sem UNAUTHORIZED_AGENT', () => {
    const r = evaluate(evaluationRequest());
    expect(r.outcome).toBe('ELIGIBLE');
    expect(r.violations.map((v) => v.code)).not.toContain('UNAUTHORIZED_AGENT');
  });

  it('proposta inválida com grant null → UNAUTHORIZED_AGENT junto das violações de contrato', () => {
    const c = codes(evaluationRequest({ accountAgentGrant: null, proposal: { quantity: '0' } }));
    expect(c).toContain('UNAUTHORIZED_AGENT');
    expect(c).toContain('INVALID_PROPOSAL');
  });

  it('proposta inválida com grant correto não gera UNAUTHORIZED_AGENT', () => {
    const c = codes(evaluationRequest({ proposal: { quantity: '0' } }));
    expect(c).toContain('INVALID_PROPOSAL');
    expect(c).not.toContain('UNAUTHORIZED_AGENT');
  });

  it('UT-016, I-07: environment ≠ PAPER', () => {
    expect(codes(evaluationRequest({ proposal: { environment: 'LIVE' } }))).toContain('NON_PAPER_ENVIRONMENT');
  });

  it.each([
    ['conta inexistente', null],
    ['conta real', { accountId: 'paper-fixture', environment: 'LIVE' }],
    ['outra conta', { accountId: 'paper-other', environment: 'PAPER' }],
  ])('UT-016: %s no servidor', (_label, account) => {
    expect(codes(evaluationRequest({ account }))).toEqual(['NON_PAPER_ENVIRONMENT']);
  });

  it.each([
    ['quantidade zero', { quantity: '0' }],
    ['quantidade negativa', { quantity: '-0.01' }],
    ['notação exponencial', { quantity: '1e-2' }],
  ])('UT-003: %s', (_label, proposal) => {
    expect(codes(evaluationRequest({ proposal }))).toContain('INVALID_PROPOSAL');
  });

  it('UT-020: proposta vencida', () => {
    expect(codes(evaluationRequest({ now: at('2026-11-13T22:00:30.000Z') }))).toContain('PROPOSAL_EXPIRED');
  });

  it('vigência da proposta acima do máximo da política', () => {
    expect(codes(evaluationRequest({ policy: { maxProposalTtlMs: 59_999 } }))).toEqual(['INVALID_PROPOSAL']);
  });
});

describe('política (UT-007)', () => {
  it('ausente → POLICY_MISSING', () => {
    expect(codes({ ...evaluationRequest(), policy: null })).toEqual(['POLICY_MISSING']);
  });

  it.each([
    ['inativa', { status: 'RETIRED' }],
    ['desabilitada', { enabled: false }],
    ['expirada', { validUntil: '2026-11-13T22:00:00.000Z' }],
    ['incompleta', { maxDailyLossBase: undefined }],
  ])('%s → POLICY_INVALID', (_label, policy) => {
    expect(codes(evaluationRequest({ policy }))).toContain('POLICY_INVALID');
  });

  it('hash adulterado → POLICY_INVALID', () => {
    const req = evaluationRequest();
    expect(codes({ ...req, policy: { ...(req.policy as object), maxOrderNotionalBase: '999999' } })).toContain('POLICY_INVALID');
  });
});

describe('freshness (UT-005, UT-006)', () => {
  it('UT-005: cotação com idade igual ao limite é velha', () => {
    expect(codes(evaluationRequest({ market: { asOf: '2026-11-13T21:59:55.000Z' } }))).toEqual(['MARKET_DATA_STALE']);
  });

  it('cotação 1 ms abaixo do limite é aceita', () => {
    expect(evaluate(evaluationRequest({ market: { asOf: '2026-11-13T21:59:55.001Z' } })).outcome).toBe('ELIGIBLE');
  });

  it('cotação no futuro além da tolerância não é confiável', () => {
    expect(codes(evaluationRequest({ market: { asOf: '2026-11-13T22:00:01.001Z' } }))).toEqual(['MARKET_DATA_STALE']);
  });

  it('UT-006: snapshot da conta desatualizado', () => {
    expect(codes(evaluationRequest({ context: { asOf: '2026-11-13T21:59:50.000Z' } }))).toEqual(['ACCOUNT_SNAPSHOT_STALE']);
  });

  it('snapshot de outra conta', () => {
    expect(codes(evaluationRequest({ context: { accountId: 'paper-other' } }))).toEqual(['ACCOUNT_SNAPSHOT_STALE']);
  });

  it('snapshot ausente', () => {
    expect(codes({ ...evaluationRequest(), context: null })).toEqual(['ACCOUNT_SNAPSHOT_STALE']);
  });
});

describe('mercado (UT-004)', () => {
  it.each([
    ['cotação ausente', { market: undefined }],
  ])('%s → MARKET_DATA_UNAVAILABLE', (_label, context) => {
    expect(codes(evaluationRequest({ context }))).toContain('MARKET_DATA_UNAVAILABLE');
  });

  it.each([
    ['bid zero', { bid: '0' }],
    ['ask ausente', { ask: undefined }],
    ['cotação cruzada', { bid: '100.02', ask: '100.01' }],
    ['cotação de outro instrumento', { instrument: 'FIXTURE-ETH-USD' }],
  ])('%s → MARKET_DATA_UNAVAILABLE', (_label, market) => {
    expect(codes(evaluationRequest({ market }))).toEqual(['MARKET_DATA_UNAVAILABLE']);
  });
});

describe('câmbio (UT-012)', () => {
  const brl = { policy: { baseCurrency: 'BRL', maxOrderNotionalBase: '1000', maxRiskPerTradeBase: '20' } };
  const conversion = { fromCurrency: 'USD', toCurrency: 'BRL', rate: '5.5', asOf: '2026-11-13T21:59:30.000Z', source: 'fixture-fx' };

  it('converte com taxa fresca na direção cotação → base', () => {
    const r = evaluate(evaluationRequest({ ...brl, context: { conversion } }));
    expect(r.outcome === 'ELIGIBLE' && r.reservation.exposureBase).toBe('5.50055');
  });

  it.each([
    ['ausente', undefined],
    ['par invertido (não inverte taxa)', { ...conversion, fromCurrency: 'BRL', toCurrency: 'USD' }],
    ['par errado', { ...conversion, fromCurrency: 'EUR' }],
    ['obsoleto (idade = limite)', { ...conversion, asOf: '2026-11-13T21:59:00.000Z' }],
    ['no futuro', { ...conversion, asOf: '2026-11-13T22:00:05.000Z' }],
  ])('%s → FX_RATE_UNAVAILABLE', (_label, conv) => {
    expect(codes(evaluationRequest({ ...brl, context: { conversion: conv } }))).toEqual(['FX_RATE_UNAVAILABLE']);
  });
});

describe('instrumento (UT-017, UT-003)', () => {
  it('desconhecido no catálogo', () => {
    expect(codes({ ...evaluationRequest(), instrument: null })).toEqual(['INSTRUMENT_NOT_ALLOWED']);
  });

  it.each([
    ['fora da política', { policy: { allowedInstruments: ['FIXTURE-ETH-USD'] } }],
    ['mercado fora da política', { policy: { allowedMarkets: ['FOREX'] } }],
    ['desabilitado', { instrument: { enabled: false } }],
    ['spec de outro instrumento', { instrument: { instrument: 'FIXTURE-ETH-USD' } }],
    ['derivativo sem modelo', { instrument: { productType: 'PERPETUAL' } }],
  ])('%s → INSTRUMENT_NOT_ALLOWED', (_label, o) => {
    expect(codes(evaluationRequest(o))).toContain('INSTRUMENT_NOT_ALLOWED');
  });

  it('SELL sem modelo de short/margem é bloqueado mesmo com stop correto', () => {
    const r = evaluate(evaluationRequest({ proposal: { side: 'SELL', stopLossPrice: '105.00' } }));
    expect(r.outcome).toBe('BLOCK');
    expect(r.violations).toEqual([expect.objectContaining({ code: 'INSTRUMENT_NOT_ALLOWED', field: 'side' })]);
  });

  it.each([
    ['escala acima do catálogo', { quantity: '0.00001' }],
    ['fora do lote', { quantity: '0.00015' }],
    ['stop fora do tick', { stopLossPrice: '95.005' }],
    ['limite fora do tick', { orderType: 'LIMIT', limitPrice: '100.015' }],
  ])('%s → INVALID_PROPOSAL', (_label, proposal) => {
    expect(codes(evaluationRequest({ proposal }))).toContain('INVALID_PROPOSAL');
  });

  it('abaixo da quantidade mínima', () => {
    expect(codes(evaluationRequest({ proposal: { quantity: '0.001' }, instrument: { minQuantity: '0.01' } }))).toEqual(['INVALID_PROPOSAL']);
  });
});

describe('stop-loss (UT-001, UT-002)', () => {
  it.each(['100.01', '100.02', '99.99'])('UT-001: BUY com stop %s (≥ entrada ou ≥ bid)', (stopLossPrice) => {
    expect(codes(evaluationRequest({ proposal: { stopLossPrice } }))).toContain('INVALID_STOP_LOSS');
  });

  it('BUY com stop 1 tick abaixo do bid é aceito', () => {
    expect(evaluate(evaluationRequest({ proposal: { stopLossPrice: '99.98' } })).outcome).toBe('ELIGIBLE');
  });

  it('BUY LIMIT abaixo do bid exige stop abaixo do limite', () => {
    const proposal = { orderType: 'LIMIT', limitPrice: '90.00', stopLossPrice: '90.00' };
    expect(codes(evaluationRequest({ proposal }))).toContain('INVALID_STOP_LOSS');
  });

  it.each(['99.99', '100.00', '100.01'])('UT-002: SELL com stop %s (≤ entrada ou ≤ ask)', (stopLossPrice) => {
    expect(codes(evaluationRequest({ proposal: { side: 'SELL', stopLossPrice } }))).toContain('INVALID_STOP_LOSS');
  });
});

describe('notional e risco por operação', () => {
  it('notional exatamente no limite é aceito; 1 tick acima é bloqueado', () => {
    expect(evaluate(evaluationRequest({ policy: { maxOrderNotionalBase: '1.0001' } })).outcome).toBe('ELIGIBLE');
    expect(codes(evaluationRequest({ policy: { maxOrderNotionalBase: '1.0000' } }))).toContain('MAX_ORDER_NOTIONAL');
  });

  it('risco no stop exatamente no limite é aceito; acima é bloqueado', () => {
    expect(evaluate(evaluationRequest({ policy: { maxRiskPerTradeBase: '0.0501' } })).outcome).toBe('ELIGIBLE');
    expect(codes(evaluationRequest({ policy: { maxRiskPerTradeBase: '0.05' } }))).toContain('MAX_TRADE_RISK');
  });

  it('multiplicador de contrato entra no notional e no risco', () => {
    const r = evaluate(evaluationRequest({ instrument: { contractMultiplier: '10' }, policy: { maxRiskPerTradeBase: '0.501' } }));
    expect(r.outcome === 'ELIGIBLE' && r.reservation).toMatchObject({ exposureBase: '10.001', tradeRiskBase: '0.501' });
    expect(codes(evaluationRequest({ instrument: { contractMultiplier: '10' }, policy: { maxRiskPerTradeBase: '0.5' } }))).toEqual(['MAX_TRADE_RISK']);
  });
});

describe('caixa', () => {
  it('caixa insuficiente', () => {
    expect(codes(evaluationRequest({ context: { availableCashBase: '1' } }))).toEqual(['INSUFFICIENT_CASH']);
  });

  it('reservas pendentes consomem caixa', () => {
    const context = { availableCashBase: '2', pendingReservedExposureBase: '1' };
    expect(codes(evaluationRequest({ context }))).toEqual(['INSUFFICIENT_CASH']);
  });

  it('caixa mínimo da política é respeitado (igualdade aceita)', () => {
    expect(evaluate(evaluationRequest({ context: { availableCashBase: '11.0001' }, policy: { minAvailableCashBase: '10' } })).outcome).toBe('ELIGIBLE');
    expect(codes(evaluationRequest({ context: { availableCashBase: '11' }, policy: { minAvailableCashBase: '10' } }))).toEqual(['INSUFFICIENT_CASH']);
  });

  it('caixa negativo bloqueia', () => {
    expect(codes(evaluationRequest({ context: { availableCashBase: '-5' } }))).toEqual(['INSUFFICIENT_CASH']);
  });
});

describe('exposição (UT-008, UT-009)', () => {
  it('UT-008: global excedida por 0,01 da moeda-base', () => {
    // 4998.9999 + 1.0001 = 5000 (limite) → aceito; +0.01 → bloqueado.
    expect(evaluate(evaluationRequest({ context: { openGrossExposureBase: '4998.9999' } })).outcome).toBe('ELIGIBLE');
    expect(codes(evaluationRequest({ context: { openGrossExposureBase: '4999.0099' } }))).toContain('MAX_GROSS_EXPOSURE');
  });

  it('reservas pendentes contam na exposição bruta', () => {
    const context = { openGrossExposureBase: '2500', pendingReservedExposureBase: '2499.0099' };
    expect(codes(evaluationRequest({ context }))).toContain('MAX_GROSS_EXPOSURE');
  });

  it('UT-009: exposição por instrumento excedida', () => {
    expect(codes(evaluationRequest({ context: { instrumentExposureBase: '1999' } }))).toEqual(['MAX_INSTRUMENT_EXPOSURE']);
  });

  it('UT-009: exposição por estratégia excedida', () => {
    expect(codes(evaluationRequest({ context: { strategyExposureBase: '1999' } }))).toEqual(['MAX_STRATEGY_EXPOSURE']);
  });
});

describe('perda diária (UT-010)', () => {
  it('perda exatamente no limite bloqueia', () => {
    const context = { realizedDailyPnlBase: '-98.50', unrealizedPnlBase: '-1.50' };
    expect(codes(evaluationRequest({ context }))).toEqual(['DAILY_LOSS_LIMIT']);
  });

  it('perda + risco da nova operação acima do limite bloqueia', () => {
    const context = { realizedDailyPnlBase: '-98.45', unrealizedPnlBase: '-1.50' };
    expect(codes(evaluationRequest({ context }))).toEqual(['DAILY_LOSS_LIMIT']);
  });

  it('perda + risco exatamente no limite é aceito', () => {
    const context = { realizedDailyPnlBase: '-98.4499', unrealizedPnlBase: '-1.50' };
    expect(evaluate(evaluationRequest({ context })).outcome).toBe('ELIGIBLE');
  });

  it('lucro não cria orçamento extra além do limite', () => {
    const context = { realizedDailyPnlBase: '500', unrealizedPnlBase: '0' };
    expect(evaluate(evaluationRequest({ context, policy: { maxRiskPerTradeBase: '1000', maxDailyLossBase: '0.05' } })).outcome).toBe('BLOCK');
  });
});

describe('precisão adversarial (UT-011)', () => {
  it('soma 0.1 + 0.2 exata no limite de exposição', () => {
    // Com float, 0.1+0.2 ≠ 0.3; aqui o limite exato é respeitado.
    const context = { openGrossExposureBase: '0.1', pendingReservedExposureBase: '0.2' };
    expect(evaluate(evaluationRequest({ context, policy: { maxGrossExposureBase: '1.3001' } })).outcome).toBe('ELIGIBLE');
    expect(codes(evaluationRequest({ context, policy: { maxGrossExposureBase: '1.30009999' } }))).toContain('MAX_GROSS_EXPOSURE');
  });

  it('excesso de 1e-18 no limite é detectado', () => {
    const context = { openGrossExposureBase: '4998.999900000000000001' };
    expect(codes(evaluationRequest({ context }))).toContain('MAX_GROSS_EXPOSURE');
  });

  it('valores grandes não perdem precisão', () => {
    const big = '999999999999999999999999.99';
    const context = { availableCashBase: big, openGrossExposureBase: '0' };
    const policy = { maxGrossExposureBase: big, maxOrderNotionalBase: big, maxInstrumentExposureBase: big, maxStrategyExposureBase: big };
    expect(evaluate(evaluationRequest({ context, policy })).outcome).toBe('ELIGIBLE');
  });
});

describe('falha inesperada (UT-014, I-05)', () => {
  const throwing: RiskRule = {
    id: 'throws',
    haltOnViolation: false,
    evaluate: () => {
      throw new Error('boom com dado sensível');
    },
  };

  it('regra que lança → BLOCK INTERNAL_EVALUATION_FAILURE, nunca aprovação', () => {
    const r = createRiskEvaluator([...DEFAULT_RULES, throwing]).evaluate(evaluationRequest());
    expect(r.outcome).toBe('BLOCK');
    expect(r.violations).toEqual([expect.objectContaining({ code: 'INTERNAL_EVALUATION_FAILURE' })]);
    expect(JSON.stringify(r)).not.toContain('dado sensível');
  });

  it('regra que devolve não-array → BLOCK', () => {
    const bad = { id: 'bad', haltOnViolation: false, evaluate: () => undefined } as unknown as RiskRule;
    expect(createRiskEvaluator([bad]).evaluate(evaluationRequest()).violations[0]?.code).toBe('INTERNAL_EVALUATION_FAILURE');
  });

  it('DEFAULT_RULES segue a ordem da SPEC §5', () => {
    expect(DEFAULT_RULES.map((r) => r.id)).toEqual([
      'policy-applicability', 'freshness', 'instrument', 'market-data', 'fx-rate',
      'stop-loss', 'order-notional', 'per-trade-risk', 'cash-and-margin', 'exposure', 'daily-loss',
    ]);
  });
});

describe('agregação e atalhos', () => {
  it('pré-condição violada interrompe antes dos cálculos monetários', () => {
    const r = evaluate(evaluationRequest({ market: { asOf: '2026-11-13T21:00:00.000Z' }, context: { availableCashBase: '0' } }));
    expect(r.violations.map((v) => v.code)).toEqual(['MARKET_DATA_STALE']);
  });

  it('violações monetárias são agregadas em ordem', () => {
    const r = evaluate(evaluationRequest({ proposal: { quantity: '100' }, context: { availableCashBase: '1' } }));
    expect(r.violations.map((v) => v.code)).toEqual([
      'MAX_ORDER_NOTIONAL', 'MAX_TRADE_RISK', 'INSUFFICIENT_CASH', 'MAX_GROSS_EXPOSURE',
      'MAX_INSTRUMENT_EXPOSURE', 'MAX_STRATEGY_EXPOSURE', 'DAILY_LOSS_LIMIT',
    ]);
  });

  it('BLOCK preserva vínculos conhecidos para auditoria', () => {
    const r = evaluate(evaluationRequest({ context: { availableCashBase: '1' } }));
    expect(r.bindings).toMatchObject({ accountId: 'paper-fixture', policyId: 'policy-fixture', snapshotVersion: 'snapshot-fixture-1' });
  });
});

describe('construção do avaliador', () => {
  it('recusa pipeline vazio (aprovaria sem verificar risco)', () => {
    expect(() => createRiskEvaluator([])).toThrow(RangeError);
  });
});

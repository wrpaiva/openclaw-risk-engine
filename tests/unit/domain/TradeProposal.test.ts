import { describe, expect, it } from 'vitest';
import { validateTradeProposal } from '../../../src/domain/TradeProposal.js';
import type { RiskViolationCode } from '../../../src/domain/RiskViolation.js';
import { FIXTURE_AGENT_ID, fixtureNow, validProposal } from '../../fixtures/proposals.js';

const ctx = { now: fixtureNow(), clockSkewToleranceMs: 1_000, authenticatedAgentId: FIXTURE_AGENT_ID };

function codesOf(input: unknown, context = ctx): RiskViolationCode[] {
  const r = validateTradeProposal(input, context);
  return r.ok ? [] : r.error.map((v) => v.code);
}

function fieldsOf(input: unknown): (string | undefined)[] {
  const r = validateTradeProposal(input, ctx);
  return r.ok ? [] : r.error.map((v) => v.field);
}

describe('validateTradeProposal — caso válido', () => {
  it('aceita proposta MARKET completa', () => {
    const r = validateTradeProposal(validProposal(), ctx);
    expect(r.ok).toBe(true);
  });

  it('aceita proposta LIMIT com limitPrice', () => {
    expect(codesOf(validProposal({ orderType: 'LIMIT', limitPrice: '99.50' }))).toEqual([]);
  });
});

describe('validateTradeProposal — contrato (UT-003)', () => {
  it.each([
    ['quantidade zero', { quantity: '0' }, 'quantity'],
    ['quantidade negativa', { quantity: '-1' }, 'quantity'],
    ['quantidade exponencial', { quantity: '1e-2' }, 'quantity'],
    ['quantidade NaN', { quantity: 'NaN' }, 'quantity'],
    ['quantidade como number JS', { quantity: 0.01 }, 'quantity'],
    ['referencePrice zero', { referencePrice: '0' }, 'referencePrice'],
    ['stopLossPrice ausente', { stopLossPrice: undefined }, 'stopLossPrice'],
    ['stopLossPrice Infinity', { stopLossPrice: 'Infinity' }, 'stopLossPrice'],
    ['proposalId não UUID', { proposalId: 'abc' }, 'proposalId'],
    ['idempotencyKey vazia', { idempotencyKey: '' }, 'idempotencyKey'],
    ['idempotencyKey > 128', { idempotencyKey: 'k'.repeat(129) }, 'idempotencyKey'],
    ['idempotencyKey com controle', { idempotencyKey: 'a\nb' }, 'idempotencyKey'],
    ['schemaVersion diferente', { schemaVersion: 2 }, 'schemaVersion'],
    ['market desconhecido', { market: 'EQUITIES' }, 'market'],
    ['side inválido', { side: 'SHORT' }, 'side'],
    ['orderType inválido', { orderType: 'STOP' }, 'orderType'],
    ['createdAt sem offset', { createdAt: '2026-11-13T21:59:30' }, 'createdAt'],
    ['expiresAt inexistente no calendário', { expiresAt: '2026-02-30T00:00:00Z' }, 'expiresAt'],
  ])('rejeita %s com INVALID_PROPOSAL', (_label, override, field) => {
    const input = validProposal(override);
    expect(codesOf(input)).toContain('INVALID_PROPOSAL');
    expect(fieldsOf(input)).toContain(field);
  });

  it('rejeita campos adicionais não previstos', () => {
    expect(codesOf({ ...validProposal(), leverage: '10' })).toEqual(['INVALID_PROPOSAL']);
  });

  it('rejeita entrada que não é objeto', () => {
    expect(codesOf(null)).toEqual(['INVALID_PROPOSAL']);
    expect(codesOf('{}')).toEqual(['INVALID_PROPOSAL']);
  });

  it('exige limitPrice para LIMIT', () => {
    expect(fieldsOf(validProposal({ orderType: 'LIMIT' }))).toContain('limitPrice');
  });

  it('rejeita limitPrice em ordem MARKET (ambíguo)', () => {
    expect(fieldsOf(validProposal({ limitPrice: '99' }))).toContain('limitPrice');
  });
});

describe('validateTradeProposal — ambiente (UT-016)', () => {
  it.each(['LIVE', 'REAL', 'paper', '', null])('rejeita environment=%s com NON_PAPER_ENVIRONMENT', (environment) => {
    expect(codesOf(validProposal({ environment }))).toContain('NON_PAPER_ENVIRONMENT');
  });

  it('rejeita environment ausente com NON_PAPER_ENVIRONMENT', () => {
    const { environment: _omit, ...rest } = validProposal();
    expect(codesOf(rest)).toContain('NON_PAPER_ENVIRONMENT');
  });
});

describe('validateTradeProposal — identidade (UT-015)', () => {
  it('rejeita agentId do payload diferente da identidade autenticada', () => {
    expect(codesOf(validProposal({ agentId: 'agent-forjado' }))).toContain('UNAUTHORIZED_AGENT');
  });

  it('rejeita quando não há identidade autenticada', () => {
    expect(codesOf(validProposal(), { ...ctx, authenticatedAgentId: '' })).toContain('UNAUTHORIZED_AGENT');
  });

  it('reporta identidade mesmo quando o restante do contrato também falha', () => {
    const codes = codesOf(validProposal({ agentId: 'agent-forjado', quantity: '0' }));
    expect(codes).toContain('UNAUTHORIZED_AGENT');
    expect(codes).toContain('INVALID_PROPOSAL');
  });
});

describe('validateTradeProposal — timestamps (UT-020)', () => {
  it('rejeita proposta já vencida com PROPOSAL_EXPIRED', () => {
    expect(codesOf(validProposal({ expiresAt: '2026-11-13T21:59:59.999Z' }))).toEqual(['PROPOSAL_EXPIRED']);
  });

  it('considera vencida quando expiresAt == now (intervalo semiaberto)', () => {
    expect(codesOf(validProposal({ expiresAt: '2026-11-13T22:00:00.000Z' }))).toEqual(['PROPOSAL_EXPIRED']);
  });

  it('rejeita createdAt no futuro além da tolerância de relógio', () => {
    const input = validProposal({ createdAt: '2026-11-13T22:00:01.001Z', expiresAt: '2026-11-13T22:01:00.000Z' });
    expect(codesOf(input)).toEqual(['INVALID_PROPOSAL']);
    expect(fieldsOf(input)).toEqual(['createdAt']);
  });

  it('aceita createdAt no futuro dentro da tolerância de relógio', () => {
    expect(codesOf(validProposal({ createdAt: '2026-11-13T22:00:01.000Z', expiresAt: '2026-11-13T22:01:00.000Z' }))).toEqual([]);
  });

  it('rejeita expiresAt anterior ou igual a createdAt', () => {
    const input = validProposal({ createdAt: '2026-11-13T21:59:00.000Z', expiresAt: '2026-11-13T21:59:00.000Z' });
    expect(fieldsOf(input)).toContain('expiresAt');
  });

  it('exige tolerância de relógio explícita, sem padrão silencioso', () => {
    expect(() => validateTradeProposal(validProposal(), { ...ctx, clockSkewToleranceMs: -1 })).toThrow();
    expect(() => validateTradeProposal(validProposal(), { ...ctx, clockSkewToleranceMs: Number.NaN })).toThrow();
  });
});

describe('validateTradeProposal — determinismo', () => {
  it('retorna violações idênticas para a mesma entrada', () => {
    const input = validProposal({ quantity: '0', side: 'X', agentId: 'other' });
    expect(validateTradeProposal(input, ctx)).toEqual(validateTradeProposal(input, ctx));
  });

  it('não muta a entrada', () => {
    const input = validProposal();
    const snapshot = structuredClone(input);
    validateTradeProposal(input, ctx);
    expect(input).toEqual(snapshot);
  });
});

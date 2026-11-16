import { describe, expect, it } from 'vitest';
import { validateRiskDecision, type RiskDecisionV1 } from '../../../src/domain/RiskDecision.js';

const allow: RiskDecisionV1 = {
  schemaVersion: 1,
  decisionId: 'b65c0b58-0cb0-43ca-8f53-6d12d6cb3c5f',
  proposalId: '3dd99fb7-2fa8-4700-9d4f-4baf9a4e35f6',
  accountId: 'paper-fixture',
  agentId: 'agent-fixture-crypto',
  proposalHash: `sha256:${'a'.repeat(64)}`,
  policyId: 'policy-fixture',
  policyVersion: '1.0.0-fixture',
  policyHash: `sha256:${'b'.repeat(64)}`,
  status: 'ALLOW_PAPER',
  violations: [],
  evaluatedAt: '2026-11-13T22:00:00.000Z',
  marketDataAsOf: '2026-11-13T21:59:59.000Z',
  snapshotVersion: 'snapshot-fixture-1',
  reservationId: '7c1f0a4e-2b8d-4f7a-9c3e-5d6b7a8c9d0e',
  authorizationExpiresAt: '2026-11-13T22:00:30.000Z',
  correlationId: 'corr-fixture-001',
};

const block: RiskDecisionV1 = {
  ...allow,
  status: 'BLOCK',
  policyId: null,
  policyVersion: null,
  policyHash: null,
  marketDataAsOf: null,
  snapshotVersion: null,
  violations: [{ code: 'POLICY_MISSING', message: 'nenhuma política aplicável encontrada' }],
  reservationId: null,
  authorizationExpiresAt: null,
};

const isOk = (d: unknown) => validateRiskDecision(d).ok;

describe('validateRiskDecision — ALLOW_PAPER', () => {
  it('aceita autorização completa e vinculada', () => {
    expect(isOk(allow)).toBe(true);
  });

  it('rejeita ALLOW_PAPER com violações', () => {
    expect(isOk({ ...allow, violations: block.violations })).toBe(false);
  });

  it.each(['reservationId', 'authorizationExpiresAt', 'policyId', 'policyVersion', 'policyHash', 'marketDataAsOf', 'snapshotVersion'] as const)(
    'rejeita ALLOW_PAPER com %s nulo (I-02, I-06)',
    (field) => {
      expect(isOk({ ...allow, [field]: null })).toBe(false);
    },
  );

  it('rejeita autorização que expira antes ou no instante da avaliação', () => {
    expect(isOk({ ...allow, authorizationExpiresAt: allow.evaluatedAt })).toBe(false);
  });
});

describe('validateRiskDecision — BLOCK', () => {
  it('aceita bloqueio com motivo e sem política (POLICY_MISSING)', () => {
    expect(isOk(block)).toBe(true);
  });

  it('rejeita BLOCK sem nenhuma violação', () => {
    expect(isOk({ ...block, violations: [] })).toBe(false);
  });

  it('rejeita BLOCK carregando reserva ou autorização', () => {
    expect(isOk({ ...block, reservationId: allow.reservationId })).toBe(false);
    expect(isOk({ ...block, authorizationExpiresAt: allow.authorizationExpiresAt })).toBe(false);
  });
});

describe('validateRiskDecision — contrato', () => {
  it.each([
    ['status desconhecido', { status: 'ALLOW' }],
    ['código de violação desconhecido', { violations: [{ code: 'OK', message: 'x' }] }],
    ['schemaVersion diferente', { schemaVersion: 2 }],
    ['campo adicional', { approvedBy: 'llm' }],
  ])('rejeita %s', (_label, override) => {
    expect(isOk({ ...block, ...override })).toBe(false);
  });
});

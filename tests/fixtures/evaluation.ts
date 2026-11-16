// Cenário FICTÍCIO completo para o avaliador. Nenhum valor representa limite aprovado (SPEC §12).
import type { RiskEvaluationRequest } from '../../src/rules/RiskEvaluator.js';
import { fixtureContext } from './contexts.js';
import { fixtureInstrument } from './instruments.js';
import { FIXTURE_ACCOUNT_ID, hashedPolicy } from './policies.js';
import { FIXTURE_AGENT_ID, fixtureNow, validProposal } from './proposals.js';

// Grant FICTÍCIO (conta, agente) da fixture.
export const FIXTURE_GRANT = Object.freeze({ accountId: FIXTURE_ACCOUNT_ID, agentId: FIXTURE_AGENT_ID });
// Legado: usado só pelo harness de integração até o backend migrar (B7).
export const FIXTURE_ALLOWLIST = Object.freeze([FIXTURE_AGENT_ID, 'agent-fixture-forex']);
export const FIXTURE_SKEW_MS = 1_000;

type Overrides = {
  proposal?: Record<string, unknown>;
  policy?: Record<string, unknown>;
  context?: Record<string, unknown>;
  market?: Record<string, unknown>;
  instrument?: Record<string, unknown>;
} & Partial<Omit<RiskEvaluationRequest, 'proposal' | 'policy' | 'context' | 'instrument'>>;

export function evaluationRequest(o: Overrides = {}): RiskEvaluationRequest {
  const baseContext = fixtureContext(o.context);
  const market = { ...(baseContext['market'] as Record<string, unknown>), ...o.market };
  return {
    proposal: validProposal(o.proposal),
    authenticatedAgentId: o.authenticatedAgentId ?? FIXTURE_AGENT_ID,
    accountAgentGrant: o.accountAgentGrant === undefined ? FIXTURE_GRANT : o.accountAgentGrant,
    account: o.account === undefined ? { accountId: FIXTURE_ACCOUNT_ID, environment: 'PAPER' } : o.account,
    policy: hashedPolicy(o.policy),
    context: { ...baseContext, market },
    instrument: fixtureInstrument(o.instrument),
    now: o.now ?? fixtureNow(),
    clockSkewToleranceMs: o.clockSkewToleranceMs ?? FIXTURE_SKEW_MS,
  };
}

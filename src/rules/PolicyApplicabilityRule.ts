import type { RiskViolationV1 } from '../domain/RiskViolation.js';
import type { RiskRule, RiskRuleInput } from './RiskRule.js';
import { instant, violation } from './ruleSupport.js';

/** Regra 2 (complemento): a proposta respeita a vigência máxima definida pela política. */
export const PolicyApplicabilityRule: RiskRule = {
  id: 'policy-applicability',
  haltOnViolation: true,
  evaluate({ proposal, policy }: Readonly<RiskRuleInput>): readonly RiskViolationV1[] {
    const ttlMs = instant(proposal.expiresAt).millisSince(instant(proposal.createdAt));
    if (ttlMs > policy.maxProposalTtlMs) {
      return [
        violation('INVALID_PROPOSAL', 'expiresAt', 'vigência da proposta excede o máximo da política', `${ttlMs}ms`, `${policy.maxProposalTtlMs}ms`),
      ];
    }
    return [];
  },
};

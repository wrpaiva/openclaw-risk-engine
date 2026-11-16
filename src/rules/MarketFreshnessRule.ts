import type { RiskViolationV1 } from '../domain/RiskViolation.js';
import type { RiskRule, RiskRuleInput } from './RiskRule.js';
import { freshness, instant, violation } from './ruleSupport.js';

/** Regra 3: snapshot da conta e cotação confiáveis e dentro da janela da política. */
export const MarketFreshnessRule: RiskRule = {
  id: 'freshness',
  haltOnViolation: true,
  evaluate({ proposal, policy, context, now, clockSkewToleranceMs }: Readonly<RiskRuleInput>): readonly RiskViolationV1[] {
    const out: RiskViolationV1[] = [];
    if (context.accountId !== proposal.accountId) {
      out.push(violation('ACCOUNT_SNAPSHOT_STALE', 'context.accountId', 'snapshot pertence a outra conta', context.accountId, proposal.accountId));
    }

    const snapshot = freshness(instant(context.asOf), now, policy.maxAccountSnapshotAgeMs, clockSkewToleranceMs);
    if (snapshot !== 'FRESH') {
      out.push(
        violation(
          'ACCOUNT_SNAPSHOT_STALE',
          'context.asOf',
          snapshot === 'FUTURE' ? 'snapshot com timestamp no futuro' : 'snapshot da conta fora da janela',
          context.asOf,
          `${policy.maxAccountSnapshotAgeMs}ms`,
        ),
      );
    }

    const market = freshness(instant(context.market.asOf), now, policy.maxMarketDataAgeMs, clockSkewToleranceMs);
    if (market !== 'FRESH') {
      out.push(
        violation(
          'MARKET_DATA_STALE',
          'context.market.asOf',
          market === 'FUTURE' ? 'cotação com timestamp no futuro' : 'cotação fora da janela',
          context.market.asOf,
          `${policy.maxMarketDataAgeMs}ms`,
        ),
      );
    }
    return out;
  },
};

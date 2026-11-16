import type { RiskViolationV1 } from '../domain/RiskViolation.js';
import type { RiskRule, RiskRuleInput } from './RiskRule.js';
import { dec, violation } from './ruleSupport.js';
import { computeTradeMetrics } from './tradeMetrics.js';

/**
 * Regra 9. Único modelo suportado: SPOT pago integralmente em caixa.
 * - SELL é bloqueado: sem posição no contexto (D-05) e sem modelo de short/margem (D-06),
 *   não há como provar que a venda não abre posição a descoberto (SPEC §5.2).
 * - BUY exige caixa − reservas pendentes − notional ≥ caixa mínimo. Descontar as reservas é
 *   conservador mesmo que o snapshot já as considere (D-05 em aberto).
 */
export const CashAndMarginRule: RiskRule = {
  id: 'cash-and-margin',
  haltOnViolation: false,
  evaluate(input: Readonly<RiskRuleInput>): readonly RiskViolationV1[] {
    const { proposal, policy, context } = input;
    // InstrumentSpec v1 só admite shortSelling='UNSUPPORTED'; novo modelo exige nova versão de schema.
    if (proposal.side === 'SELL') {
      return [violation('INSTRUMENT_NOT_ALLOWED', 'side', 'venda sem modelo de posição/short/margem aprovado (D-05/D-06)', proposal.side)];
    }

    const { notionalBase } = computeTradeMetrics(input);
    const remaining = dec(context.availableCashBase).minus(dec(context.pendingReservedExposureBase)).minus(notionalBase);
    const min = dec(policy.minAvailableCashBase);
    return remaining.lessThan(min)
      ? [violation('INSUFFICIENT_CASH', 'quantity', 'caixa remanescente abaixo do mínimo', remaining.toString(), min.toString())]
      : [];
  },
};

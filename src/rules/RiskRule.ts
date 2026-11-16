import type { InstrumentSpec } from '../domain/InstrumentSpec.js';
import type { RiskContextV1 } from '../domain/RiskContext.js';
import type { RiskPolicyV1 } from '../domain/RiskPolicy.js';
import type { RiskViolationV1 } from '../domain/RiskViolation.js';
import type { TradeProposalV1 } from '../domain/TradeProposal.js';
import type { UtcInstant } from '../domain/value-objects/UtcInstant.js';

/**
 * Entrada já validada estruturalmente. Em relação à SPEC §6.1, acrescenta o relógio
 * injetado (`now`) e a tolerância de relógio, necessários à regra de freshness —
 * regras nunca leem o relógio do sistema.
 */
export interface RiskRuleInput {
  readonly proposal: TradeProposalV1;
  readonly policy: RiskPolicyV1;
  readonly context: RiskContextV1;
  readonly instrument: InstrumentSpec;
  readonly now: UtcInstant;
  readonly clockSkewToleranceMs: number;
}

/**
 * Regra pura (SPEC §6.1, Strategy). Sem I/O, relógio implícito ou estado mutável.
 * Uma exceção lançada aqui nunca equivale a `[]`: o avaliador converte em
 * INTERNAL_EVALUATION_FAILURE e não autoriza (ADR-0003).
 */
export interface RiskRule {
  readonly id: string;
  /**
   * Regras de pré-condição (dados íntegros, instrumento, mercado, câmbio): se violadas,
   * o avaliador interrompe antes dos cálculos monetários, que dependeriam de dados não confiáveis.
   */
  readonly haltOnViolation: boolean;
  evaluate(input: Readonly<RiskRuleInput>): readonly RiskViolationV1[];
}

# ADR-0017 — Tratar sinais e planos como dados não autoritativos

- **Status:** Proposto (pendente de aprovação)
- **Numeração original:** ADR-0015, renumerada para ADR-0017 em 2026-11-16: a série nova colidia com as ADR-0011 e ADR-0012 já aceitas e foi deslocada em +2
- **Data:** 2026-11-16
- **Projeto:** OpenClaw Trading Risk Engine / Strategy Engine
- **Referência:** `SPEC_OPENCLAW_RISK_ENGINE.md` v1.1.0 §16

## Contexto
Um agente pode gerar entradas, stops e tamanhos com erros ou alucinações.

## Decisão proposta
Separar SignalCandidate/TradePlanDraft/TradeProposalDraft de TradeProposal e RiskDecision; validação por contexto verificado e autorização transacional apenas do motor.

## Alternativas consideradas
Skill trader-risk como autoridade: recusada; permitir aprovação humana substituir motor: recusada.

## Justificativa, consequências e riscos
Fail-closed consistente e rastreabilidade; conversão demanda validação.

## Critérios verificáveis de aceite
Testes de entradas adulteradas, permissões e tentativas de bypass.

## Revisão e aprovação
Decisão ainda não aprovada. Registrar aprovador, data e versão antes de implementar em produção. Um novo ADR deve substituir este caso a decisão mude.

# ADR-0018 — Tratar backtesting e simulações como evidência, nunca autorização

- **Status:** Proposto (pendente de aprovação)
- **Numeração original:** ADR-0016, renumerada para ADR-0018 em 2026-11-16: a série nova colidia com as ADR-0011 e ADR-0012 já aceitas e foi deslocada em +2
- **Data:** 2026-11-16
- **Projeto:** OpenClaw Trading Risk Engine / Strategy Engine
- **Referência:** `SPEC_OPENCLAW_RISK_ENGINE.md` v1.1.0 §16

## Contexto
O timemachine descreve replays e Monte Carlo; tais estimativas são sensíveis a dados e hipóteses.

## Decisão proposta
Relatórios versionam dados, seed, método, janelas e limitações; usam walk-forward/out-of-sample quando aplicável e jamais emitem autorização.

## Alternativas consideradas
Probabilidade mínima como autorização automática: recusada; testes apenas in-sample: insuficientes.

## Justificativa, consequências e riscos
Diminui overfitting e falsa precisão, ao custo de infraestrutura de datasets e testes.

## Critérios verificáveis de aceite
Reprodutibilidade com seed, sem look-ahead, custos/slippage modelados; mesmo simulação favorável pode levar a BLOCK.

## Revisão e aprovação
Decisão ainda não aprovada. Registrar aprovador, data e versão antes de implementar em produção. Um novo ADR deve substituir este caso a decisão mude.

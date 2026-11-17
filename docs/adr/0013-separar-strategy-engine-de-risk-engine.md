# ADR-0013 — Separar Strategy Engine de Risk Engine

- **Status:** Proposto (pendente de aprovação)
- **Numeração original:** ADR-0011, renumerada para ADR-0013 em 2026-11-16: a série nova colidia com as ADR-0011 e ADR-0012 já aceitas e foi deslocada em +2
- **Data:** 2026-11-16
- **Projeto:** OpenClaw Trading Risk Engine / Strategy Engine
- **Referência:** `SPEC_OPENCLAW_RISK_ENGINE.md` v1.1.0 §16

## Contexto
O upstream mistura habilidades de sinal, orçamento e risco em uma experiência de trading. Nossa plataforma exige autoridade de risco independente.

## Decisão proposta
Skills e Strategy Engine geram candidatos e rascunhos; Risk Engine determinístico é o único emissor de ALLOW_PAPER. Não chamar skills de validação financeira final.

## Alternativas consideradas
Unificar motores: acoplamento e risco de bypass; usar IA para validar risco: imprevisibilidade.

## Justificativa, consequências e riscos
Fronteira de autorização, contratos tipados e testes de integração negativos. O custo é manter dois modelos de dados.

## Critérios verificáveis de aceite
Uma skill jamais emite ALLOW_PAPER e não possui credenciais de execução.

## Revisão e aprovação
Decisão ainda não aprovada. Registrar aprovador, data e versão antes de implementar em produção. Um novo ADR deve substituir este caso a decisão mude.

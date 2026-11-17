# ADR-0014 — Validar Market Data, scheduler e custos antes de qualquer sinal

- **Status:** Proposto (pendente de aprovação)
- **Numeração original:** ADR-0012, renumerada para ADR-0014 em 2026-11-16: a série nova colidia com as ADR-0011 e ADR-0012 já aceitas e foi deslocada em +2
- **Data:** 2026-11-16
- **Projeto:** OpenClaw Trading Risk Engine / Strategy Engine
- **Referência:** `SPEC_OPENCLAW_RISK_ENGINE.md` v1.1.0 §16

## Contexto
Fontes gratuitas são úteis, mas latência, cobertura e calendários variam entre ações EUA, cripto, FX e ouro.

## Decisão proposta
Criar porta MarketData com fonte, timestamps, qualidade, catálogo e TTL; agendar por sessão e timezone; orçar chamadas LLM e dados. Falha = sem sinal.

## Alternativas consideradas
Web scraping sem contrato: frágil; usar dados recebidos pelo agente como verdade: sem integridade.

## Justificativa, consequências e riscos
Mais complexidade de integração, porém dados auditáveis e limitação de custos.

## Critérios verificáveis de aceite
Rejeitar dados stale/sem fonte; testes de DST, fuso horário e duplicidade de jobs.

## Revisão e aprovação
Decisão ainda não aprovada. Registrar aprovador, data e versão antes de implementar em produção. Um novo ADR deve substituir este caso a decisão mude.

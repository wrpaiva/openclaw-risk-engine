# ADR-0015 — Isolar observabilidade financeira e alertas do caminho transacional

- **Status:** Proposto (pendente de aprovação)
- **Numeração original:** ADR-0013, renumerada para ADR-0015 em 2026-11-16: a série nova colidia com as ADR-0011 e ADR-0012 já aceitas e foi deslocada em +2
- **Data:** 2026-11-16
- **Projeto:** OpenClaw Trading Risk Engine / Strategy Engine
- **Referência:** `SPEC_OPENCLAW_RISK_ENGINE.md` v1.1.0 §16

## Contexto
Pixel Agents e receiver SSE foram concebidos para presença e atividade, não para controle financeiro.

## Decisão proposta
Publicar métricas e alertas por outbox pós-commit, sem dados sensíveis; estado autoritativo em PostgreSQL; correlacionar IDs sem conceder permissões.

## Alternativas consideradas
Executar ações via SSE: proibido; usar logs somente como auditoria: insuficiente.

## Justificativa, consequências e riscos
Permite dashboards e alertas sem autorizar operações; exige métricas e retenção.

## Critérios verificáveis de aceite
Perda de SSE não provoca decisão duplicada; alerta reflete decisão persistida.

## Revisão e aprovação
Decisão ainda não aprovada. Registrar aprovador, data e versão antes de implementar em produção. Um novo ADR deve substituir este caso a decisão mude.

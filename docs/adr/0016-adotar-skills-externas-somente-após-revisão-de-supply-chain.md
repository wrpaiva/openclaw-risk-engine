# ADR-0016 — Adotar skills externas somente após revisão de supply chain

- **Status:** Proposto (pendente de aprovação)
- **Numeração original:** ADR-0014, renumerada para ADR-0016 em 2026-11-16: a série nova colidia com as ADR-0011 e ADR-0012 já aceitas e foi deslocada em +2
- **Data:** 2026-11-16
- **Projeto:** OpenClaw Trading Risk Engine / Strategy Engine
- **Referência:** `SPEC_OPENCLAW_RISK_ENGINE.md` v1.1.0 §16

## Contexto
O repositório day-trader-skill foi pensado para Claude e inclui scripts Python, fontes remotas e broker.

## Decisão proposta
Pin de origem, revisão de licença, scripts, rede, dependências e prompts; publicar adaptação própria read-only; trader-broker não instalado.

## Alternativas consideradas
Instalar as 11 diretamente: amplia superfície de ataque; copiar sem proveniência: inviabiliza rastreabilidade.

## Justificativa, consequências e riscos
Entrega incremental com menos superfície de ataque, mas exige manutenção de adaptações.

## Critérios verificáveis de aceite
Manifesto de origem, nenhum acesso a secrets ou corretoras, testes de prompt injection.

## Revisão e aprovação
Decisão ainda não aprovada. Registrar aprovador, data e versão antes de implementar em produção. Um novo ADR deve substituir este caso a decisão mude.

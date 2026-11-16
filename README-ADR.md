# Architecture Decision Records — OpenClaw Trading Risk Engine

**Versão:** 1.0.0  
**Data:** 2026-11-13  
**Status do pacote:** Proposta para revisão  
**Fonte de requisitos:** `SPEC_OPENCLAW_RISK_ENGINE.md` v1.0.0

Este conjunto registra **decisões arquiteturais propostas**, suas alternativas, consequências, riscos, critérios de validação e condições de revisão. **Nenhuma ADR foi formalmente aceita ou implantada** por sua inclusão neste pacote.

## Catálogo de decisões

| ADR | Decisão | Estado |
|---|---|---|
| [ADR-0001 — Separar o Risk Engine do Pixel Agents e do receiver](docs/adr/0001-separar-o-risk-engine-do-pixel-agents-e-do-receiver.md) | Proposto |
| [ADR-0002 — Adotar domínio determinístico e arquitetura hexagonal moderada](docs/adr/0002-adotar-domínio-determinístico-e-arquitetura-hexagonal-moderada.md) | Proposto |
| [ADR-0003 — Fail-closed e autorização exclusivamente para paper trading](docs/adr/0003-fail-closed-e-autorização-exclusivamente-para-paper-trading.md) | Proposto |
| [ADR-0004 — Dinheiro e quantidades como decimais e catálogo de instrumentos obrigatório](docs/adr/0004-dinheiro-e-quantidades-como-decimais-e-catálogo-de-instrumentos-obrigatório.md) | Proposto |
| [ADR-0005 — Políticas versionadas, imutáveis e aprovadas explicitamente](docs/adr/0005-políticas-versionadas,-imutáveis-e-aprovadas-explicitamente.md) | Proposto |
| [ADR-0006 — Atomicidade, idempotência e reserva de capacidade no PostgreSQL](docs/adr/0006-atomicidade,-idempotência-e-reserva-de-capacidade-no-postgresql.md) | Proposto |
| [ADR-0007 — Separar canal transacional de propostas do canal SSE de observabilidade](docs/adr/0007-separar-canal-transacional-de-propostas-do-canal-sse-de-observabilidade.md) | Proposto |
| [ADR-0008 — Usar PostgreSQL 14 existente com banco e usuário exclusivos](docs/adr/0008-usar-postgresql-14-existente-com-banco-e-usuário-exclusivos.md) | Proposto |
| [ADR-0009 — Separar testes locais por fase e regressão ponta a ponta no marco final](docs/adr/0009-separar-testes-locais-por-fase-e-regressão-ponta-a-ponta-no-marco-final.md) | Proposto |
| [ADR-0010 — Governança de evolução e proibição de execução real nesta fase](docs/adr/0010-governança-de-evolução-e-proibição-de-execução-real-nesta-fase.md) | Proposto |
| [ADR-0011 — Rede e TLS do canal transacional](docs/adr/0011-rede-e-tls-do-canal-transacional.md) | Aceito (2026-11-15) |
| [ADR-0012 — Backup da base dedicada](docs/adr/0012-backup-da-base-dedicada.md) | Aceito (2026-11-15) |

## Como usar

1. Leia a SPEC antes de implementar contratos e regras.
2. Revise as ADRs e aprove ou rejeite explicitamente cada decisão. Atualize o campo `Status` com rastreabilidade da aprovação.
3. Implemente as etapas 2.1–2.5 com testes locais; **a regressão ponta a ponta completa ocorre no marco final**, conforme o planejamento.
4. Para substituir uma decisão aceita, **não reescreva sua justificativa histórica**. Crie nova ADR, marque a anterior como `Substituído por ADR-XXXX` e atualize dependências.
5. Durante a fase 2, nenhuma ADR autoriza emissão de ordens reais, novas stacks em produção nem definição arbitrária de limites financeiros.

## Estados de uma ADR

- **Proposto:** ainda sujeito a revisão e aprovação.
- **Aceito:** aprovado explicitamente, com data e responsável identificados.
- **Rejeitado:** rejeitado, mantendo a motivação para memória histórica.
- **Substituído:** decisão supersedida por outra ADR identificada.

## Questões pendentes da SPEC

Não habilitar `ALLOW_PAPER` em produção antes de resolver os itens D-01 a D-10 da seção 12, conforme aplicabilidade: moeda-base/contas, instrumentos, market data/FX, limites e perdas, carteira/saldo, shorts/custos, calendário, responsável pela política, executor paper e operação/backup.

## Implantação

Caminho sugerido: `/opt/openclaw-risk-engine/docs/adr/`. Este pacote **não altera** os serviços `openclaw-trading_openclaw`, `pixel-agents_web`, `pixel-events_receiver`, PostgreSQL ou Redis. Não inclui executáveis ou segredos.

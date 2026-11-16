# ADR-0001 — Separar o Risk Engine do Pixel Agents e do receiver

- **Status:** Proposto (pendente de aprovação)
- **Data:** 2026-11-13
- **Projeto:** OpenClaw Trading Risk Engine
- **Referência normativa:** `SPEC_OPENCLAW_RISK_ENGINE.md` v1.0.0
- **Escopo:** Fase 2 / paper trading

## Contexto
O ambiente já possui OpenClaw Trading, Pixel Agents e receiver SSE. Esses componentes atendem à análise e observabilidade, não à autorização financeira. O diretório `trading-room/` contém layouts, não lógica de risco.

## Decisão proposta
Criar o projeto separado `openclaw-risk-engine`, inicialmente módulo/CLI testável, sem implantar novo serviço Swarm nesta etapa. O domínio não importará módulos de Pixel Agents nem do plugin de eventos. Propostas financeiras devem usar futuro canal autenticado próprio.

## Alternativas consideradas
- Incorporar lógica no `pixel-agents-trading`: rejeitada, pois mistura UI com autorização.
- Estender `pixel-events_receiver`: rejeitada, pois SSE de observabilidade não garante integridade transacional.
- Criar imediatamente um microsserviço em Swarm: adiado até haver caso de uso e operação validada.

## Justificativa e consequências
+ Isolamento de falhas, ciclo de entrega e auditoria do domínio de risco.
+ Arquitetura permite CLI e futuro adaptador HTTP sem mudanças nas regras.
- Exige um novo repositório/projeto e integração explícita posterior.

## Restrições, riscos e mitigação
Risco de dependências transitivas entre serviços; impor checagem de imports e testes arquiteturais. Não reutilizar token SSE como autenticação de proposta.

## Critérios de validação
- `npm run typecheck` e testes de domínio independentes de infraestrutura.
- Verificar import graph sem dependências `pixel-agents`/`pixel-events`.
- Nenhum novo serviço Swarm criado na etapa 2.1.

## Relação com a especificação
Seções 1, 3, 6, 8 e 11.

## Revisão da decisão
- **Gatilhos para revisão:** mudança comprovada de fronteiras de responsabilidade ou requisitos operacionais
- **Dependências em aberto:** D-09 e D-10
- **Responsável pela aprovação:** a definir; nenhuma decisão proposta é automaticamente aprovada.

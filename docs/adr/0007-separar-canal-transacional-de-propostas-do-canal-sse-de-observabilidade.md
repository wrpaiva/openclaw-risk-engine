# ADR-0007 — Separar canal transacional de propostas do canal SSE de observabilidade

- **Status:** Proposto (pendente de aprovação)
- **Data:** 2026-11-13
- **Projeto:** OpenClaw Trading Risk Engine
- **Referência normativa:** `SPEC_OPENCLAW_RISK_ENGINE.md` v1.0.0
- **Escopo:** Fase 2 / paper trading

## Contexto
O receiver SSE existente recebe eventos de atividade e é tolerante à perda/reinicialização; seus contadores são voláteis. Isso não atende a decisões financeiras nem à auditoria de autorização.

## Decisão proposta
Criar futuramente um adaptador autenticado OpenClaw→Risk Engine, com validação da identidade do agente no servidor, autorização por conta, limitação de payload e timeouts. O canal `pixel-events` permanece apenas para observabilidade. A API HTTP proposta tem `/v1/risk/evaluations`, consulta de decisão e operações internas de consume/release; não será implantada na etapa de domínio.

## Alternativas consideradas
- Aproveitar POST `/events` para propostas: rejeitado.
- Autorizar por WebSocket do painel: rejeitado.
- Aceitar identidade declarada no JSON: rejeitado.

## Justificativa e consequências
+ Menor superfície de ataque e semântica clara entre monitoramento e controle.
- Exige adaptar agentes posteriormente.
- Estado do painel nunca determina permissão de risco.

## Restrições, riscos e mitigação
Tokens distintos e secrets gerenciados fora do Git. Recebedor deve ter autenticação, conta allowlisted e TLS/rede privada conforme infraestrutura aprovada. Rate limit e logs sanitizados no adaptador.

## Critérios de validação
- Com receptor SSE indisponível, a decisão de risco mantém semântica independente.
- Chamadas sem autenticação, com agente spoofado ou conta desconhecida falham.
- Testes de contrato para respostas e códigos de erro antes de habilitar API.

## Relação com a especificação
Seções 1, 3, 8, 9 e 11.

## Revisão da decisão
- **Gatilhos para revisão:** escolha de transportes autenticados ou exigência de integração com múltiplos executores
- **Dependências em aberto:** D-09 e D-10
- **Responsável pela aprovação:** a definir; nenhuma decisão proposta é automaticamente aprovada.

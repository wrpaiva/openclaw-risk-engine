# ADR-0009 — Separar testes locais por fase e regressão ponta a ponta no marco final

- **Status:** Proposto (pendente de aprovação)
- **Data:** 2026-11-13
- **Projeto:** OpenClaw Trading Risk Engine
- **Referência normativa:** `SPEC_OPENCLAW_RISK_ENGINE.md` v1.0.0
- **Escopo:** Fase 2 / paper trading

## Contexto
O usuário definiu que a regressão integrada ocorrerá somente após concluir as fases. Ainda assim, cada alteração precisa de feedback de qualidade durante seu desenvolvimento.

## Decisão proposta
Executar typecheck, testes unitários, contratos e integração pertinentes em cada etapa; não executar suíte de regressão ponta a ponta antecipadamente. Ao final, executar matriz integrada OpenClaw→Risk Engine→Paper Trading→observabilidade, cenários de erro, concorrência, idempotência e rollback, com evidências versionadas.

## Alternativas consideradas
- Nenhum teste até o final: rejeitado pelo risco de acumular defeitos.
- E2E completo a cada pequena etapa: adiado, conforme planejamento.
- Tests dependentes de mercado real/LLM: substituídos por fixtures determinísticas para núcleo e contratos.

## Justificativa e consequências
+ Feedback rápido durante construção com regressão formal concentrada no marco final.
- Exige rastreabilidade de cobertura por cenário e versão.
- Falhas de integração podem ser percebidas mais tarde; mitigar com contratos por fase.

## Restrições, riscos e mitigação
Não usar chamadas pagas a LLM como teste unitário; usar fixtures e mocks. Para integrações externas, solicitar aprovação antes de testes que gerem custos ou alterem produção.

## Critérios de validação
- Typecheck e testes da etapa 2.1 passam antes de 2.2.
- Testes de concorrência obrigatórios antes de liberar autorizações paper.
- Relatório final relaciona invariantes I-01..I-08 a evidências.

## Relação com a especificação
Seções 2.3, 9, 10 e 13.

## Revisão da decisão
- **Gatilhos para revisão:** mudança no escopo de fases ou em requisitos de homologação
- **Dependências em aberto:** D-09, D-10
- **Responsável pela aprovação:** a definir; nenhuma decisão proposta é automaticamente aprovada.

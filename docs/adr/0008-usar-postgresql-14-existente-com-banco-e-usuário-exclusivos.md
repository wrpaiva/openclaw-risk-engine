# ADR-0008 — Usar PostgreSQL 14 existente com banco e usuário exclusivos

- **Status:** Proposto (pendente de aprovação)
- **Data:** 2026-11-13
- **Projeto:** OpenClaw Trading Risk Engine
- **Referência normativa:** `SPEC_OPENCLAW_RISK_ENGINE.md` v1.0.0
- **Escopo:** Fase 2 / paper trading

## Contexto
Já há `postgres_postgres` rodando na VPS, mas não é apropriado misturar schemas e credenciais de outros serviços no Risk Engine.

## Decisão proposta
Planejar banco lógico `openclaw_risk` e usuário dedicado de menor privilégio na instância PostgreSQL 14 existente; criar apenas na etapa de persistência, após revisar backup, acesso de rede e aprovação. Usar migrations versionadas e secrets. O banco é a fonte de verdade de decisões e reservas; Redis é opcional, não obrigatório na v1.

## Alternativas consideradas
- Novo container PostgreSQL agora: rejeitado por duplicação sem necessidade.
- Reutilizar banco/usuário administrativo de outro serviço: rejeitado.
- Arquivos JSON locais como persistência de auditoria/autorização: rejeitados.

## Justificativa e consequências
+ Reuso de infraestrutura, isolamento lógico e menor custo operacional.
- Instância compartilhada exige revisão de capacidade, backup e privilégios.
- Falha do banco bloqueia novas autorizações por desenho.

## Restrições, riscos e mitigação
Proibir migrations destrutivas não revisadas, credenciais no Git e dependência de volume volátil. Definir restauração, retenção e monitoramento antes de implantação. Não executar DDL automaticamente a partir deste ADR.

## Critérios de validação
- Teste de migration up e verificação de constraints.
- Teste de restauração em ambiente isolado.
- Revogar permissões para tabelas fora do banco/schema de risco.
- Testes de indisponibilidade do banco => ausência de autorização.

## Relação com a especificação
Seções 1.1, 7, 9 e 11.

## Revisão da decisão
- **Gatilhos para revisão:** limites de capacidade/HA que justifiquem instância própria
- **Dependências em aberto:** D-05, D-10
- **Responsável pela aprovação:** a definir; nenhuma decisão proposta é automaticamente aprovada.

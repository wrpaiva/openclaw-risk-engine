# ADR-0010 — Governança de evolução e proibição de execução real nesta fase

- **Status:** Proposto (pendente de aprovação)
- **Data:** 2026-11-13
- **Projeto:** OpenClaw Trading Risk Engine
- **Referência normativa:** `SPEC_OPENCLAW_RISK_ENGINE.md` v1.0.0
- **Escopo:** Fase 2 / paper trading

## Contexto
O projeto evoluirá com agentes, executor de simulação e eventualmente outras capacidades. Decisões técnicas e limites de segurança não podem mudar informalmente.

## Decisão proposta
Manter ADRs imutáveis após aceite: novas decisões supersedem antigas por referência; a SPEC contém requisitos e contratos, ADRs contêm motivações e trade-offs. Qualquer habilitação de operação real exige projeto, revisão de segurança, decisão e aprovação separados. Mudanças de política exigem versionamento e aprovação por responsável definido.

## Alternativas consideradas
- Atualizar decisões antigas silenciosamente: rejeitada.
- Considerar deploy como aprovação automática: rejeitado.
- Permitir bypass temporário do Risk Engine: rejeitado.

## Justificativa e consequências
+ Histórico auditável de arquitetura e autorização de mudanças.
- Governança explícita para sistemas de maior risco.
- Revisões exigem atualização de testes e documentação relacionada.

## Restrições, riscos e mitigação
Evitar status `Aceito` sem aprovação. Não incluir credenciais, dados de contas ou regras financeiras arbitrárias nos documentos. Definir proprietário de segurança e processo de aprovação antes de ativar políticas.

## Critérios de validação
- Lint/revisão de referências entre SPEC e ADRs.
- Mudanças de escopo trazem ADR novo, testes e critérios de rollback.
- Não há caminho de execução real ou credenciais de produção no projeto.

## Relação com a especificação
Seções 1.3, 11, 12 e 13.

## Revisão da decisão
- **Gatilhos para revisão:** aprovação formal de expansão de escopo
- **Dependências em aberto:** D-04, D-08 a D-10
- **Responsável pela aprovação:** a definir; nenhuma decisão proposta é automaticamente aprovada.

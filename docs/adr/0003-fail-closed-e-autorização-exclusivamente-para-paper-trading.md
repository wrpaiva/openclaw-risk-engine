# ADR-0003 — Fail-closed e autorização exclusivamente para paper trading

- **Status:** Proposto (pendente de aprovação)
- **Data:** 2026-11-13
- **Projeto:** OpenClaw Trading Risk Engine
- **Referência normativa:** `SPEC_OPENCLAW_RISK_ENGINE.md` v1.0.0
- **Escopo:** Fase 2 / paper trading

## Contexto
O risco mais grave é aprovar uma ordem em contexto incompleto, ou confundir decisão de simulação com permissão para operações reais.

## Decisão proposta
Somente decisões `ALLOW_PAPER` ou `BLOCK`. `ALLOW_PAPER` exige política válida, dados íntegros e atuais, reserva persistida e validade curta. Qualquer falha essencial impede autorização. O motor não recebe credenciais de corretora real. O futuro executor paper deve consultar e consumir decisão persistida, vinculada ao hash da proposta.

## Alternativas consideradas
- Fail-open durante indisponibilidade: rejeitada.
- `ALLOW` genérico sem escopo: rejeitada.
- Confiar no campo `accountType` fornecido por agente: rejeitada; conta deve ser confirmada no servidor.

## Justificativa e consequências
+ Segurança por padrão e fronteira inequívoca com execução real.
- Falhas degradam disponibilidade e podem gerar mais bloqueios; isso é intencional.
- Autorizações exigem persistência e consumidor idempotente.

## Restrições, riscos e mitigação
Erros 400/422 e falhas técnicas devem ser distinguíveis de `BLOCK`, mas nunca resultar em permissão. Não registrar segredos. Política inexistente => bloqueio ou falha sem autorização.

## Critérios de validação
- Injetar falha de DB, política, câmbio, market data e concorrência: nenhuma autorização.
- Testar rejeição de conta real e de autorização expirada/alterada.
- Auditoria da decisão produz evidência de política, snapshot e proposta.

## Relação com a especificação
Seções 1.2, 2.2, 3.2, 4.4, 8 e 9.

## Revisão da decisão
- **Gatilhos para revisão:** se houver projeto futuro de execução real, abrir nova fase e ADR independente
- **Dependências em aberto:** D-01 a D-10
- **Responsável pela aprovação:** a definir; nenhuma decisão proposta é automaticamente aprovada.

# ADR-0005 — Políticas versionadas, imutáveis e aprovadas explicitamente

- **Status:** Proposto (pendente de aprovação)
- **Data:** 2026-11-13
- **Projeto:** OpenClaw Trading Risk Engine
- **Referência normativa:** `SPEC_OPENCLAW_RISK_ENGINE.md` v1.0.0
- **Escopo:** Fase 2 / paper trading

## Contexto
A mesma proposta pode ter resultado diferente conforme limites e calendário. Para auditoria, é essencial reproduzir qual política estava ativa na avaliação.

## Decisão proposta
Persistir política com `policyId`, `version`, `policyHash`, validade, `accountId` e estado. Alteração cria versão nova, sem sobrescrever versão usada por decisões anteriores. Apenas políticas completas e aprovadas podem ser ativadas. Não atribuir valores financeiros padrão.

## Alternativas consideradas
- Configuração editável sem histórico em `.env`: rejeitada.
- Limites numéricos definidos por IA: rejeitada.
- Atualização in-place da política ativa: rejeitada.

## Justificativa e consequências
+ Rastreabilidade e reprodutibilidade.
- Exige processo de aprovação/ativação e migração de versões.
- Facilita auditoria de incidentes e reprodução de decisões.

## Restrições, riscos e mitigação
O hash deve usar representação canônica documentada. Validade temporal e exclusividade de política ativa por conta devem ser garantidas no banco. Ausência, sobreposição ambígua ou expiração implica ausência de autorização.

## Critérios de validação
- Mesmo JSON canônico => mesmo SHA-256.
- Mudança efetiva => nova versão/hash.
- Testes de política expirada, desligada, múltiplas ativas e versão ausente.
- Sem limites aprovados, `ALLOW_PAPER` não será habilitado em produção.

## Relação com a especificação
Seções 1, 2, 4.2, 7 e 12.

## Revisão da decisão
- **Gatilhos para revisão:** definição de governança multi-conta ou regulamentação de auditoria
- **Dependências em aberto:** D-04, D-07 e D-08
- **Responsável pela aprovação:** a definir; nenhuma decisão proposta é automaticamente aprovada.

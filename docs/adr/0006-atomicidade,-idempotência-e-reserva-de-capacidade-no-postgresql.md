# ADR-0006 — Atomicidade, idempotência e reserva de capacidade no PostgreSQL

- **Status:** Proposto (pendente de aprovação)
- **Data:** 2026-11-13
- **Projeto:** OpenClaw Trading Risk Engine
- **Referência normativa:** `SPEC_OPENCLAW_RISK_ENGINE.md` v1.0.0
- **Escopo:** Fase 2 / paper trading

## Contexto
Sob concorrência, duas propostas podem enxergar a mesma capacidade livre. Aprovações sem reserva podem ultrapassar limites apesar de cada avaliação isolada passar.

## Decisão proposta
Persistir proposta, decisão, reserva e auditoria em transação única PostgreSQL 14. Garantir unicidade por `(accountId,idempotencyKey)` e `proposalHash` canônico; mesmo payload retorna decisão original, payload divergente gera conflito. Serializar operações por conta com row-level lock (ou estratégia equivalente comprovada). Emitir `ALLOW_PAPER` apenas após commit bem-sucedido.

## Alternativas consideradas
- Lock em memória de um processo: rejeitado como garantia distribuída.
- Cache Redis como fonte de verdade: rejeitado inicialmente.
- Aprovar e registrar em transações separadas: rejeitado.

## Justificativa e consequências
+ Proteção contra dupla reserva e oversubscription.
- Dependência de disponibilidade e consistência do PostgreSQL.
- Potencial contenção por conta; medir antes de otimizar.

## Restrições, riscos e mitigação
Falha de commit ou timeout gera nenhuma autorização. Retries de transação devem ser limitados e idempotentes. Releasing/consuming reservas requer máquinas de estado e registros auditáveis. Fonte de verdade da carteira precisa ser definida para não duplicar saldos.

## Critérios de validação
- Concorrência com duas operações que juntas excedem limite: no máximo uma autorização.
- Replay idêntico: uma decisão/uma reserva.
- Replay conflitante: erro sem nova reserva.
- Simular crash entre avaliação e commit: sem aprovação; entre commit e resposta: replay retorna decisão anterior.

## Relação com a especificação
Seções 2.2, 3, 7, 9 e 12.

## Revisão da decisão
- **Gatilhos para revisão:** múltiplas bases de dados, carga que justifique outro mecanismo ou executor implantado
- **Dependências em aberto:** D-05, D-09 e D-10
- **Responsável pela aprovação:** a definir; nenhuma decisão proposta é automaticamente aprovada.

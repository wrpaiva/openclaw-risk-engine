# Notas — Etapas 2.1 a 2.3

## Etapa 2.1

Fundação, contratos e política.

- Projeto Node 22 + TypeScript strict (`tsconfig.json`, `tsconfig.build.json`), ESLint, Vitest.
- Contratos v1 com validação em runtime (zod) em `src/domain/`: `TradeProposal`, `RiskPolicy`, `RiskContext`, `RiskDecision`, `RiskViolation`, `InstrumentSpec`.
- Value objects decimais (`DecimalAmount`, `Price`, `UtcInstant`) sobre `decimal.js`; notação exponencial e escala não permitida são rejeitadas.
- Hash canônico SHA-256 (`src/domain/canonicalHash.ts`) para proposta e política.
- Política sem limites aprovados não é ativável; nenhum limite monetário padrão.
- Observação técnica: o import default de `decimal.js` sob NodeNext precisa do cast em `DecimalAmount.ts`.

## Etapa 2.2

Motor de regras puro.

- Uma `RiskRule` por verificação em `src/rules/`, avaliadas na ordem fixa da SPEC §5 pelo `RiskEvaluator`.
- Cálculo monetário conservador e instrument-aware (`tradeMetrics.ts`, `FxRateRule`); usa bid/ask confiáveis, nunca o `referencePrice` do agente.
- Exposição bruta = abertas + reservas pendentes + nova, sem netting compra/venda.
- Exceção em regra → bloqueio (nunca "sem violações"). Relógio injetável.
- Teste de arquitetura (`tests/unit/architecture/boundaries.test.ts`) impede rede/BD em `src/domain` e `src/rules` e qualquer import de `pixel-agents`/`pixel-events`.

## Etapa 2.3

Persistência, auditoria e concorrência (PostgreSQL 14).

- `migrations/0001_initial.sql`: `risk_accounts` (somente PAPER), `risk_policies` (versões imutáveis, uma ativa por conta), `trade_proposals`, `risk_decisions`, `risk_reservations` (máquina de estados ACTIVE → CONSUMED | EXPIRED | RELEASED), `risk_audit_events`, `risk_outbox`. Triggers bloqueiam UPDATE/DELETE em proposta, decisão e auditoria; o banco rejeita `ALLOW_PAPER` sem reserva e `BLOCK` sem violação.
- Runner de migrações com checksum (`src/infrastructure/postgres/migrate.ts`): migração alterada após aplicada é rejeitada.
- Casos de uso em `src/application/`: `EvaluateTradeRisk`, `ConsumePaperAuthorization`, `ReleaseRiskReservation`, `ExpireRiskReservations`.
- Fluxo transacional da SPEC §7.2: idempotência por `(accountId, idempotencyKey)`, lock por conta, avaliação, persistência de decisão + reserva + auditoria + outbox antes do COMMIT. Resultados de transporte separados do `BLOCK` de domínio: `REJECTED` (401/403/400/422), `IDEMPOTENCY_CONFLICT` (409), `UNAVAILABLE` (503).
- Auditoria e outbox não guardam o payload da proposta.
- Autorização de agente hoje é uma allowlist global (`agentAllowlist`); a autorização agente × conta fica para a 2.4.

### Verificação

`sh scripts/check.sh` (typecheck, lint, unitários, integração): 442 testes unitários + 46 de integração/concorrência verdes em 2026-11-13.
Integração usa contêiner descartável `postgres:14-alpine` em 127.0.0.1:55432 (`scripts/test-db.sh`); nunca usar bancos existentes da máquina.

### Pendências que seguem abertas

Decisões D-01…D-10 (SPEC §12) continuam sem resposta; testes usam fixtures explícitas. `ALLOW_PAPER` não deve ser ativado em produção enquanto as decisões essenciais estiverem abertas.

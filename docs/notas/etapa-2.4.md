# Notas — Etapa 2.4 (Adaptador OpenClaw e integração paper-only)

Status: aprovada pelo usuário em 2026-11-14.

## Desenho proposto

- **Transporte:** HTTP com `node:http` nativo, sem dependências novas. Só sobe com `RISK_HTTP_ENABLED=true`; host e porta obrigatórios; host coringa (`0.0.0.0`, `::`) rejeitado na 2.4. Rotas da SPEC §8.2: evaluations, decisions/{id}, consume, release. `/health/*` fica para a 2.5.
- **Autenticação:** token Bearer opaco por principal (`AGENT` | `PAPER_EXECUTOR`). Arquivo `RISK_PRINCIPALS_FILE` guarda só hashes SHA-256 (array, para permitir rotação). A comparação usa `timingSafeEqual` contra todos os hashes. Qualquer erro no arquivo impede o boot. O `Authorization` é avaliado antes de ler o corpo.
- **Autorização agente × conta:** migração nova `0002_access_grants.sql` (tabela `risk_access_grants`, append-only, revogação por `revoked_at`). Substitui a `agentAllowlist` global. Os sete agentes passam a ser dados (credencial + grant), não código. O grant é checado sob o lock da conta e **antes** da idempotência.
- **Consume/release:** exigem principal `PAPER_EXECUTOR` com grant na conta. O consume também confere o `proposalHash`. O caso de uso novo `GetRiskDecision` é restrito ao dono da decisão ou ao executor da conta.
- **Logs:** JSON lines, com allowlist de campos tipados. Nunca saem headers, corpo, token ou `error.message` do pg.
- **Config:** `loadConfig(env)` com zod. Exige `RISK_ENVIRONMENT=PAPER` e recusa iniciar se houver variáveis com padrão de credencial de exchange. Limites (body, timeouts, tolerância de relógio) são obrigatórios e sem default.
- **Fontes de mercado/snapshot/catálogo:** adaptadores "Unconfigured" que devolvem `null` até D-02/D-03/D-05. Por isso o servidor real só emite `BLOCK`.

## Mapeamento HTTP

| Resultado | Status |
|---|---|
| Decisão `BLOCK` ou `ALLOW_PAPER` (inclui replay) | 200 |
| Sem token ou token inválido | 401 |
| Papel errado ou sem grant | 403 |
| Corpo acima do limite | 413 |
| JSON inválido | 400 |
| Contrato inválido | 422 |
| Conflito de idempotência, consume ou release | 409 |
| Infraestrutura | 503 |
| Exceção inesperada | 500, nunca 200 |

## Tarefas (ondas)

1. D1 avaliador com grant, D2 helpers de id; B1 migração 0002, B2 ports, B3 autenticação, B4 logger, B5 config, B6 fontes Unconfigured; T1 testes do avaliador.
2. B7 EvaluateTradeRisk com grant, B8 consume/release/GetRiskDecision; T2–T4 testes de auth, logger e config.
3. B9 servidor HTTP, B10 main, script de token, exports e `.env.example`; T5 integração de grants, T6 contrato HTTP, T7 HTTP ponta a ponta com Postgres descartável, T8 asserts de arquitetura.

## Decisões em aberto tocadas

D-08 (quem concede grants), D-09 (protocolo consume/release, tratado como provisório), D-02/D-03/D-05 (fontes reais), D-10 (rede/TLS na 2.5).

## Decisões do usuário (2026-11-14)

- 403 por falta de grant: **só log estruturado**. Não gravar `ACCESS_DENIED` em `risk_audit_events`.
- Decisão de outro agente ou de outra conta: **404**.
- Bearer sem TLS no processo é aceitável na 2.4 (bind local); TLS/rede fica para a 2.5.
- Rate-limit **na borda**; nada no processo.

Premissas confirmadas pelo usuário em 2026-11-14: na 2.4 os grants são inseridos por SQL, sem CLI administrativa (D-08 aberta). O protocolo de consume (`paperOrderId` + `proposalHash`) é provisório (D-09). Os IDs dos sete agentes são fixtures `fixture-agent-1…7` até o usuário informar os reais.

Ajuste do líder: script `test:contract` adicionado ao `package.json`.

## Revisão do revisor (2026-11-14)

Veredito: pronta para revisão do usuário; nenhum achado CRÍTICO ou ALTO.

Registros de documentação:

- **Release sem grant → 404, não 403.** Exceção à tabela acima. O release não informa a conta, então um 403 revelaria que a reserva existe. O consume, que informa a conta, devolve 403 sem grant.
- **422 (contrato inválido) não grava em `risk_audit_events`; vai só para o log `http.request`.** A SPEC §3.2 pede auditoria "se identificador confiável estiver disponível". Gravar antes de checar o grant permitiria escrita sem autorização. **Decisão do usuário (2026-11-14): manter só em log.**
- **Revogação de grant:** o ponto de linearização é a leitura do grant sob o lock da conta. Uma revogação confirmada logo depois dessa leitura não afeta a decisão em curso.
- **Fica para a 2.5:** o trigger append-only não cobre `TRUNCATE` (B8). Tratar com privilégios mínimos do usuário de runtime.
- **Para decidir em D-09:** se o release deve ficar vinculado a `proposalHash`/`paperOrderId`.
- **Adiado pelo usuário (2026-11-14):** se a unicidade de `proposalId` deve ser por conta (hoje é global, herdado da 2.3). O vínculo do release (D-09) também foi adiado.

## Correções pós-revisão (2026-11-14)

- **M1:** consume e GET revalidam o `decision_json` com `validateRiskDecision`. No consume, `reservationId`, `accountId`, `decisionId` e o instante de expiração da reserva precisam bater com os da decisão. Qualquer divergência dá 503, sem consumir nada.
- **M2:** os switches do servidor são exaustivos, inclusive o de `getDecision`. Um kind inesperado ou uma resposta não enviada vira 500 `INTERNAL_ERROR` com log `http.internal_error`.
- **B1:** níveis de log por status: ≥500 em error, 401/403 em warn. Um `agentId` divergente gera warn `evaluate.forbidden`.
- **B2:** o `.env.example` não menciona mais `localhost`.
- **B4 (parcial):** release de reserva ACTIVE com TTL vencido fecha a reserva como EXPIRED e responde 409 `{status:'EXPIRED'}`. O vínculo do release ao `proposalHash` fica para D-09.
- **B5 (parcial):** um conflito com `proposalId` de outra conta grava a auditoria com `proposal_id` NULL. A unicidade global do `proposalId` não mudou.
- **B6:** um erro de `listen` gera mensagem fixa e `exit(1)`.
- **Testes:** o pool de teste ganhou listener de `error`. Ele mitiga um 57P01 intermitente no teardown, visto 2 vezes e não reproduzido depois em 32 execuções. A causa não foi confirmada.

Regressão local final: typecheck e lint limpos; 623 testes unitários, 127 de contrato e 103 de integração (incluindo concorrência), todos passando.

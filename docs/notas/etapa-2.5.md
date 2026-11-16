# Notas — Etapa 2.5 (Empacotamento e operação)

Status: concluída em 2026-11-14 e aprovada pelo usuário em 2026-11-15. Ondas 1 a 5 concluídas. Relatório consolidado: [regressao-final.md](regressao-final.md).

## Herdado da 2.4

- `/health/*` adiado para esta etapa.
- Rede/TLS (D-10): na 2.4 o bind ficou só em loopback e o Bearer trafega sem TLS.
- Privilégios mínimos do usuário de runtime: sem `TRUNCATE`/`UPDATE`/`DELETE` nas tabelas append-only (achado B8).
- Regressão ponta a ponta completa (SPEC §9.4) só nesta etapa final.

## Plano do arquiteto (2026-11-14), resumido

**Escopo (SPEC §10, 2.5):**
- Dockerfile multi-stage não-root, com imagem versionada.
- `/health/live` e `/health/ready`.
- Secrets lidos de arquivo, com conta de migração separada da de runtime.
- Migração por comando one-shot, nunca no boot.
- Runbook de deploy, rollback, backup e troubleshooting.
- Métricas da §11.3, alarmes mapeados para sinais, sem limiares.
- Regressão §9.4 com relatório de evidências e rastreabilidade de UT-001..020 e I-01..08.

Nada é implantado; nenhum endpoint é publicado.

**Constatações:**
- Bind só em loopback é inviável em contêiner com rede bridge/overlay; isso depende de D-10.
- A imagem real só emite BLOCK, porque as fontes estão Unconfigured. ALLOW, consume e concorrência são provados numa composição de teste em `tests/`, sem modo fixture na imagem.
- Ninguém dispara `ExpireRiskReservations`. A 2.5 cria um subcomando one-shot, mas não o agenda.
- `migrate.sh` usa a credencial de runtime e precisa da credencial de migração (§11.1).
- `RISK_POLICY_ID` (§11.2) não existe: a política ativa é por conta no banco.

**Privilégio mínimo:**
- Roles `openclaw_risk_owner` (migração) e `openclaw_risk_runtime` (NOLOGIN, grupo).
- A migração `0003_runtime_privileges.sql` concede grants exatos: SELECT/INSERT nas tabelas append-only e UPDATE só em `risk_reservations(status, closed_at, paper_order_id)`. Nenhum DELETE ou TRUNCATE.
- Triggers BEFORE TRUNCATE em todas as tabelas (achado B8 da 2.4).
- `scripts/provision/roles.sql` cuida de CONNECT e do schema public.
- O boot pode se recusar a subir se o usuário conectado tiver privilégio excessivo.

**Ondas:**
1. Migração 0003, roles e portas `ReadinessProbe`/`RiskMetrics`, com os helpers de teste. A 0003 e o suporte de teste entram juntos.
2. Adaptadores de readiness e privilégios, rotas de saúde, config `_FILE`, CLI (`migrate`, `expire-reservations`, `verify-runtime-privileges`, `healthcheck`), draining e métricas.
3. Dockerfile, `.dockerignore`, build da imagem, `deploy/stack.example.yml` (template, não aplicado), `test-e2e.sh` e backup/restore local.
4. Regressão §9.4 itens 1–10, teste de rastreabilidade e documentação em `docs/operacao/`.
5. Revisor, security-auditor e relatório final.

O papel `dominio` não tem tarefas nesta etapa.

**Fora da 2.5:**
- Implantar na VPS ou criar `/opt/openclaw-risk-engine` lá.
- Swarm, Traefik ou portas publicadas.
- Rodar SQL no Postgres de produção.
- Alterar OpenClaw ou Pixel.
- Executor paper, posição e P&L.
- Fontes reais de dados.
- CLI de admin (D-08).
- Prometheus e alertas.
- Ativar ALLOW_PAPER em produção.

## Decisões do usuário (2026-11-14)

- **D-10 adiada.** A 2.5 mantém o bind só em loopback; o E2E usa `--network host`. As opções O1–O4 vão para um ADR-0011 com status Proposto, para decisão antes do deploy.
- **Regressão §9.4:** usa o simulador dos 7 agentes e um stub de executor. As lacunas (OpenClaw real, posição/P&L, receiver e painel) ficam declaradas no relatório.
- **Restauração de backup:** o serviço fica indisponível (not-ready) até reconciliar. As reservas ACTIVE anteriores ao ponto de restauração são expiradas antes de voltar.
- **Recomendações aceitas:**
  - `/health/*` sem auth, na mesma porta.
  - A readiness exige banco, schema e privilégios, não as fontes externas. Aceita migração extra (rollback N-1).
  - `HEALTHCHECK` em `/live`, sem valores numéricos no Dockerfile.
  - Métricas derivadas de log.
  - Roles `openclaw_risk_owner` e `openclaw_risk_runtime`; sem role admin até D-08.
  - O boot recusa subir com privilégio excessivo.
  - Imagem `node:22-bookworm-slim` fixada por digest, só local, com `docker save`.
  - O backend é dono de Dockerfile, `.dockerignore`, `package.json`, `.env.example`, `deploy/`, `docs/operacao/` e `README.md`.
  - Alarmes, limiares, retenção, frequência da varredura e grace period ficam "a definir".
- **Divergência registrada:** `RISK_POLICY_ID` (§11.2) não existe; a política ativa é por conta.
- **Pendente:** Q15 (`npm audit` com rede e scanner de imagem como trivy). Perguntar na onda 5.

## Onda 1 concluída (2026-11-14)

- **Migração `0003_runtime_privileges.sql`:**
  - Concede grants mínimos à role `openclaw_risk_runtime`.
  - Coloca triggers BEFORE TRUNCATE nas 8 tabelas, que barram até o superuser.
  - Aborta se a role não existir ou se `current_user` herdar dela.
- **`scripts/provision/roles.sql` e `scripts/provision-db.sh`:** o script só aceita banco local e `*_test`, salvo flag explícita. O login de runtime é criado pelo operador com senha vinda de secret.
- **Portas e caso de uso:** `ReadinessProbe`, `CheckReadiness`, `RiskMetrics` e `NoopMetrics`.
- **Testes:**
  - O suporte de integração cria o grupo de runtime e logins de teste.
  - `RuntimePrivileges` tem 29 testes: 42501 em tudo que é proibido e trigger de TRUNCATE para o owner.
  - `CheckReadiness` tem 13 testes.
- **Verificação do líder:** typecheck e lint limpos; 644 unit, 127 contract e 132 integration passando.

## Onda 2 concluída (2026-11-14)

- **Readiness e privilégios:** `PgReadinessProbe` checa database, schema (aceita migração extra) e privilégios. `PgPrivilegeInspector` reprova superuser, atributos de role, owner, `CREATE` em public e qualquer grant além da 0003.
- **Rotas de saúde:**
  - `/health/live` e `/health/ready`, sem auth, com 405 para outros métodos e `no-store`.
  - Durante o draining, `ready` dá 503 e `live` continua 200.
- **Config:**
  - Aceita `RISK_DATABASE_URL_FILE` e `RISK_MIGRATION_DATABASE_URL(_FILE)`.
  - O servidor recusa subir se houver `RISK_MIGRATION_*` no ambiente (iniciativa do backend).
- **CLI** `dist/interfaces/cli/main.js`:
  - Subcomandos `migrate`, `expire-reservations`, `verify-runtime-privileges` e `healthcheck`.
  - Exit 0 = ok, 1 = falha, 2 = uso/config.
  - `scripts/migrate.sh` chama a CLI com a credencial de migração.
- **Boot:**
  - Faz a autoverificação de privilégios antes do `listen`.
  - SIGTERM/SIGINT ligam o draining, fecham o servidor e encerram o pool.
- **Métricas derivadas de log:**
  - Eventos `metric.*` em nível `info`. **Atenção no runbook:** com `RISK_LOG_LEVEL=warn` ou `error` elas somem.
  - `dependencyFailure` só é emitido para `DATABASE`. MARKET_DATA, INSTRUMENT_CATALOG e ACCOUNT_SNAPSHOT esperam D-02/03/05.
- **Bug corrigido:** um cliente pg em uso que perdia a conexão derrubava o processo. Agora `guardClient` cobre os quatro `pool.connect()`.
- **Verificação do líder:** typecheck e lint limpos; 701 unit, 156 contract e 254 integration passando.
- ADR-0011 (Rede e TLS do canal transacional, Proposto) registrado pelo líder com as opções O1–O5 da D-10.

## Onda 3 concluída (2026-11-14)

- **Dockerfile multi-stage:**
  - Base `node:22-bookworm-slim@sha256:e9f565d3…21ee`, resolvida em 2026-11-14.
  - Roda como usuário `1000:1000`, read-only, com ENTRYPOINT em exec form.
  - HEALTHCHECK via CLI `healthcheck`, sem valores numéricos.
  - Labels OCI. A imagem `openclaw-risk-engine:0.1.0` tem cerca de 234 MB e leva só as dependências de produção.
- **Scripts:**
  - `scripts/build-image.sh` usa o builder `default` e aceita `--save` para gerar `build/*.tar`.
  - `scripts/test-e2e.sh` usa banco e app descartáveis com label `com.openclaw-risk-engine.test=1`, migração pela imagem e app `--read-only --cap-drop ALL`.
  - `scripts/backup-local.sh` e `restore-local.sh` só atuam em bancos `*_test` e recusam destino não vazio.
- **`deploy/stack.example.yml`:** template NÃO APLICADO, sem `ports:`. Rede, healthcheck e grace period ficam "a definir".
- **Mudança no `main` HTTP:** erro de configuração agora sai com 2, igual à CLI. Privilégio, banco e listen continuam saindo com 1. O teste `MainShutdown` precisa de ajuste, que vai para a onda 4.
- **Limpeza:** o líder removeu uma imagem própria sem tag que sobrou do primeiro build. Nenhum `prune` foi usado.

## Onda 4 concluída (2026-11-14)

- **Documentação operacional:** `README.md` e `docs/operacao/` (runbook, deploy, rollback, backup-restauracao, alarmes, troubleshooting, seguranca).
- **Regressão §9.4:**
  - `tests/e2e/` com os arquivos `image`, `health` e `regression/item-01..10`. A composição de teste roda como login de runtime, e a imagem real só emite BLOCK.
  - Resultado na data: 122 passando, 1 `it.fails` e 2 `todo`. Após as correções pós-regressão: 138 passando, nenhum `fails`/`todo`/`skip`.
  - `tests/unit/traceability.test.ts` cobre UT-001..020 e I-01..08.
- **Contagens:** 733 unit, 156 contract, 260 integration, 122 e2e.
- **Lacunas declaradas:**
  - OpenClaw real (o teste usa cliente simulado).
  - Ordem, posição e P&L (D-05/D-09).
  - Receiver e painel reais.
  - Scanner de segurança (Q15).
- **Achados enviados ao backend:**
  - MÉDIA: `/health/ready` pendura com o banco congelado, porque não há prazo do lado do cliente.
  - Faltava o procedimento pós-restauração decidido pelo usuário. A proposta é a migração 0004 (flag `restore_pending`), o check `reconciliation`, 503 nos casos de uso enquanto a flag estiver ligada, e os comandos `reconcile-after-restore` e `mark-restore-pending` na CLI, ambos com a credencial de migração.
  - O `restore-local.sh` precisa aplicar `roles.sql`, corrigir o ownership e marcar a flag.
  - BAIXA: imagem com `.js.map` e pastas de escopo vazias.
  - BAIXA: o log do 422 sai sem os `violationCodes`.
  - `test-e2e.sh` deve rodar com `--no-file-parallelism`.

## Correções pós-regressão (2026-11-14)

- **Prazos do lado do cliente (`clientLease.ts`):**
  - Espera por conexão do pool: `RISK_DB_CONNECTION_TIMEOUT_MS`.
  - Cada comando e cada check: `CONNECTION + STATEMENT` timeout.
  - Com o banco congelado, a readiness e os casos de uso dão 503 em tempo finito.
- **Reconciliação pós-restauração (decisão do usuário):**
  - Migração `0004_restore_reconciliation.sql`: `risk_operational_state.restore_pending` mais histórico append-only; o runtime só tem SELECT.
  - Novo check `reconciliation` na readiness.
  - `lockAccount` lança `RestorePendingError`, então evaluate, consume e release dão 503.
  - CLI `reconcile-after-restore` e `mark-restore-pending`, com a credencial de migração.
  - `restore-local.sh` aplica `roles.sql`, restaura com dono `openclaw_risk_owner` e marca `restore_pending`.
- **Ajustes menores:**
  - A imagem não leva mais `.js.map` nem diretórios vazios.
  - O log do 422 inclui os `violationCodes`.
  - `test-e2e.sh` roda com `--no-file-parallelism`.
- **Verificação do líder:** typecheck e lint limpos; imagem reconstruída; 736 unit, 158 contract, 306 integration e 138 e2e passando.
  - Observação: a porta padrão do e2e (55442) ficou presa no daemon Docker sem nenhum listener. Rodou com `RISK_E2E_DB_PORT=55452` e `RISK_E2E_APP_PORT=55453`.
- **Q15:** o usuário autorizou `npm audit` e trivy (contêiner temporário, imagem via `docker save`).

## Onda 5 concluída (2026-11-14)

- **Revisor:** nenhum achado CRÍTICO ou ALTO. **Security-auditor:** nenhum CRITICAL. A regressão final foi verificada pelo líder.
- **Restauração:**
  - M1: o restore marca `restore_pending` logo após o `pg_restore`, com o CONNECT do runtime revogado durante todo o processo.
  - M7: `ExpireRiskReservations` chama `assertOperational()` antes de começar.
- **Privilégios e conexões:**
  - M2: `createPool` fixa `search_path=public`. O inspetor ganhou `CREATE_ON_DATABASE`, `TEMP_ON_DATABASE` e `OWNS_OR_CREATES_IN_SCHEMA`, e reprova SELECT no histórico.
  - M3: a CLI de migração exige os 3 timeouts de banco, que já existiam, e usa `ClientLease`.
  - M6: a readiness faz single-flight.
- **Segurança:**
  - W1: os scripts recusam URL com query ou `%` e validam a conexão efetiva antes de escrever.
  - W3: os segredos do e2e ficam com 0400/0700, e os contêineres rodam com `--user` do host.
  - S1: a imagem não tem npm/npx/corepack/yarn.
  - S4: 404/405 com corpo fecham a conexão.
- **Testes:** B5 aplicou uma label por ciclo no e2e.
- **Documentação:** M4, M5, B1, B3, B4, B6, W2, W4, S2, S3, S5 e S7 em `docs/operacao/`.
- **Relatório consolidado e execução final:** [regressao-final.md](regressao-final.md). Resultado: 771 unit, 178 contract, 409 integration e 142 e2e, todos passando.

# Deploy

> **Nada aqui foi executado.** Implantar na VPS, criar `/opt/openclaw-risk-engine`, criar rede/secret/serviço Swarm, mexer no Traefik e rodar SQL no PostgreSQL de produção **requerem aprovação explícita do usuário**. O arquivo `deploy/stack.example.yml` é exemplo documental: não rode `docker stack deploy` com ele. Rede e TLS: o ADR-0011 foi aceito em 2026-11-15 (O2, overlay dedicada e cifrada) e o mecanismo `RISK_HTTP_BIND_SCOPE` está implementado, mas o deploy, a criação da rede, o nome dela e a anexação do OpenClaw dependem de aprovação explícita.

## Pré-requisitos

- Aprovação do usuário para cada passo marcado abaixo como "(requer aprovação)".
- Decisões abertas que afetam o deploy: D-10 (backup; rede/TLS decididos no ADR-0011, `sslmode` e nome da rede a confirmar no deploy), D-08 (quem concede grants), D-01 a D-09 para habilitar `ALLOW_PAPER` (SPEC §12).
- Imagem local construída: `npm run image:build` (gera `openclaw-risk-engine:<versão>`); `sh scripts/build-image.sh --save` grava `build/openclaw-risk-engine-<versão>.tar` (`docker save`) para transporte sem registry.

## 1. Provisionamento do banco (requer aprovação; feito por DBA)

1. Um administrador do PostgreSQL cria o banco dedicado `openclaw_risk` (ADR-0008) e executa `scripts/provision/roles.sql` conectado a ele, com `-v dbname=openclaw_risk`:

   ```bash
   psql -v ON_ERROR_STOP=1 -v dbname=openclaw_risk -f scripts/provision/roles.sql <banco>
   ```

   O script é idempotente e **não contém senha**. Ele cria as roles `openclaw_risk_owner` (LOGIN, dona do schema) e `openclaw_risk_runtime` (NOLOGIN, grupo), revoga `CREATE` no schema `public` de `PUBLIC` e concede `CONNECT`.
2. O DBA cria os **logins** (a senha vem de secret, nunca de arquivo versionado nem de argumento de linha de comando):
   - login de **migração**: membro de `openclaw_risk_owner`;
   - login de **runtime**: `LOGIN INHERIT` e membro de `openclaw_risk_runtime`. Ele **não pode** ser membro de `openclaw_risk_owner`; a autoverificação de privilégios recusa isso (`MEMBER_OF_OWNER`).
3. `scripts/provision-db.sh` é o wrapper local: só aceita host local e banco `*_test`. Usar o script fora disso exige `RISK_PROVISION_ALLOW_NON_TEST=1` (e host ainda local). **Não o aponte para o PostgreSQL de produção** sem aprovação.

## 2. Secrets (requer aprovação)

Criados pelo operador, fora do repositório; nenhum valor entra em arquivo versionado.

| Secret (nome do exemplo) | Conteúdo | Quem monta |
|---|---|---|
| `risk_runtime_database_url` | URL de conexão do login de runtime | app (`RISK_DATABASE_URL_FILE`) |
| `risk_principals` | JSON de principals, só hashes SHA-256 | app (`RISK_PRINCIPALS_FILE`) |
| `risk_migration_database_url` | URL do login de migração | só o one-shot de migração (`RISK_MIGRATION_DATABASE_URL_FILE`) |

Formato do arquivo de principals: `{"version":1,"principals":[{"principalId":"...","kind":"AGENT|PAPER_EXECUTOR","tokenSha256":["<64 hex>", ...]}]}`. Veja `seguranca.md` para gerar tokens (`scripts/generate-principal-token.sh`) e rotacionar. Os arquivos devem ser legíveis pelo uid 1000.

## 3. Migração (one-shot, nunca no boot) (requer aprovação)

A aplicação **nunca** migra no boot e o servidor **recusa** subir se `RISK_MIGRATION_DATABASE_URL` ou `RISK_MIGRATION_DATABASE_URL_FILE` estiver no ambiente. A migração roda pela mesma imagem, em um contêiner separado, com a credencial de migração:

```bash
docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges \
  -v <dir-de-secrets>:/run/secrets:ro \
  -e RISK_ENVIRONMENT=PAPER \
  -e RISK_MIGRATION_DATABASE_URL_FILE=/run/secrets/risk_migration_database_url \
  -e RISK_DB_CONNECTION_TIMEOUT_MS=<a definir> -e RISK_DB_STATEMENT_TIMEOUT_MS=<a definir> -e RISK_DB_LOCK_TIMEOUT_MS=<a definir> \
  --entrypoint node openclaw-risk-engine:<versão> dist/interfaces/cli/main.js migrate
```

(No Swarm, o serviço `risk-engine-migrate` do exemplo faz o mesmo, sem restart, disparado manualmente pelo operador.) O comando também existe como `npm run migrate` / `scripts/migrate.sh`, que usa `RISK_MIGRATION_DATABASE_URL(_FILE)` do ambiente do operador.

**Prazos (credencial de migração):** `migrate`, `reconcile-after-restore` e `mark-restore-pending` exigem `RISK_ENVIRONMENT=PAPER` e os três `RISK_DB_CONNECTION_TIMEOUT_MS`, `RISK_DB_STATEMENT_TIMEOUT_MS` e `RISK_DB_LOCK_TIMEOUT_MS` (as mesmas variáveis do runtime; sem default, exit 2 se faltarem). Nada fica sem prazo: espera de conexão, cada comando (conexão + statement, do lado do cliente) e, no servidor, `statement_timeout`/`lock_timeout`. O advisory lock de sessão do `migrate` obedece ao `lock_timeout`: um migrador concorrente travado vira falha (exit 1), não espera infinita. **Pendência de decisão do usuário:** uma DDL legítima que demore mais que `RISK_DB_STATEMENT_TIMEOUT_MS` falha e dá rollback; se for necessário um prazo próprio para migrações, ele precisa ser definido pelo usuário (nenhum valor foi inventado).

Comportamento: aplica as migrações `migrations/NNNN_*.sql` pendentes em ordem, sob advisory lock (migradores concorrentes são serializados), cada uma em transação; compara o checksum SHA-256 das já aplicadas e **falha** se algum arquivo mudou. Saída: `aplicada <versão>` por migração ou `nenhuma migração pendente`. A migração `0003` aborta se a role `openclaw_risk_runtime` não existir ou se quem migra for ou herdar a role de runtime.

Migrações existentes: `0001_initial.sql` (tabelas, triggers de imutabilidade), `0002_access_grants.sql` (grants de acesso), `0003_runtime_privileges.sql` (privilégios mínimos e triggers de `TRUNCATE`), `0004_restore_reconciliation.sql` (estado operacional `risk_operational_state`, de linha única, com histórico append-only; o runtime só tem `SELECT`). A `0004` repete as pré-condições da `0003` (role de runtime existente; quem migra não herda a role de runtime).

## 4. Subir a aplicação (requer aprovação)

Ambiente da app (exemplo em `deploy/stack.example.yml`): contêiner com `user 1000:1000`, `read_only`, `cap_drop ALL`, `no-new-privileges`, **sem** `ports:` publicados, secrets montados em `/run/secrets`:

- `RISK_ENVIRONMENT=PAPER`
- `RISK_DATABASE_URL_FILE=/run/secrets/risk_runtime_database_url`
- `RISK_PRINCIPALS_FILE=/run/secrets/risk_principals`
- `RISK_HTTP_ENABLED=true`, `RISK_HTTP_BIND_SCOPE=private-network`, `RISK_HTTP_TRANSPORT=plaintext-encrypted-overlay`, `RISK_HTTP_HOST=0.0.0.0` (o stack de exemplo; para uso local, `loopback` com `RISK_HTTP_HOST=127.0.0.1`) e demais `RISK_*` da tabela abaixo (valores numéricos a definir pelo usuário).
- Nenhuma credencial de exchange/corretora, nenhuma `RISK_MIGRATION_*`.

No boot, em ordem: carrega a config (exit 2 se inválida), carrega o arquivo de principals (exit 2 se inválido), **autoverifica privilégios** do login de runtime (exit 1 se excessivo ou não verificável), só então faz `listen` (exit 1 se falhar). Ao ouvir, emite o log `http.listening`.

## 5. Verificar

1. Privilégios (com o ambiente de runtime, mesma imagem):

   ```bash
   docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges -v <dir-de-secrets>:/run/secrets:ro \
     -e RISK_ENVIRONMENT=PAPER -e RISK_DATABASE_URL_FILE=/run/secrets/risk_runtime_database_url \
     -e RISK_LOG_LEVEL=info -e RISK_HTTP_ENABLED=false -e RISK_CLOCK_SKEW_TOLERANCE_MS=<n> \
     -e RISK_DB_CONNECTION_TIMEOUT_MS=<n> -e RISK_DB_STATEMENT_TIMEOUT_MS=<n> -e RISK_DB_LOCK_TIMEOUT_MS=<n> \
     --entrypoint node openclaw-risk-engine:<versão> dist/interfaces/cli/main.js verify-runtime-privileges
   ```

   Exit 0 e `privilégios de runtime no mínimo`. Exit 1 lista códigos de categoria (ver `troubleshooting.md`).
2. Liveness: `GET /health/live` deve devolver 200 `{"status":"live"}` (não consulta o banco). A CLI `healthcheck` faz exatamente isso em `<RISK_HTTP_PORT>`, no host configurado (escopo `loopback`) ou em `127.0.0.1` do próprio contêiner (escopo `private-network`); é o `HEALTHCHECK` da imagem.
3. Readiness: `GET /health/ready` deve devolver 200 `{"status":"ready", ...}` com `database`, `schema`, `privileges`, `reconciliation` e `draining` todos `ok`. `reconciliation=fail` significa restauração pendente: ver [backup-restauracao.md](backup-restauracao.md). Detalhes em `troubleshooting.md`.
4. Como não há fontes configuradas, qualquer avaliação autenticada deve devolver `200` com `status=BLOCK`. Isso é o esperado hoje.

## Variáveis de ambiente `RISK_*`

Fonte: `src/infrastructure/config/loadConfig.ts` e `.env.example`. **Não há valores default** para limites numéricos; todos são obrigatórios e os valores são "a definir" pelo usuário. Variáveis ausentes ou inválidas = exit 2.

| Variável | Obrigatória | Descrição |
|---|---|---|
| `RISK_ENVIRONMENT` | sempre | Só `PAPER`; qualquer outro valor é rejeitado |
| `RISK_DATABASE_URL` ou `RISK_DATABASE_URL_FILE` | exatamente uma | URL do login de **runtime**; preferir `_FILE` (arquivo de uma linha; a quebra final é removida). Ambas ou nenhuma = erro |
| `RISK_LOG_LEVEL` | sempre | `info`, `warn` ou `error` (ver aviso sobre `metric.*` em `alarmes.md`) |
| `RISK_HTTP_ENABLED` | sempre | `true` ou `false`. O servidor só inicia com `true` |
| `RISK_CLOCK_SKEW_TOLERANCE_MS` | sempre | Inteiro não negativo (milissegundos); valor a definir |
| `RISK_DB_CONNECTION_TIMEOUT_MS` | sempre | Inteiro positivo; valor a definir |
| `RISK_DB_STATEMENT_TIMEOUT_MS` | sempre | Inteiro positivo; valor a definir |
| `RISK_DB_LOCK_TIMEOUT_MS` | sempre | Inteiro positivo; valor a definir |
| `RISK_HTTP_BIND_SCOPE` | opcional (sempre validada) | `loopback` (default se ausente) ou `private-network`. Vazio, outra caixa ou espaços são rejeitados |
| `RISK_HTTP_TRANSPORT` | obrigatória com `private-network`; proibida com `loopback` | Somente `plaintext-encrypted-overlay`: declara HTTP e Bearer em texto claro em overlay cifrada (ADR-0011). Não é verificada pelo processo |
| `RISK_HTTP_HOST` | se `RISK_HTTP_ENABLED=true` | Escopo `loopback`: **IP literal de loopback** (`127.0.0.0/8` ou `::1`). Escopo `private-network`: só `0.0.0.0` (grafia canônica; `::`, outras grafias, loopback, IPs privados e hostnames são rejeitados) |
| `RISK_HTTP_PORT` | se HTTP | Inteiro de 1 a 65535 |
| `RISK_HTTP_MAX_BODY_BYTES` | se HTTP | Inteiro positivo; valor a definir. Acima disso, 413 |
| `RISK_HTTP_REQUEST_TIMEOUT_MS` | se HTTP | Inteiro positivo; valor a definir |
| `RISK_HTTP_HEADERS_TIMEOUT_MS` | se HTTP | Inteiro positivo; não pode exceder `RISK_HTTP_REQUEST_TIMEOUT_MS` |
| `RISK_PRINCIPALS_FILE` | se HTTP | Caminho do JSON de principals (só hashes); lido **uma vez no boot** |
| `RISK_MIGRATION_DATABASE_URL` ou `RISK_MIGRATION_DATABASE_URL_FILE` | só nas CLIs do operador `migrate`, `reconcile-after-restore` e `mark-restore-pending` (que exigem também os três `RISK_DB_*_TIMEOUT_MS`) | Credencial de migração. **Nunca** no ambiente do servidor ou dos demais subcomandos: o `loadConfig` do runtime recusa |

Outras regras: nomes de variáveis com padrão de credencial de exchange/corretora (por exemplo `*API_KEY*`, `*SECRET*`, `*BROKER*`, `*EXCHANGE*`, `*_KEY`, `*_PASSWORD`, `*_TOKEN`) impedem o boot, tanto no servidor quanto na CLI. `NODE_ENV=production` é definido pela imagem. A CLI `healthcheck` e `expire-reservations`/`verify-runtime-privileges` carregam a mesma config de runtime; `healthcheck` exige `RISK_HTTP_ENABLED=true`.

`RISK_POLICY_ID` (SPEC §11.2) **não existe**: a política ativa é por conta, no banco.

## Exit codes

**Servidor** (`dist/interfaces/http/main.js`):

| Código | Significado |
|---|---|
| 0 | Encerramento ordenado após `SIGTERM`/`SIGINT` |
| 1 | Falha de execução: privilégio de runtime excessivo ou não verificável (inclui banco inacessível no boot), erro de `listen`, falha inesperada ao iniciar |
| 2 | Configuração inválida, `RISK_HTTP_ENABLED` diferente de `true`, ou arquivo de principals ausente/inválido |

**CLI** (`dist/interfaces/cli/main.js <subcomando>`):

| Código | Significado |
|---|---|
| 0 | Sucesso (`migrate` concluído, inclusive "nenhuma pendente"; `verify-runtime-privileges` no mínimo; `healthcheck` com `/health/live` 200; `expire-reservations` concluído; `reconcile-after-restore` concluído ou "nada a reconciliar"; `mark-restore-pending` concluído, inclusive "já marcado") |
| 1 | Falha de execução (banco indisponível, migração falhou, privilégio excessivo, healthcheck sem 200 ou timeout, varredura, reconciliação ou marcação falhou) |
| 2 | Uso ou configuração inválidos (subcomando desconhecido ou ausente, variável ausente/inválida, arquivo de segredo ilegível) |

As mensagens são fixas: sem stack, sem valores de variáveis, sem conteúdo de arquivos, sem mensagens do banco.

## `expire-reservations` (one-shot)

```bash
node dist/interfaces/cli/main.js expire-reservations   # com a config de runtime
```

Uma varredura: fecha como `EXPIRED` as reservas `ACTIVE` com `expires_at <= agora`, em transação, com bloqueio por conta e um evento de auditoria `RESERVATION_EXPIRED` (`details: {trigger: 'sweep'}`) por reserva. Imprime `reservas expiradas: <n>`. Antes de varrer, confere `restore_pending`: com a reconciliação pós-restauração pendente (ou o estado operacional ilegível/ausente) o comando **falha com exit 1**, mesmo que não haja reservas vencidas (nunca um "0 expiradas" com exit 0 mascarando o estado). Enquanto não roda, reservas vencidas **continuam ocupando capacidade** (conservador). **Ninguém agenda este comando**; quem agenda e com qual frequência está **a definir pelo usuário**. Um consume ou release de reserva vencida também a fecha como `EXPIRED` (consume/release respondem 409).

## Reconciliação pós-restauração (one-shot, operador)

```bash
# credencial de MIGRAÇÃO (RISK_MIGRATION_DATABASE_URL[_FILE]) + RISK_ENVIRONMENT=PAPER + os três RISK_DB_*_TIMEOUT_MS;
# nunca a credencial de runtime; serviço parado
node dist/interfaces/cli/main.js reconcile-after-restore
node dist/interfaces/cli/main.js mark-restore-pending
```

- `reconcile-after-restore`: em **uma transação**, se `restore_pending=true`: toma o lock por conta de todas as contas (mesma chave da aplicação, em ordem), expira **todas** as reservas `ACTIVE` (`status=EXPIRED`, `closed_at`, auditoria `RESERVATION_EXPIRED` com `details.trigger='post-restore-reconciliation'`), limpa `restore_pending` e grava `RESTORE_RECONCILED`. Idempotente: com `restore_pending=false` não toca em nada (reservas `ACTIVE` posteriores são legítimas) e sai com 0. Emite `metric.reservation_op op=EXPIRE outcome=OK` por reserva, só após o `COMMIT` (`UNAVAILABLE` se falhar). Exit 0 / 1 (falha; nada confirmado) / 2 (config).
- `mark-restore-pending`: marca `restore_pending=true` e grava `RESTORE_PENDING_MARKED`; o serviço fica not-ready e evaluate/consume/release respondem 503. Idempotente (já marcado: preserva o marcador original). Marque com o tráfego parado: transações já em voo não são interrompidas.

## Parada

`SIGTERM`/`SIGINT` ligam o draining: `/health/ready` passa a 503 (`draining: fail`) imediatamente, `/health/live` continua 200, o servidor fecha, o pool encerra e o processo sai com 0. O `stop_grace_period` do stack é **a definir** (sem número inventado).

## Checklist pré-deploy (rede transacional; nada disto foi executado)

1. Aprovação explícita do usuário para criar a rede, nomeá-la e anexar o OpenClaw (mudança em `openclaw-trading_openclaw`).
2. Rede overlay dedicada, cifrada, não attachable e interna. Confirmar com `docker network inspect <rede>`: `Driver=overlay`, opção `encrypted` presente, `Attachable=false`, `Internal=true`.
3. Somente o risk engine e o consumidor autorizado anexados: `docker network inspect <rede>` (lista de contêineres/serviços) e `docker service inspect <serviço>` (redes, ausência de `ports:` publicados em `Endpoint.Ports`).
4. Risco P1: listar as redes do serviço `risk-engine`. Se houver segunda rede (acesso ao Postgres), decidir e registrar: aceitar, isolar o acesso ao banco ou bind por interface (novo ADR).
5. Topologia de um único nó (`docker node ls`); com segundo nó, rever o ADR-0011 antes.
6. `sslmode` do Postgres confirmado conforme a instância compartilhada; sem TLS disponível, a decisão volta ao usuário.
7. `risk-engine-migrate` fora da rede transacional; nenhuma `RISK_MIGRATION_*` no serviço do runtime.
8. Após subir: `http.listening` com `bindScope=private-network` e `transport=plaintext-encrypted-overlay`; `/health/live` pelo consumidor; sem token, 401.

## Backup (ADR-0012)

**Nada desta seção foi executado.** Cada passo de produção exige aprovação explícita do usuário. Detalhes em [backup-restauracao.md](backup-restauracao.md#produção-adr-0012); exemplos (todos "a definir") em `deploy/backup/`.

1. **Role e grants** (DBA, com aprovação): `scripts/provision/roles.sql` (cria `openclaw_risk_backup`, idempotente) e `scripts/provision/backup-grants.sql`. Depois, o login de backup (snippet em backup-restauracao.md), membro só de `openclaw_risk_backup`.
2. **Checklist pós-`migrate`**: reaplicar `backup-grants.sql` a cada migração (tabelas e sequências novas não herdam o `SELECT`).
3. **Imagem**: `docker pull postgres:14-bookworm` (digest fixado no `Dockerfile.backup`) e `npm run image:build:backup`. Cadência de reconstrução: a definir (U16).
4. **Secrets** (0400, diretório 0700, uid do cron): `pgpass`, `age_recipients` (só chave pública; a privada fica **fora** da VPS), `rclone.conf`.
5. **Bucket**: criado e configurado pelo operador (o job não cria bucket). Retenção de 7 dias por ciclo de vida do provedor; credencial de envio sem listar/apagar quando possível.
6. **Config e cron**: `backup.env` a partir de `deploy/backup/backup.env.example`; crontab a partir de `crontab.example` (horário a definir).
7. **Aceite (SPEC §7.3)**: primeiro backup real conferido (`.age`, `.sha256`, objeto no bucket com o mesmo tamanho) e **primeiro teste de recuperação executado** antes do aceite.

Não altera `.env.example` nem `deploy/stack.example.yml` (o job não é serviço Swarm).

## Pendências a definir

Decisões do usuário necessárias antes de qualquer implantação: aprovação para cada ação de produção listada no topo; nome da rede transacional e `sslmode` (ADR-0011); P1 (segunda rede do engine); D-10 (itens a definir do backup, ADR-0012: provedor/bucket/região/prefixo, horário/fuso/timeouts do job, destino do alerta, RTO, diretório/uid/disco, custódia das chaves `age`, login de backup, cadência de rebuild da imagem); valores de todas as variáveis numéricas `RISK_*`; `stop_grace_period`; healthcheck `interval`/`timeout`/`retries`/`start_period`; réplicas, `restart_policy`, `update_config` e `rollback_config`; agendador e frequência de `expire-reservations`; quem aprova e executa uma restauração e a reconciliação em produção; retenção de logs, decisões e auditoria; destino e limiares de alarme; D-08 (como conceder grants); IDs reais dos sete agentes.

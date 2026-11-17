# Implementação do ADR-0012: job de backup de produção

Status: implementada, revisada e **aprovada pelo usuário em 2026-11-16**. Verificação final: typecheck e lint ok, `test:unit` 936/936, `BackupScriptGuards` 52/52, `npm run test:backup` 159/159 (sem skip nem `it.fails`); revisor sem achado acima de INFO. Nada executa em produção: role, secret, cron, diretório na VPS e bucket dependem de aprovação no deploy.

## Decisões do usuário (2026-11-16)
- **U1:** cliente S3 `rclone`; imagem própria derivada de `postgres:14` Debian por digest; `age` e `rclone` de pacotes Debian com versão fixada. Autorizado baixar `postgres:14` Debian e um servidor S3-compatível local de teste (MinIO ou alternativa), ambos por digest.
- **U2:** grants da role de backup por SQL de provisionamento (opção A), reaplicado após cada `migrate`; sem migração 0005.
- **Credencial:** arquivo `pgpass` (0400), nunca URL/argv/env com senha.
- **Aceitos:** imagem derivada de `postgres:14` atende ao ADR (U13); códigos de saída 0/2/3/4/5/6 (U14); retenção local = timestamp do nome anterior a agora − 7×24 h, aplicada só após backup local OK, mesmo se o upload falhar (U11); o job nunca apaga no bucket — retenção lá por ciclo de vida do provedor (U15); teste mensal na estação do operador, chave privada nunca na VPS (U10).
- **Para o deploy:** provedor/bucket/região/prefixo e permissões (GetObject/HEAD, object lock, versionamento, ciclo de vida) (U4); rede até o Postgres e `sslmode` (U3); horário/fuso e timeouts do job (U5); alerta (U6); RTO (U7); diretório, uid e monitoramento de disco (U8); recipients/passphrase/rotação/custódia das chaves `age` e aceite do risco de perda (U9); nome do login, `pg_hba`, `CONNECTION LIMIT`, `default_transaction_read_only` (U12); cadência de rebuild da imagem (U16).

## Achados do arquiteto que moldam o plano
1. O dump leva GRANTs para a role de backup; `roles.sql` precisa criar `openclaw_risk_backup` (NOLOGIN) com CONNECT, senão a restauração falha.
2. `ALTER DEFAULT PRIVILEGES` não serve (migrate não faz `SET ROLE`); grants explícitos.
3. `backup-local.sh`/`restore-local.sh` expõem a senha no `ps` do host (BAIXO, só `*_test`); o script de produção não pode repetir isso. Correção dos locais fora do escopo.
4. `.dockerignore` exclui `scripts/`; a imagem de backup usa `Dockerfile.backup.dockerignore`.
5. `pipefail` não existe no dash: scripts com pipe usam `bash` com `set -euo pipefail` e conferem `PIPESTATUS`.
6. Disponibilidade da imagem oficial do MinIO a confirmar; alternativas versitygw, s3mock, SeaweedFS — sempre por digest.

## Contratos
### Imagem `openclaw-risk-backup:<versão>` (`Dockerfile.backup`)
Base `postgres:14-<debian>@sha256:…`; `apt-get install --no-install-recommends age=<v> rclone=<v>`; remove `/var/lib/apt/lists`; labels OCI com versões; sem ARG/ENV de credencial, sem EXPOSE, sem curl/wget; scripts `scripts/backup/*.sh` embutidos. Build local `--pull=false` via `scripts/build-backup-image.sh` / `npm run image:build:backup`.

### `scripts/backup-prod.sh` (host, cron)
Config não secreta em arquivo (`$1`), todas obrigatórias, sem default: `RISK_BACKUP_EXPECTED_DB` (`[A-Za-z0-9_]+`), `RISK_BACKUP_DIR` e `RISK_BACKUP_SECRETS_DIR` (absolutos, existentes, não symlink, dono = uid atual, 0700; secrets 0400), `RISK_BACKUP_S3_BUCKET`, `RISK_BACKUP_S3_PREFIX` (charset estrito, sem `..`), `RISK_BACKUP_IMAGE` (deve existir), `RISK_BACKUP_DOCKER_NETWORK`.
Secrets: `pgpass` (uma linha, sem `*`/`\`, banco = esperado), `age_recipients` (só `age1…`), `rclone.conf` (remote de nome fixo).
Fluxo: `umask 077` → `flock -n` em `$RISK_BACKUP_DIR/.lock` → `docker run --rm` com nome fixo `openclaw-risk-backup-<db>`, label `com.openclaw-risk-engine.backup=<db>`, `--user`, `--read-only` sem tmpfs, `--cap-drop ALL`, `no-new-privileges`, `-v dir:/out`, `-v secrets:/run/secrets:ro`, `--network <cfg>`, entrypoint `backup-job.sh`; só nomes/caminhos não secretos por `-e`. Trap remove só esse contêiner.

### `scripts/backup/backup-job.sh` (na imagem, bash `set -euo pipefail`, sem `set -x`)
1. Valida secrets e config.
2. `psql -X -At` antes de qualquer escrita: recusa se `current_database()` ≠ esperado, se o login for superuser ou membro de owner/runtime, ou tiver INSERT/UPDATE/DELETE/TRUNCATE em `public`.
3. Nome `<db>-<YYYYMMDDTHHMMSSZ>.dump.age`; tmp `.<nome>.partial.<pid>` no mesmo diretório.
4. `pg_dump -Fc --no-owner -h -p -U -d | age -R /run/secrets/age_recipients -o <tmp>` (mantém privilégios); exige `PIPESTATUS` zerado, tamanho > 0 e cabeçalho `age-encryption.org/v1`.
5. `.sha256` via tmp; `sync`.
6. Publicação sem sobrescrever: `ln tmp final` + `rm tmp`; idem `.sha256`; `sync` do diretório; trap remove `.partial` da execução.
7. Retenção local após sucesso local: `find /out -maxdepth 1 -type f -name '<db>-????????T??????Z.dump.age'` + regex estrita; apaga par `.age`+`.sha256` com timestamp < agora − 7×24 h; nunca o recém-criado, nunca `rm -r`, nunca fora de `/out`; `.partial` órfãos só aviso. Constante 7 fixa (ADR-0012).
8. Upload `.age` e `.sha256`; sem criar bucket, sem list, sem delete, sem sobrescrever (`--s3-no-check-bucket`, `--no-traverse`, flags validadas no S3 local); HEAD de tamanho (e hash se o provedor permitir).
9. Logs: uma linha JSON fixa por etapa (`event`, `file`, `bytes`, `exitCode`); nunca env/URL/secret/stderr bruto.

Códigos: 0 OK; 2 config/trava recusada antes de conectar; 3 lock ocupado; 4 falha de dump/cifragem, sem arquivo final; 5 cópia local OK e upload/verificação falhou; 6 falha na retenção com backup OK.

### Restauração cifrada (`scripts/restore-encrypted-local.sh`, só `*_test`)
`.sha256` obrigatório e conferido antes de decifrar; `RISK_RESTORE_AGE_IDENTITY_FILE` 0400/0600 fornecido pelo operador, nunca copiado; `docker run --rm -i --network none --read-only --cap-drop ALL … age -d -i … | RISK_RESTORE_URL=… sh scripts/restore-local.sh -`. Dump em claro só no pipe. `restore-local.sh` ganha modo `-` (stdin) mantendo uma única linha `pg_restore --exit-on-error` e nada entre ela e a marcação.

### Role de backup (NÃO executar em produção)
`roles.sql` cria `openclaw_risk_backup` (NOLOGIN, NOSUPERUSER…) + CONNECT, idempotente. `scripts/provision/backup-grants.sql` idempotente: USAGE em `public`, SELECT em todas as tabelas e sequências; recusa se a role não existir; reaplicado após cada `migrate` (checklist). Login só como snippet na doc, nunca membro de owner/runtime; recomendado `default_transaction_read_only = on`.

## Testes
`scripts/test-backup.sh` + `npm run test:backup` (separado do `test:e2e`): postgres:14 e S3 local por digest com label genérica + `backup-test-run=<pid>`; portas `RISK_BACKUP_TEST_DB_PORT`/`RISK_BACKUP_TEST_S3_PORT` com checagem fail-closed; par `age` de teste gerado em tmp 0700; teardown só pela label.
- T1 unit estático (`tests/unit/architecture/backupScripts.test.ts`); T2 integração com stubs (`tests/integration/BackupScriptGuards.test.ts`); T3 backup real; T4 falhas (banco errado, login com escrita, pg_dump/age falham, S3 parado, nome pré-existente); T5 retenção; T6 segredos fora de `ps`/`docker inspect`/logs; T7 restauração cifrada + reconcile + verify + ready, e recusas; T8 opcional sem list/delete.

## Documentação
`docs/operacao/{backup-restauracao,runbook,alarmes,deploy,seguranca}.md`; exemplos `deploy/backup/{backup.env.example,crontab.example,rclone.conf.example}` com NÃO APLICADO e "a definir". Não alterar `.env.example` nem `stack.example.yml`.

## Tarefas
B1 `roles.sql` + `backup-grants.sql` → B2 `Dockerfile.backup`, `.dockerignore` próprio, `build-backup-image.sh`, `package.json` → B3 `backup-job.sh` → B4 `backup-prod.sh` → B5 `restore-local.sh` (modo `-`) + `restore-encrypted-local.sh` → B6 `test-backup.sh` → T1/T2 → T3–T8 → B7 docs/exemplos → revisor.

## Correções pós-teste (2026-11-16)
Três lacunas registradas pelo tester (`it.fails`/`skipIf`) corrigidas em `scripts/` (sem tocar em `tests/`).

1. **Trava de privilégios** (`backup-job.sh`, etapa 2): além de INSERT/UPDATE/DELETE/TRUNCATE de tabela, recusa (`guard_target_or_privileges_refused`, exit 2, antes de qualquer escrita) privilégio de **coluna** INSERT/UPDATE (`has_any_column_privilege`; vale também para views/matviews/foreign tables), **UPDATE em sequência** do `public` (`setval` altera estado; SELECT em sequência não é UPDATE e segue aceito) e **CREATE no schema `public`**. CREATE recusa-se porque permitiria criar objetos na base; é coerente com `roles.sql`, que já faz `REVOKE CREATE ON SCHEMA public FROM PUBLIC` (o login legítimo não o tem). TEMP não é recusado: `roles.sql` revoga TEMP de PUBLIC e tabela temporária não persiste dados (`default_transaction_read_only` NÃO é argumento: o próprio login pode desligá-lo na sessão). Privilégio via PUBLIC continua enxergado (funções `has_*_privilege` consideram PUBLIC e herança).
2. **Sobrescrita remota**: `--immutable` não impede sobrescrita no rclone 1.60.1. Antes de enviar cada arquivo o job faz um HEAD do objeto exato com `rclone copyto --dry-run --ignore-existing --no-traverse --error-on-no-transfer` e decide **só pelo código de saída**: 0 = não existe; 9 = existe (`upload_target_exists`, não envia, exit 5, cópia local mantida); qualquer outro (HEAD negado, erro, timeout) = `upload_head_failed`, exit 5 (fail-closed). `lsjson <objeto>` foi descartado: com credencial sem ListBucket o 404 vira listagem negada (rc 1, indistinguível de erro). Confirmado com a política PutObject+GetObject (versitygw): só HEAD e PUT, nenhuma listagem. `--ignore-existing` substitui `--immutable` como segunda barreira; a verificação de tamanho pós-upload continua (`lsjson` do objeto, HEAD). **Atenção no deploy (U4):** na AWS S3 um HEAD de chave inexistente sem `s3:ListBucket` devolve 403, não 404; nesse provedor o job sairia sempre 5 (`upload_head_failed`). Confirmar o comportamento do provedor escolhido antes de aceitar a credencial só PutObject+GetObject.
3. **Timeouts do rclone**: novas variáveis obrigatórias, sem default (valores de produção: decisão U5): `RISK_BACKUP_RCLONE_CONTIMEOUT`, `RISK_BACKUP_RCLONE_TIMEOUT` (`^[1-9][0-9]*(ms|s|m)$`), `RISK_BACKUP_RCLONE_RETRIES`, `RISK_BACKUP_RCLONE_LOW_LEVEL_RETRIES` (`^[1-9][0-9]*$`; 0 recusado para que o número de tentativas seja uma escolha explícita e positiva). Validadas em `backup-prod.sh` (exit 2 antes de `docker run`; chave desconhecida/ausente recusada), repassadas por `-e`, revalidadas em `backup-job.sh` (`config_invalid_rclone_*`, exit 2) e aplicadas em todas as chamadas rclone (`--contimeout --timeout --retries --low-level-retries`). `scripts/test-backup.sh` usa valores de TESTE (3s/10s/1/1) e exporta `RISK_BACKUP_TEST_RCLONE_*`. `deploy/backup/backup.env.example` ganhou as quatro chaves com `<a definir>`.

Docs atualizados: `docs/operacao/backup-restauracao.md` (etapa de upload e trava) e `docs/operacao/alarmes.md` (eventos do código 5).

### Ajustes após revisão (2026-11-16)
- Trava ampliada (M1-M3, B1): atributos CREATEROLE/CREATEDB/REPLICATION/BYPASSRLS recusados; membership por allowlist (só `openclaw_risk_backup`; `pg_has_role MEMBER` é transitivo e ignora INHERIT, cobrindo pg_write_all_data etc.); dono do banco, de schema ou de objeto recusado; escrita/UPDATE-USAGE de sequência/CREATE em qualquer schema não-sistema e CREATE no banco. A justificativa de TEMP é o `REVOKE` de `roles.sql` e a não persistência (não `default_transaction_read_only`).
- Envio real com `--error-on-no-transfer`: rc 9 vira `upload_target_exists` (R1). Imutabilidade real só por versionamento/Object Lock (U4/U15).
- Limite técnico de dígitos nas variáveis rclone: duração `^[1-9][0-9]{0,5}(ms|s|m)$`, contagens `^[1-9][0-9]{0,3}$` (C1; não é valor operacional).
- Docs corrigidos (D1-D3).
- Segunda passada (S1-S3): a trava também recusa dono de função/procedimento (`pg_proc.proowner`) e de tipo (`pg_type.typowner`) fora dos schemas de sistema (tipos de linha de tabela têm o dono da tabela, sem falso positivo no login legítimo, que não possui nada). Doc de recusas sem a frase velha; `alarmes.md` explica que `upload_target_exists` pode ser retry do próprio envio.

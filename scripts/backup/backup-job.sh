#!/bin/bash
# Job de backup de produção (ADR-0012). Roda DENTRO da imagem openclaw-risk-backup (postgres:14 Debian + age + rclone).
# Não executar no host. Disparado por scripts/backup-prod.sh (docker run --rm). Nenhum dump em claro vai a disco:
#   pg_dump -Fc | age -R recipients -o <arquivo parcial>   (a única gravação é o texto cifrado)
#
# Configuração NÃO secreta por variáveis de ambiente (todas obrigatórias, sem default):
#   RISK_BACKUP_EXPECTED_DB   banco esperado ([A-Za-z0-9_]+); deve coincidir com o do pgpass e com current_database()
#   RISK_BACKUP_S3_BUCKET     bucket S3-compatível (a definir no deploy)
#   RISK_BACKUP_S3_PREFIX     prefixo no bucket (a definir no deploy)
# Segredos SÓ por arquivos montados somente leitura em /run/secrets (nunca por argv/env/log):
#   pgpass          uma linha host:porta:banco:login:senha (sem '*' nem '\'); host/porta/login são lidos daqui, a senha não é lida pelo job
#   age_recipients  um ou mais recipients públicos `age1...` (um por linha, sem comentários)
#   rclone.conf     contém a seção [risk-backup] (remote S3 de nome fixo)
#   RISK_BACKUP_RCLONE_CONTIMEOUT / RISK_BACKUP_RCLONE_TIMEOUT   duração rclone (^[1-9][0-9]{0,5}(ms|s|m)$); valores de produção a definir (U5)
#   RISK_BACKUP_RCLONE_RETRIES / RISK_BACKUP_RCLONE_LOW_LEVEL_RETRIES   inteiros >= 1 (^[1-9][0-9]{0,3}$; 0 recusado: --retries 0 não é "sem retry" em todas as versões e a escolha deve ser explícita); a definir (U5)
# Diretório de saída: /out (volume do host, 0700). Ferramentas são chamadas pelo nome simples (PATH): testes podem
# injetar stubs de pg_dump/age/rclone/date por PATH.
#
# Códigos de saída: 0 OK | 2 configuração/trava recusada antes de conectar | 4 falha de dump/cifragem/publicação local (sem arquivo final)
#   5 cópia local OK, mas upload/verificação falhou | 6 retenção local falhou com backup OK (3 = lock ocupado, emitido por backup-prod.sh).
# Logs: uma linha JSON fixa por etapa (event, file, bytes, exitCode); nunca env, URL, segredo nem stderr bruto das ferramentas.
set -euo pipefail
umask 077

readonly OUT_DIR=/out
readonly SECRETS=/run/secrets
readonly REMOTE=risk-backup
readonly RETENTION_DAYS=7 # constante do ADR-0012; não configurável

log() { # evento arquivo bytes exitCode (valores gerados/validados por este script)
  printf '{"event":"%s","file":"%s","bytes":%s,"exitCode":%s}\n' "$1" "${2:-}" "${3:-0}" "${4:-0}"
}
refuse() { log "$1" "" 0 2; exit 2; }

PARTIAL_FILES=()
cleanup() {
  local f
  for f in "${PARTIAL_FILES[@]}"; do rm -f -- "$f" 2>/dev/null || true; done
}
trap cleanup EXIT

# ---- 1. validação (nada é conectado nem gravado antes de passar) ----
DB=${RISK_BACKUP_EXPECTED_DB:-}
BUCKET=${RISK_BACKUP_S3_BUCKET:-}
PREFIX=${RISK_BACKUP_S3_PREFIX:-}
[[ "$DB" =~ ^[A-Za-z0-9_]+$ ]] || refuse config_invalid_db
[[ "$BUCKET" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ && "$BUCKET" != *..* ]] || refuse config_invalid_bucket
[[ "$PREFIX" =~ ^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$ && "$PREFIX" != *..* ]] || refuse config_invalid_prefix
[[ -d "$OUT_DIR" && ! -L "$OUT_DIR" && -w "$OUT_DIR" ]] || refuse config_invalid_out_dir
CONTIMEOUT=${RISK_BACKUP_RCLONE_CONTIMEOUT:-}
RCTIMEOUT=${RISK_BACKUP_RCLONE_TIMEOUT:-}
RETRIES=${RISK_BACKUP_RCLONE_RETRIES:-}
LL_RETRIES=${RISK_BACKUP_RCLONE_LOW_LEVEL_RETRIES:-}
[[ "$CONTIMEOUT" =~ ^[1-9][0-9]{0,5}(ms|s|m)$ ]] || refuse config_invalid_rclone_contimeout
[[ "$RCTIMEOUT" =~ ^[1-9][0-9]{0,5}(ms|s|m)$ ]] || refuse config_invalid_rclone_timeout
[[ "$RETRIES" =~ ^[1-9][0-9]{0,3}$ ]] || refuse config_invalid_rclone_retries
[[ "$LL_RETRIES" =~ ^[1-9][0-9]{0,3}$ ]] || refuse config_invalid_rclone_low_level_retries
for f in pgpass age_recipients rclone.conf; do
  [[ -f "$SECRETS/$f" && ! -L "$SECRETS/$f" && -r "$SECRETS/$f" ]] || refuse config_missing_secret
done
export PGPASSFILE="$SECRETS/pgpass"
# pgpass: exatamente uma linha, sem '*' nem '\'; lê só host/porta/banco/login (nunca a senha).
[[ $(wc -l <"$SECRETS/pgpass") -eq 1 ]] || refuse config_invalid_pgpass
IFS=: read -r PGH PGP PGD PGU _ <"$SECRETS/pgpass" || refuse config_invalid_pgpass
if grep -q '[*\\]' "$SECRETS/pgpass"; then refuse config_invalid_pgpass; fi
[[ -n "$PGH" && "$PGH" != *[[:space:]]* && "$PGP" =~ ^[0-9]+$ && "$PGD" == "$DB" && "$PGU" =~ ^[A-Za-z0-9_.-]+$ ]] || refuse config_invalid_pgpass
# age_recipients: só chaves públicas age1..., ao menos uma.
n_rcp=0
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ "$line" =~ ^age1[a-z0-9]+$ ]] || refuse config_invalid_recipients
  n_rcp=$((n_rcp + 1))
done <"$SECRETS/age_recipients"
[[ $n_rcp -ge 1 ]] || refuse config_invalid_recipients
grep -qxF "[$REMOTE]" "$SECRETS/rclone.conf" || refuse config_invalid_rclone
command -v pg_dump >/dev/null && command -v psql >/dev/null && command -v age >/dev/null && command -v rclone >/dev/null || refuse config_missing_tool

# ---- 2. trava de alvo e de privilégios, ANTES de qualquer escrita ----
# Colunas: banco | atributo de role perigoso | membro de QUALQUER role fora da allowlist (pg_has_role MEMBER ignora INHERIT, então pega
# também NOINHERIT + SET ROLE) | privilégio de escrita/CREATE em qualquer schema não-sistema (privilégio efetivo, inclui PUBLIC e herança).
GUARD_SQL="select current_database(),
  coalesce((select rolsuper or rolcreaterole or rolcreatedb or rolreplication or rolbypassrls from pg_roles where rolname = current_user), true),
  exists (select 1 from pg_roles r where r.rolname not in (current_user, 'openclaw_risk_backup') and pg_has_role(current_user, r.oid, 'member')),
  (exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname not in ('pg_catalog','information_schema') and n.nspname !~ '^pg_(toast|temp_)' and c.relkind in ('r','p','v','m','f')
              and (has_table_privilege(current_user, c.oid, 'INSERT') or has_table_privilege(current_user, c.oid, 'UPDATE')
                or has_table_privilege(current_user, c.oid, 'DELETE') or has_table_privilege(current_user, c.oid, 'TRUNCATE')
                or has_any_column_privilege(current_user, c.oid, 'INSERT') or has_any_column_privilege(current_user, c.oid, 'UPDATE')))
   or exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname not in ('pg_catalog','information_schema') and n.nspname !~ '^pg_(toast|temp_)' and c.relkind = 'S'
              and (has_sequence_privilege(current_user, c.oid, 'UPDATE') or has_sequence_privilege(current_user, c.oid, 'USAGE')))
   or exists (select 1 from pg_namespace n
            where n.nspname not in ('pg_catalog','information_schema') and n.nspname !~ '^pg_(toast|temp_)' and has_schema_privilege(current_user, n.oid, 'CREATE'))
   or has_database_privilege(current_user, current_database(), 'CREATE')
   or exists (select 1 from pg_database d where d.datname = current_database() and pg_has_role(current_user, d.datdba, 'member'))
   or exists (select 1 from pg_namespace n
            where n.nspname not in ('pg_catalog','information_schema') and n.nspname !~ '^pg_(toast|temp_)' and pg_has_role(current_user, n.nspowner, 'member'))
   or exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname not in ('pg_catalog','information_schema') and n.nspname !~ '^pg_(toast|temp_)' and pg_has_role(current_user, c.relowner, 'member'))
   or exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname not in ('pg_catalog','information_schema') and n.nspname !~ '^pg_(toast|temp_)' and pg_has_role(current_user, p.proowner, 'member'))
   or exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
            where n.nspname not in ('pg_catalog','information_schema') and n.nspname !~ '^pg_(toast|temp_)' and pg_has_role(current_user, t.typowner, 'member')))"
set +e
guard=$(psql -X -w -At -F '|' -v ON_ERROR_STOP=1 -h "$PGH" -p "$PGP" -U "$PGU" -d "$DB" -c "$GUARD_SQL" 2>/dev/null)
guard_rc=$?
set -e
[[ $guard_rc -eq 0 ]] || refuse guard_connect_failed
[[ "$guard" == "$DB|f|f|f" ]] || refuse guard_target_or_privileges_refused
log guard_ok "" 0 0

# ---- 3-6. dump cifrado, publicação sem sobrescrever ----
TS=$(date -u +%Y%m%dT%H%M%SZ)
[[ "$TS" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || refuse config_invalid_clock
NAME="$DB-$TS.dump.age"
FINAL="$OUT_DIR/$NAME"
FINAL_SHA="$FINAL.sha256"
if [[ -e "$FINAL" || -e "$FINAL_SHA" ]]; then log final_exists "$NAME" 0 4; exit 4; fi
TMP="$OUT_DIR/.$NAME.partial.$$"
TMP_SHA="$OUT_DIR/.$NAME.sha256.partial.$$"
PARTIAL_FILES+=("$TMP" "$TMP_SHA")

set +e
pg_dump --format=custom --no-owner --no-password -h "$PGH" -p "$PGP" -U "$PGU" -d "$DB" 2>/dev/null \
  | age -R "$SECRETS/age_recipients" -o "$TMP" 2>/dev/null
rc=("${PIPESTATUS[@]}")
set -e
if [[ "${rc[0]}" -ne 0 || "${rc[1]}" -ne 0 ]]; then log dump_failed "$NAME" 0 4; exit 4; fi
size=$(stat -c %s "$TMP" 2>/dev/null || echo 0)
if [[ "$size" -le 0 ]] || [[ "$(head -c 21 "$TMP" 2>/dev/null)" != "age-encryption.org/v1" ]]; then log dump_invalid_output "$NAME" "$size" 4; exit 4; fi

hash=$(sha256sum <"$TMP") || { log checksum_failed "$NAME" 0 4; exit 4; }
printf '%s  %s\n' "${hash%% *}" "$NAME" >"$TMP_SHA"
sync "$TMP" "$TMP_SHA"
# Publica o .sha256 primeiro e o .age por último (o .age final sinaliza backup completo). ln não sobrescreve.
if ! ln "$TMP_SHA" "$FINAL_SHA" 2>/dev/null; then log publish_failed "$NAME" 0 4; exit 4; fi
if ! ln "$TMP" "$FINAL" 2>/dev/null; then rm -f -- "$FINAL_SHA"; log publish_failed "$NAME" 0 4; exit 4; fi
rm -f -- "$TMP" "$TMP_SHA"
sync -f "$OUT_DIR" 2>/dev/null || sync
log local_backup_ok "$NAME" "$size" 0

# ---- 7. retenção local (só após sucesso local; nunca o arquivo recém-criado; nunca fora de /out) ----
retention_rc=0
now_epoch=$(date -u +%s)
cutoff=$((now_epoch - RETENTION_DAYS * 86400))
while IFS= read -r -d '' path; do
  base=${path##*/}
  [[ "$base" != "$NAME" ]] || continue
  if [[ "$base" =~ ^$DB-([0-9]{4})([0-9]{2})([0-9]{2})T([0-9]{2})([0-9]{2})([0-9]{2})Z\.dump\.age$ ]]; then
    f_epoch=$(date -u -d "${BASH_REMATCH[1]}-${BASH_REMATCH[2]}-${BASH_REMATCH[3]} ${BASH_REMATCH[4]}:${BASH_REMATCH[5]}:${BASH_REMATCH[6]}" +%s 2>/dev/null) || { retention_rc=1; continue; }
    if [[ "$f_epoch" -lt "$cutoff" ]]; then
      if rm -f -- "$OUT_DIR/$base" "$OUT_DIR/$base.sha256"; then log retention_removed "$base" 0 0; else log retention_failed "$base" 0 6; retention_rc=1; fi
    fi
  fi
done < <(find "$OUT_DIR" -maxdepth 1 -type f -name "$DB-????????T??????Z.dump.age" -print0)
orphans=$(find "$OUT_DIR" -maxdepth 1 -type f -name '.*.partial.*' 2>/dev/null | wc -l)
[[ "$orphans" -eq 0 ]] || log partial_orphans_found "" "$orphans" 0

# ---- 8. upload (sem criar bucket, sem listar, sem apagar, sem sobrescrever) e verificação por HEAD ----
# `--immutable` não impede sobrescrita no rclone 1.60.1: a barreira real é um HEAD do objeto exato ANTES de enviar, feito por
# `copyto --dry-run --ignore-existing --no-traverse --error-on-no-transfer` (NewObject = HEAD; não lista o prefixo e nada é enviado).
# Decide só pelo CÓDIGO DE SAÍDA (nenhuma saída do rclone é lida): 0 = HEAD 404, enviaria (não existe); 9 = nada a transferir,
# o objeto existe; qualquer outro (HEAD negado, erro, timeout) = indeterminado, fail-closed.
# `lsjson <objeto>` NÃO serve para inexistência: com credencial sem ListBucket o 404 vira uma listagem negada (rc 1, igual a erro).
# `--ignore-existing` no envio real é a segunda barreira.
RC_BASE=(--config "$SECRETS/rclone.conf" --s3-no-check-bucket --no-traverse --ignore-existing --log-level ERROR
  --contimeout "$CONTIMEOUT" --timeout "$RCTIMEOUT" --retries "$RETRIES" --low-level-retries "$LL_RETRIES")
RC_FLAGS=("${RC_BASE[@]}")
# Retorno: 0 = não existe, 10 = existe, 1 = erro/indeterminado (fail-closed).
remote_probe() {
  local rc=0
  rclone copyto --dry-run --error-on-no-transfer "${RC_BASE[@]}" "$1" "$2" >/dev/null 2>&1 || rc=$?
  case "$rc" in 0) return 0 ;; 9) return 10 ;; *) return 1 ;; esac
}
# Tamanho remoto de um objeto que existe (HEAD; só GetObject).
remote_size() {
  rclone lsjson "${RC_FLAGS[@]}" --no-modtime --no-mimetype --files-only "$1" 2>/dev/null | sed -n 's/.*"Size":\([0-9]*\).*/\1/p' | head -n 1 || true
}
upload_rc=0
for f in "$NAME" "$NAME.sha256"; do
  dest="$REMOTE:$BUCKET/$PREFIX/$f"
  probe_rc=0
  remote_probe "$OUT_DIR/$f" "$dest" || probe_rc=$?
  if [[ $probe_rc -eq 10 ]]; then log upload_target_exists "$f" 0 5; upload_rc=1; continue; fi
  if [[ $probe_rc -ne 0 ]]; then log upload_head_failed "$f" 0 5; upload_rc=1; continue; fi
  # --error-on-no-transfer: rc 9 = o objeto surgiu entre o probe e o envio (--ignore-existing pulou); nunca vira upload_ok.
  put_rc=0
  rclone copyto --error-on-no-transfer "${RC_FLAGS[@]}" "$OUT_DIR/$f" "$dest" >/dev/null 2>&1 || put_rc=$?
  if [[ $put_rc -eq 9 ]]; then log upload_target_exists "$f" 0 5; upload_rc=1; continue; fi
  if [[ $put_rc -ne 0 ]]; then log upload_failed "$f" 0 5; upload_rc=1; continue; fi
  local_size=$(stat -c %s "$OUT_DIR/$f")
  if [[ "$(remote_size "$dest")" != "$local_size" ]]; then log upload_verify_failed "$f" "$local_size" 5; upload_rc=1; continue; fi
  log upload_ok "$f" "$local_size" 0
done
if [[ $upload_rc -ne 0 ]]; then exit 5; fi
if [[ $retention_rc -ne 0 ]]; then exit 6; fi
log backup_complete "$NAME" "$size" 0

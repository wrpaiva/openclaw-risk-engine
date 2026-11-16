#!/bin/sh
# Backup (pg_dump 14, formato custom) de um banco LOCAL *_test, executado DENTRO de um contêiner postgres:14 descartável.
#   RISK_BACKUP_URL=postgres://user:senha@127.0.0.1:PORTA/<banco>_test sh scripts/backup-local.sh <arquivo.dump>
# A URL é passada ao contêiner por variável de ambiente (nunca em argumento nem impressa). Rede: host, só para alcançar
# o banco local. Recursos com a label com.openclaw-risk-engine.test=1 e uma label por execução (backup-run=<pid>); o trap remove só o contêiner desta execução.
set -eu
OUT=${1:?uso: RISK_BACKUP_URL=... $0 <arquivo.dump>}
: "${RISK_BACKUP_URL:?defina RISK_BACKUP_URL}"
LIB="$(cd "$(dirname "$0")" && pwd)/lib"
. "$LIB/guard-url.sh"
guard_url_syntax "$RISK_BACKUP_URL" || exit 1
case "$db" in *_test) ;; *) echo "recusado: banco deve terminar em _test" >&2; exit 1 ;; esac
case "$OUT" in /*) ;; *) OUT="$PWD/$OUT" ;; esac
[ -e "$OUT" ] && { echo "recusado: $OUT já existe" >&2; exit 1; }
dir=$(dirname "$OUT"); base=$(basename "$OUT")
NAME="openclaw-risk-backup-$$"
RUN_LABEL="com.openclaw-risk-engine.backup-run=$$"
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT
( umask 077; docker run --rm --name "$NAME" --label com.openclaw-risk-engine.test=1 --label "$RUN_LABEL" --network host \
  -e RISK_BACKUP_URL -v "$dir:/out" -v "$LIB:/lib-guard:ro" postgres:14-alpine \
  sh -c '. /lib-guard/guard-url.sh
    guard_url_syntax "$RISK_BACKUP_URL" || exit 1
    effective_conn_check "$RISK_BACKUP_URL" || exit 1
    pg_dump --format=custom --no-owner --dbname="$RISK_BACKUP_URL" --file="/out/$0"' "$base" )
echo "backup gravado: $OUT (banco $db)"

#!/bin/sh
# Restore (pg_restore 14) de um dump custom em um banco NOVO e LOCAL *_test, dentro de contêiner postgres:14 descartável.
#   RISK_RESTORE_URL=postgres://admin:senha@127.0.0.1:PORTA/<novo>_test sh scripts/restore-local.sh <arquivo.dump>
#   ... | RISK_RESTORE_URL=... sh scripts/restore-local.sh -      (modo '-': o dump custom em CLARO vem pela entrada padrão,
#   sem tocar o disco; usado por scripts/restore-encrypted-local.sh depois de decifrar com age)
# O banco de destino deve existir e estar vazio (sem tabelas em public); o script recusa restaurar sobre dados.
# Após restaurar (decisão do usuário, notas da 2.5): o serviço fica not-ready até reconciliar reservas. Este script:
#   0. valida a URL (sem '?'/host=/dbname=) e a conexão efetiva (*_test, servidor local) antes de qualquer escrita;
#   1. provisiona as roles (roles.sql, idempotente) ANTES do pg_restore (o dump traz GRANTs para openclaw_risk_runtime)
#      e REVOGA o CONNECT do runtime durante a restauração;
#   2. restaura com --role=openclaw_risk_owner (objetos nascem do dono correto; o dump usa --no-owner);
#   3. IMEDIATAMENTE após o pg_restore marca restore_pending=true (mark-restore-pending.sql); depois corrige/verifica
#      ownership (post-restore.sql) e, por último, reaplica roles.sql (reconcede o CONNECT do runtime).
# RESTORE INTERROMPIDO (falha ou Ctrl-C entre os passos): o CONNECT do runtime pode ficar revogado e, se a interrupção
# ocorreu depois do pg_restore e antes da marcação, restore_pending pode não estar marcado. NÃO suba a app: marque
# manualmente (CLI mark-restore-pending com a credencial de migração) e conclua post-restore.sql/roles.sql à mão, ou
# descarte o banco e refaça. Ver docs/operacao/backup-restauracao.md.
# Depois: reconcile-after-restore -> verify-runtime-privileges -> app ready (docs/operacao/backup-restauracao.md).
# A URL é passada por variável de ambiente; nada é impresso.
set -eu
IN=${1:?uso: RISK_RESTORE_URL=... $0 <arquivo.dump|->}
: "${RISK_RESTORE_URL:?defina RISK_RESTORE_URL}"
LIB="$(cd "$(dirname "$0")" && pwd)/lib"
. "$LIB/guard-url.sh"
guard_url_syntax "$RISK_RESTORE_URL" || exit 1
case "$db" in *_test) ;; *) echo "recusado: banco deve terminar em _test" >&2; exit 1 ;; esac
if [ "$IN" = "-" ]; then
  base=-   # modo stdin: nada é montado; o contêiner lê o dump da entrada padrão (docker run -i)
else
  case "$IN" in /*) ;; *) IN="$PWD/$IN" ;; esac
  [ -r "$IN" ] || { echo "dump ilegível ou ausente" >&2; exit 1; }
  dir=$(dirname "$IN"); base=$(basename "$IN")
fi
PROV="$(cd "$(dirname "$0")" && pwd)/provision"
[ -r "$PROV/roles.sql" ] && [ -r "$PROV/post-restore.sql" ] && [ -r "$PROV/mark-restore-pending.sql" ] || { echo "scripts/provision incompleto" >&2; exit 1; }
NAME="openclaw-risk-restore-$$"
RUN_LABEL="com.openclaw-risk-engine.restore-run=$$"
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT
# Modo '-': docker run -i (stdin do contêiner = dump em claro vindo do pipe); /in recebe só o diretório de provisionamento (sem dump em disco).
if [ "$base" = "-" ]; then RUN_IN="-i"; MOUNT_IN="$PROV:/in:ro"; else RUN_IN=""; MOUNT_IN="$dir:/in:ro"; fi
docker run --rm $RUN_IN --name "$NAME" --label com.openclaw-risk-engine.test=1 --label "$RUN_LABEL" --network host \
  -e RISK_RESTORE_URL -v "$MOUNT_IN" -v "$PROV:/prov:ro" -v "$LIB:/lib-guard:ro" postgres:14-alpine \
  sh -c '
    set -e
    . /lib-guard/guard-url.sh
    guard_url_syntax "$RISK_RESTORE_URL" || exit 1
    effective_conn_check "$RISK_RESTORE_URL" || exit 1   # antes de qualquer escrita
    n=$(psql "$RISK_RESTORE_URL" -Atc "select count(*) from pg_tables where schemaname=\$\$public\$\$") || exit 1
    [ "$n" = 0 ] || { echo "recusado: banco de destino não está vazio" >&2; exit 1; }
    psql "$RISK_RESTORE_URL" -q -v ON_ERROR_STOP=1 -v dbname="$db" -f /prov/roles.sql
    if [ "$0" = - ]; then SRC=""; else SRC="/in/$0"; fi   # modo -: sem arquivo, o pg_restore lê o stdin (custom em pipe)
    # Mantém o runtime SEM CONNECT durante toda a restauração (roles.sql o concede; revogado aqui e reconcedido no fim).
    psql "$RISK_RESTORE_URL" -q -v ON_ERROR_STOP=1 -c "REVOKE CONNECT ON DATABASE \"$db\" FROM openclaw_risk_runtime"
    pg_restore --exit-on-error --no-owner --role=openclaw_risk_owner --dbname="$RISK_RESTORE_URL" ${SRC:+"$SRC"}
    # IMEDIATAMENTE após o pg_restore (antes de qualquer outro passo): se algo falhar depois, o banco já está marcado.
    psql "$RISK_RESTORE_URL" -q -v ON_ERROR_STOP=1 -f /prov/mark-restore-pending.sql
    psql "$RISK_RESTORE_URL" -q -v ON_ERROR_STOP=1 -f /prov/post-restore.sql
    # Último passo: roles.sql reconcede CONNECT ao runtime (a app continua not-ready por restore_pending).
    psql "$RISK_RESTORE_URL" -q -v ON_ERROR_STOP=1 -v dbname="$db" -f /prov/roles.sql' "$base"
echo "restore concluído em $db; restore_pending=true: reconcilie antes de subir a app"

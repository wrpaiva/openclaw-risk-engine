#!/bin/sh
# Aplica scripts/provision/roles.sql (roles e CONNECT) no banco alvo. Idempotente; nunca grava senha.
# Trava: só PostgreSQL local e banco terminado em _test, salvo RISK_PROVISION_ALLOW_NON_TEST=1 (decisão explícita
# do operador; ainda exige host local). Nunca aponte para PostgreSQL de produção.
# Uso: RISK_PROVISION_URL=postgres://admin@127.0.0.1:PORT/<banco> sh scripts/provision-db.sh
set -eu
cd "$(dirname "$0")/.."
: "${RISK_PROVISION_URL:?defina RISK_PROVISION_URL (conta administradora do alvo)}"

# Valida sintaxe (sem '?', host=/dbname=/service=; host local) e extrai $host/$db sem registrar credenciais.
. scripts/lib/guard-url.sh
guard_url_syntax "$RISK_PROVISION_URL" || exit 1
case "$db" in
  *_test) ;;
  *) [ "${RISK_PROVISION_ALLOW_NON_TEST:-}" = "1" ] || { echo "recusado: banco deve terminar em _test (ou RISK_PROVISION_ALLOW_NON_TEST=1)" >&2; exit 1; } ;;
esac
# Conexão efetiva ANTES de qualquer escrita (current_database()/inet_server_addr()).
case "$db" in *_test) effective_conn_check "$RISK_PROVISION_URL" || exit 1 ;; *) effective_conn_check "$RISK_PROVISION_URL" 1 || exit 1 ;; esac

psql "$RISK_PROVISION_URL" -v ON_ERROR_STOP=1 -v dbname="$db" -f scripts/provision/roles.sql
echo "provisionado: roles openclaw_risk_owner/openclaw_risk_runtime e CONNECT em $db"

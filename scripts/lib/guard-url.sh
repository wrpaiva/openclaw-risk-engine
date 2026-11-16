# Biblioteca (sourced por backup-local.sh, restore-local.sh e provision-db.sh). Não executar diretamente.
# Trava de destino em duas camadas, sem imprimir credenciais:
#   1. guard_url_syntax <url>: recusa qualquer URL com '?' (parâmetros de consulta) ou com host=/hostaddr=/dbname=/service=
#      em qualquer posição (override de destino pelo libpq) ou com '%' (percent-encoding no host/banco); extrai $host e $db
#      e exige host 127.0.0.1/localhost/[::1] e banco [A-Za-z0-9_]+. A exigência de *_test fica a cargo do chamador.
#   2. effective_conn_check <url>: consulta a conexão EFETIVA (current_database(), inet_server_addr()) com psql e recusa
#      se o banco não for *_test ou se o servidor não estiver em endereço local/privado. Rode ANTES de qualquer escrita.
#      Limite conhecido: com Postgres em contêiner publicado em 127.0.0.1, o servidor vê o IP da bridge Docker (privado);
#      então endereço privado é aceito. A trava forte continua sendo o nome do banco *_test e o host da URL.

guard_url_syntax() {
  case "$1" in
    *\?*|*host=*|*hostaddr=*|*dbname=*|*service=*|*%*) echo "recusado: URL com parâmetros de consulta, host=/dbname=/service= ou percent-encoding" >&2; return 1 ;;
  esac
  _rest=${1#*://}; _hostpart=${_rest#*@}; [ "$_hostpart" = "$_rest" ] && _hostpart=$_rest
  _hostport=${_hostpart%%/*}
  case "$_hostport" in
    \[*\]*) host=${_hostport%%]*}; host="$host]" ;;
    *) host=${_hostport%%:*} ;;
  esac
  db=${_hostpart#*/}
  [ "$db" = "$_hostpart" ] && db=""
  case "$host" in 127.0.0.1|localhost|"[::1]") ;; *) echo "recusado: host de destino deve ser local" >&2; return 1 ;; esac
  case "$db" in ""|*[!A-Za-z0-9_]*) echo "recusado: nome de banco inválido" >&2; return 1 ;; esac
}

# Segundo argumento "1" = não exigir *_test (só provision-db.sh com RISK_PROVISION_ALLOW_NON_TEST=1; o host segue local).
# Requer psql no PATH (no host ou dentro do contêiner postgres). Sai com status 1 e mensagem fixa se recusar.
effective_conn_check() {
  _out=$(psql "$1" -X -At -F '|' -c "select current_database(), coalesce(inet_server_addr() <<= any (array['127.0.0.0/8','::1/128','10.0.0.0/8','172.16.0.0/12','192.168.0.0/16']::inet[]), false)" 2>/dev/null) || {
    echo "recusado: não foi possível verificar a conexão efetiva" >&2; return 1; }
  _edb=${_out%%|*}; _elocal=${_out#*|}
  if [ "${2:-}" != "1" ]; then
    case "$_edb" in *_test) ;; *) echo "recusado: banco efetivo não termina em _test" >&2; return 1 ;; esac
  fi
  [ "$_edb" = "$db" ] || { echo "recusado: banco efetivo difere do da URL" >&2; return 1; }
  [ "$_elocal" = "t" ] || { echo "recusado: servidor efetivo não está em endereço local" >&2; return 1; }
}

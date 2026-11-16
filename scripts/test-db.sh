#!/bin/sh
# PostgreSQL 14 DESCARTÁVEL para testes de integração (SPEC §9.2, ADR-0009).
# Só escuta em 127.0.0.1, dados em tmpfs, container removido ao parar.
# Nunca aponta para PostgreSQL de produção nem cria serviço Swarm.
set -eu
NAME=openclaw-risk-testdb
PORT=${RISK_TEST_DB_PORT:-55432}

case "${1:-}" in
  up)
    if docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
      echo "$NAME já está em execução"
    else
      docker run -d --rm --name "$NAME" \
        --label openclaw-risk-engine=test-db \
        -p "127.0.0.1:${PORT}:5432" \
        --tmpfs /var/lib/postgresql/data \
        -e POSTGRES_USER=risk_test -e POSTGRES_PASSWORD=risk_test -e POSTGRES_DB=openclaw_risk_test \
        postgres:14-alpine >/dev/null
    fi
    i=0
    until docker exec "$NAME" pg_isready -U risk_test -d openclaw_risk_test >/dev/null 2>&1; do
      i=$((i + 1)); [ "$i" -gt 60 ] && { echo "banco de teste não ficou pronto" >&2; exit 1; }
      sleep 1
    done
    echo "RISK_TEST_DATABASE_URL=postgres://risk_test:risk_test@127.0.0.1:${PORT}/openclaw_risk_test"
    ;;
  down)
    docker stop "$NAME" >/dev/null 2>&1 || true
    ;;
  *)
    echo "uso: $0 up|down" >&2; exit 2
    ;;
esac

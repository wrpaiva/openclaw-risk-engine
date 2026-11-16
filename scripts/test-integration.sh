#!/bin/sh
# Integração + concorrência em PostgreSQL 14 descartável (SPEC §9.2). Nunca usa banco real.
set -eu
cd "$(dirname "$0")/.."
if [ -z "${RISK_TEST_DATABASE_URL:-}" ]; then
  RISK_TEST_DATABASE_URL=$(sh scripts/test-db.sh up | sed -n 's/^RISK_TEST_DATABASE_URL=//p')
  export RISK_TEST_DATABASE_URL
  trap 'sh scripts/test-db.sh down' EXIT
fi
npx vitest run tests/integration tests/concurrency --testTimeout=60000 --hookTimeout=60000 "$@"

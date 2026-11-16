#!/bin/sh
# Aplica migrações com a CREDENCIAL DE MIGRAÇÃO (dono do schema; SPEC §11.1), nunca a de runtime.
# Defina exatamente um de RISK_MIGRATION_DATABASE_URL ou RISK_MIGRATION_DATABASE_URL_FILE (e RISK_ENVIRONMENT=PAPER).
# Não roda automaticamente em deploy nem no boot; execução exige decisão explícita do operador (ADR-0008).
set -eu
npm run build >/dev/null
exec node dist/interfaces/cli/main.js migrate

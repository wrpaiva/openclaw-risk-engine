#!/bin/sh
# Verificação local da etapa (SPEC §2.3). Regressão ponta a ponta só no marco final (ADR-0009).
set -eu
npm run typecheck
npm run lint
npm run test:unit
npm run test:contract
npm run test:integration

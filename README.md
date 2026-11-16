# OpenClaw Risk Engine

Componente determinístico de autorização de risco entre os agentes de trading do OpenClaw (que apenas **propõem** ordens) e um futuro executor de paper trading. Devolve `ALLOW_PAPER` ou `BLOCK` com códigos de violação estruturados. Especificação: `docs/SPEC_OPENCLAW_RISK_ENGINE.md` (SPEC-TRADING-RISK-001).

## Somente paper trading

- `ALLOW_PAPER` nunca autoriza uma ordem real. Não existe caminho de execução real, nem credencial de exchange/corretora (nem como variável opcional). O boot recusa `RISK_ENVIRONMENT` diferente de `PAPER` e variáveis com padrão de credencial de exchange/corretora.
- Nenhuma saída de LLM influencia a decisão. Falha de qualquer dependência, dado ausente ou exceção resulta em não autorizar (fail-closed).
- **Estado atual:** as fontes de mercado, catálogo de instrumentos e snapshot de conta estão `Unconfigured` (devolvem `null`). A imagem real, portanto, só emite `BLOCK`. `ALLOW_PAPER` em produção está bloqueado pela SPEC §12 até as decisões D-01 a D-10 serem tomadas pelo usuário.
- **Rede (ADR-0011, O2):** `RISK_HTTP_BIND_SCOPE=loopback` (default) ou `private-network` (bind `0.0.0.0`, exige `RISK_HTTP_TRANSPORT=plaintext-encrypted-overlay`: Bearer em claro dentro de overlay cifrada dedicada). Risco P1: o bind curinga escuta em todas as redes do contêiner (ver `docs/operacao/seguranca.md` e o checklist pré-deploy em `docs/operacao/deploy.md`).
- Nada foi implantado: não há serviço na VPS, `/opt/openclaw-risk-engine`, rede, secret Swarm nem rota no Traefik.

## Estado do projeto

Etapas 2.1 a 2.4 aprovadas; 2.5 (empacotamento e operação) em andamento. Notas por etapa em `docs/notas/`. ADRs em `docs/adr/` (todos em status Proposto; catálogo em `README-ADR.md`).

## Build e testes

Requisitos: Node.js 22+, Docker (para testes de integração e imagem).

```bash
npm ci
npm run typecheck
npm run lint
npm run test:unit
npm run test:contract
npm run test:integration   # sobe postgres:14 descartável em 127.0.0.1:55432 (tmpfs) e remove ao fim
npm run test:db -- up|down # gerencia esse contêiner manualmente
npm run image:build        # imagem local openclaw-risk-engine:<versão do package.json>; não publica
npm run test:e2e           # PostgreSQL descartável + migração e app pela imagem (exige image:build antes); recursos com label por ciclo (e2e-run=<pid>); portas via RISK_E2E_DB_PORT/RISK_E2E_APP_PORT
npm run check              # typecheck, lint, unit, contract e integration
```

Testes de integração só rodam em banco local cujo nome termina em `_test`. Nunca aponte para outro banco.

## Documentação operacional

Índice em [`docs/operacao/runbook.md`](docs/operacao/runbook.md):

- [Deploy](docs/operacao/deploy.md) (inclui variáveis `RISK_*` e exit codes; as CLIs do operador `migrate`, `reconcile-after-restore` e `mark-restore-pending` usam `RISK_MIGRATION_DATABASE_URL(_FILE)` e exigem os três `RISK_DB_*_TIMEOUT_MS`)
- [Rollback](docs/operacao/rollback.md)
- [Backup e restauração](docs/operacao/backup-restauracao.md)
- [Alarmes](docs/operacao/alarmes.md)
- [Troubleshooting](docs/operacao/troubleshooting.md)
- [Segurança](docs/operacao/seguranca.md)

Deploy exemplo (não aplicado): `deploy/stack.example.yml`. Modelo de variáveis: `.env.example`.

# Runbook operacional do Risk Engine

Status: documento da etapa 2.5. **Nada descrito aqui foi executado em produção.**

## Aviso de aprovação

Os seguintes itens **requerem aprovação explícita do usuário** e **não foram feitos**:

- implantar na VPS e criar `/opt/openclaw-risk-engine`;
- criar serviço Swarm, rede ou Docker secret;
- qualquer alteração no Traefik;
- rodar SQL (roles, migrações, grants) no PostgreSQL de produção;
- qualquer alteração em `openclaw-trading_openclaw`, `pixel-agents_web` ou `pixel-events_receiver`.

Rede e TLS: ADR-0011 **Aceito** em 2026-11-15 — O2, overlay Swarm dedicada e cifrada, sem porta publicada. O mecanismo está implementado: `RISK_HTTP_BIND_SCOPE=loopback` (default) ou `private-network` (bind `0.0.0.0`, exige `RISK_HTTP_TRANSPORT=plaintext-encrypted-overlay`). Nada foi implantado: a rede, o nome dela e a anexação do OpenClaw exigem aprovação explícita no deploy. **Risco P1:** o bind curinga escuta em todas as redes anexadas ao contêiner; veja `seguranca.md` e o checklist pré-deploy em `deploy.md`. O `http.listening` registra `bindScope` e `transport` (nunca host, porta ou URL); a CLI `healthcheck` sonda o loopback do próprio contêiner em `private-network`.

## Visão geral do serviço

- Processo HTTP (`node:http`, sem dependências extras) em `dist/interfaces/http/main.js`, ativado só com `RISK_HTTP_ENABLED=true`. Rotas de negócio (SPEC §8.2): `POST /v1/risk/evaluations`, `GET /v1/risk/decisions/{id}`, `POST /v1/risk/authorizations/{id}/consume`, `POST /v1/risk/reservations/{id}/release`; `GET /v1/risk/decisions/{id}` e o replay idempotente devolvem a decisão **histórica**, não a validade atual da autorização (pode estar vencida, consumida ou liberada); o portão é o consume. Saúde: `GET /health/live` e `GET /health/ready` (sem autenticação, mesma porta).
- CLI one-shot em `dist/interfaces/cli/main.js`: `migrate`, `expire-reservations`, `reconcile-after-restore`, `mark-restore-pending`, `verify-runtime-privileges`, `healthcheck`. Nada é agendado pela aplicação.
- Banco: PostgreSQL 14, base dedicada `openclaw_risk` (ADR-0008), com duas roles: `openclaw_risk_owner` (migração) e `openclaw_risk_runtime` (grupo NOLOGIN; os logins de runtime herdam dela).
- Imagem: `openclaw-risk-engine:<versão>`, local (sem registry), não-root (1000:1000), compatível com `--read-only`.
- Logs: JSON lines em stdout; métricas derivadas de log (`metric.*`).

## Estado atual

- Fontes de mercado, catálogo e snapshot: `Unconfigured*` (D-02, D-03, D-05 em aberto). Toda avaliação resulta em `BLOCK`.
- `ALLOW_PAPER` em produção está **bloqueado pela SPEC §12** até D-01 a D-10 serem decididas pelo usuário. Os caminhos de ALLOW, consume e concorrência são provados apenas em testes, com composição de teste e fixtures.
- Grants de acesso (`risk_access_grants`) são inseridos por SQL; não há CLI administrativa (D-08 em aberto).
- Os IDs dos sete agentes ainda são fixtures (`fixture-agent-1` a `fixture-agent-7`).

## Índice

| Documento | Conteúdo |
|---|---|
| [deploy.md](deploy.md) | Provisionamento, migração, subida, variáveis `RISK_*`, exit codes, `expire-reservations` |
| [rollback.md](rollback.md) | Voltar a imagem; migrações forward-only |
| [backup-restauracao.md](backup-restauracao.md) | Scripts locais; job de backup de produção (ADR-0012); ensaio de restauração cifrada; procedimento pós-restauração |
| [alarmes.md](alarmes.md) | SPEC §11.3 mapeada para sinais de log |
| [troubleshooting.md](troubleshooting.md) | Diagnóstico por sintoma |
| [seguranca.md](seguranca.md) | Privilégio mínimo, segredos, tokens, imagem |

## Divergência registrada

A SPEC §11.2 lista `RISK_POLICY_ID`. **Essa variável não existe.** A política ativa é resolvida **por conta**, no banco (tabela `risk_policies`, versões imutáveis e com hash). Se a conta não tem política aplicável, a avaliação resulta em `BLOCK` (`POLICY_MISSING`/`POLICY_INVALID`).

## Valores "a definir" (decisão do usuário)

Nenhum número abaixo foi inventado; todos aguardam decisão: grace period de parada (`stop_grace_period`), `interval`/`timeout`/`retries`/`start_period` do healthcheck do stack, réplicas e política de restart/update, retenção de logs, decisões e auditoria, frequência e agendador do `expire-reservations`, limiares e destinos de alarme, estratégia de backup de produção (D-10), valores de `RISK_*` numéricos. A lista consolidada está no fim de [deploy.md](deploy.md#pendencias-a-definir).

## Rotina de backup (ADR-0012; nada disto foi aplicado em produção)

| Quando | O quê | Onde ler |
|---|---|---|
| Diário (horário a definir) | `cron` do host roda `scripts/backup-prod.sh <backup.env>`; confira o exit code (0 = OK) | [backup-restauracao.md](backup-restauracao.md#produção-adr-0012) |
| Após cada `migrate` | Reaplicar `scripts/provision/backup-grants.sql` (senão o backup falha com permissão negada em tabela nova; exit 2/4) | [deploy.md](deploy.md#backup-adr-0012) |
| Mensal | Teste de recuperação na estação do operador: `restore-encrypted-local.sh` em `*_test` -> `migrate` se preciso -> `reconcile-after-restore` -> `verify-runtime-privileges` -> `ready`; registre data e resultado | [backup-restauracao.md](backup-restauracao.md) |
| Falha de backup | Ver exit code e a linha JSON `event` do log do cron; ver tabela em [alarmes.md](alarmes.md#backup-adr-0012) | [alarmes.md](alarmes.md) |
| Restauração em produção | **Só com aprovação do usuário**, seguindo o procedimento pós-restauração (serviço parado, `restore_pending`, reconciliação) | [backup-restauracao.md](backup-restauracao.md#procedimento-pós-restauração-decisão-do-usuário-2026-11-14) |

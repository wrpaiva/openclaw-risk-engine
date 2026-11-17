# Alarmes e sinais (SPEC §11.3)

> **Destino dos alertas, limiares e quem é acionado: a definir pelo usuário.** Não há Prometheus nem sistema de alertas implantado (fora do escopo da 2.5). Esta página mapeia cada alarme da SPEC para um sinal concreto que já existe em log, para que a regra seja escrita pelo coletor de logs que o usuário escolher. **Nenhum limiar numérico foi inventado.**

## Como os sinais saem

Logs em JSON lines no stdout, com campos de uma allowlist (`time`, `level`, `event`, `requestId`, `correlationId`, `proposalId`, `decisionId`, `reservationId`, `principalId`, `accountId`, `route`, `httpStatus`, `outcome`, `violationCodes`, `errorKind`, `durationMs`, `op`, `kind`, `count`). As "métricas" são eventos de log `metric.*`: cada linha é um incremento (`count: 1`) ou uma duração; quem coleta logs agrega.

> **Atenção: os eventos `metric.*` são emitidos em nível `info`.** Com `RISK_LOG_LEVEL=warn` ou `error` eles **desaparecem** e os alarmes baseados em métrica deixam de funcionar. Os eventos de aviso/erro (`http.request` ≥ 401, `evaluate.forbidden`, `db.client_error`, etc.) continuam. Decidir o nível de log em produção é do usuário; se alarmes por métrica forem usados, é preciso `info`.

`http.request` é emitido por requisição, exceto `/health/live` e `/health/ready` com 200. Nível: `error` se status ≥ 500; `warn` se 401 ou 403; `info` nos demais.

## Métricas da SPEC §11.3

| Métrica da SPEC | Evento de log | Campos |
|---|---|---|
| `risk_evaluations_total{status,reasonCode}` | `metric.evaluation` | `outcome` (`ALLOW_PAPER`/`BLOCK`), `violationCodes` (um código; `NONE` se não houver), `count`. **Emitido uma vez por violação** (um BLOCK com 3 violações gera 3 eventos): somar `metric.evaluation` conta violações, não avaliações. Para contar **avaliações**, use `metric.evaluation_duration` (um por avaliação nova concluída; replays idempotentes não o emitem, só `metric.idempotency_replay`) |
| `risk_evaluation_duration_seconds` | `metric.evaluation_duration` | `durationMs` |
| `risk_reservation_conflicts_total` | `metric.reservation_conflict` | `op` (`CONSUME`/`RELEASE`) |
| `risk_dependency_failures_total` | `metric.dependency_failure` | `kind` |
| `risk_idempotency_replays_total` | `metric.idempotency_replay` | `count` |
| (erros de transporte, distintos de BLOCK) | `metric.transport_error` | `outcome` (`AUTH`/`CONTRACT`/`CONFLICT`/`UNAVAILABLE`) |
| (operações de reserva) | `metric.reservation_op` | `op` (`CONSUME`/`RELEASE`/`EXPIRE`), `outcome` (`OK`/`CONFLICT`/`FORBIDDEN`/`UNAVAILABLE`) |

`metric.dependency_failure` só é emitido com `kind=DATABASE`. **`MARKET_DATA`, `INSTRUMENT_CATALOG` e `ACCOUNT_SNAPSHOT` não têm emissor** até D-02/D-03/D-05 (as fontes `Unconfigured` devolvem `null`, o que vira violação de `BLOCK`, não falha de dependência). Hoje esses três não podem disparar alarme.

## Alarmes da SPEC mapeados para sinais

| Alarme (SPEC §11.3) | Sinal concreto | Observação |
|---|---|---|
| Aumento de bloqueios por falha de infraestrutura | `http.request` com `httpStatus` 503 (nível `error`); `metric.transport_error` com `outcome=UNAVAILABLE`; `metric.dependency_failure` com `kind=DATABASE`; `evaluate.unavailable`, `consume.unavailable`, `release.unavailable`, `decision.read.unavailable` (nível `error`); `db.client_error` (nível `error`, conexão perdida em uso); `pool.error`. Para bloqueios de domínio por dado ausente: `metric.evaluation` com `outcome=BLOCK` e `violationCodes` como `MARKET_DATA_UNAVAILABLE`, `MARKET_DATA_STALE`, `FX_RATE_UNAVAILABLE`, `ACCOUNT_SNAPSHOT_STALE`, `POLICY_MISSING`, `POLICY_INVALID`, `INTERNAL_EVALUATION_FAILURE` | **Hoje**, com as fontes `Unconfigured`, todo BLOCK é esperado: um alarme por BLOCK de dado ausente dispararia sempre. Ativar só quando as fontes reais existirem. `503` e `db.client_error` já são válidos |
| Divergências de snapshot | `metric.evaluation` com `violationCodes=ACCOUNT_SNAPSHOT_STALE` | Sem emissor de `dependency_failure` para `ACCOUNT_SNAPSHOT` até D-05 |
| Tentativas de execução sem autorização | `evaluate.forbidden` (warn: `outcome=AGENT_ID_MISMATCH` ou grant ausente); `http.forbidden` (`WRONG_ROLE`); `consume.forbidden`, `release.forbidden`, `consume.account_mismatch`, `decision.read.denied`; `http.request` com 401/403 (warn); consume rejeitado: `http.request` 409 em `POST /v1/risk/authorizations/:id/consume` e `metric.reservation_op` `op=CONSUME` com `outcome` `CONFLICT`/`FORBIDDEN` | 401 em excesso pode indicar token rotacionado e cliente desatualizado ou abuso. Rate-limit é da borda, não do processo |
| Expiração de reservas | Auditoria `RESERVATION_EXPIRED` em `risk_audit_events` (gravada na varredura `details.trigger='sweep'`, no consume após o TTL `consume-after-ttl` e no release após o TTL); `metric.reservation_op` com `op=EXPIRE`, `outcome=OK` (somente a varredura); resposta **409** `NOT_AUTHORIZED` com `reason=EXPIRED` no consume e `409 {status:'EXPIRED'}` no release | `RESERVATION_EXPIRED` **não é um evento de log**: é linha de auditoria no banco. Em log, os sinais são `metric.reservation_op` (EXPIRE) e os 409 em `http.request`. Reservas vencidas só voltam a capacidade quando o `expire-reservations` roda |

## Outros sinais úteis (sem alarme da SPEC)

- Reconciliação pós-restauração pendente: `/health/ready` 503 com `reconciliation: fail`; evaluate/consume/release devolvem 503 e logam `evaluate.unavailable`/`consume.unavailable`/`release.unavailable` com `errorKind=RestorePendingError`. Sinal de que uma restauração (ou `mark-restore-pending`) aguarda `reconcile-after-restore`. A conclusão aparece como `metric.reservation_op op=EXPIRE` (uma linha por reserva expirada) e, no banco, `RESTORE_RECONCILED` em `risk_audit_events`.
- Banco congelado/sem resposta: `metric.dependency_failure kind=DATABASE` e `http.request` 503 em tempo finito (ver prazos em `troubleshooting.md`).
- Falha de readiness: `/health/ready` com 503 (não gera log em 200; 503 gera `http.request` em `error`). Ver `troubleshooting.md`.
- `http.internal_error` (nível `error`): exceção inesperada, resposta 500 `INTERNAL_ERROR`. Deve ser investigado sempre.
- `http.listening` (`outcome=STARTED`): subida do servidor.
- `metric.idempotency_replay`: replays normais; um aumento forte pode indicar cliente em laço de retry.
- `metric.evaluation_duration`: latência, sem SLA definido.

## Backup (ADR-0012)

O job de backup **não** emite métricas do serviço: o sinal é o **código de saída** de `scripts/backup-prod.sh` (e as linhas JSON `{event,file,bytes,exitCode}` no log do cron, sem segredos). **Destino do alerta, limiar de atraso ("sem backup há N horas") e quem é acionado: a definir (U6); nenhum número foi decidido.** O teste de recuperação mensal também precisa de um sinal de "feito/não feito" (a definir).

| Exit | Eventos típicos | Ação |
|---|---|---|
| 2 | `config_invalid_*`, `config_missing_secret`, `guard_connect_failed`, `guard_target_or_privileges_refused` | Nada foi gravado. Config/secret errados, banco inesperado, login com escrita ou fora do esperado. Se surgiu após um `migrate`: reaplicar `backup-grants.sql` |
| 3 | (mensagem do `flock`) | Execução anterior ainda rodando; investigar se travou |
| 4 | `dump_failed`, `dump_invalid_output`, `final_exists`, `publish_failed` | Sem arquivo final. Banco indisponível, `age` falhou, nome já existente ou disco cheio |
| 5 | `upload_failed`, `upload_verify_failed`, `upload_head_failed`, `upload_target_exists` | `upload_target_exists`: o objeto remoto já existia e NÃO foi sobrescrito (investigar colisão de nome; nunca apagar às cegas). Com `--retries` > 1, um PUT que gravou mas perdeu a resposta pode gerar este evento para o PRÓPRIO objeto: confira o objeto remoto (tamanho e conteúdo) com o `.sha256` local antes de concluir que houve colisão; o alerta continua valendo. Cópia local existe (e a retenção local rodou); a cópia externa falhou. Reenviar manualmente com aprovação; sem a cópia externa a VPS é ponto único de falha |
| 6 | `retention_failed` | Backup OK; arquivo antigo não removido. Verificar permissões e disco |
| ≠ 0 não listado | - | Falha do docker (tratada como 4); investigar |

Também: monitorar o espaço do diretório de backup na VPS (U8) e a existência de `.partial` órfãos (`partial_orphans_found`).

## A definir pelo usuário

Destino dos alertas (canal, pessoa, plantão), ferramenta de coleta de logs, limiares e janelas de cada alarme, nível de log em produção (ver aviso de `metric.*`), retenção de logs. Nenhum número foi decidido.

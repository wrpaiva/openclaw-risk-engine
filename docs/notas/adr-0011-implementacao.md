# Implementação do ADR-0011 (O2): `RISK_HTTP_BIND_SCOPE`

Status: concluída e aprovada pelo usuário em 2026-11-15. Plano do arquiteto abaixo; decisões conservadoras adotadas pelo líder nos pontos P2, P3 e P6 (ver final), aprovadas junto com a implementação.

## 0. Achados da leitura
- Config fica em `src/infrastructure/config/loadConfig.ts` (backend). Backend também é dono de `Dockerfile`, `.dockerignore`, `package.json`, `.env.example`, `deploy/`, `docs/operacao/`, `README.md`.
- Bug BAIXO: o `healthcheck` da CLI sonda sempre `127.0.0.1` (`src/interfaces/cli/main.ts:164`); com `RISK_HTTP_HOST=::1` ou outro `127.x` falha com o servidor vivo. Corrigido junto.
- Ajustar ANTES da mudança (hook do TaskCompleted): `tests/unit/architecture/boundaries.test.ts:79` (proíbe `'0.0.0.0'` em src) e `tests/unit/architecture/operationalScripts.test.ts:40` (proíbe `network rm` no cleanup do `test-e2e.sh`).
- `JsonLogger` usa allowlist (`ALLOWED` + `LogFields` em `src/application/ports/Logger.ts`).

## 1. Contrato de configuração
- `RISK_HTTP_BIND_SCOPE` ∈ {`loopback`, `private-network`}; ausente → `loopback`. Vazio, outra caixa ou espaços → rejeitado.
- `RISK_HTTP_TRANSPORT` ∈ {`plaintext-encrypted-overlay`} (declaração explícita de HTTP+Bearer em claro dentro de overlay cifrada; não é booleano; extensível para `tls` no futuro). O processo não verifica a cifragem: verificação via `docker network inspect` no checklist de deploy.
- Hosts: `loopback` → IP literal `127.0.0.0/8` ou `::1` (como hoje). `private-network` → só a grafia canônica `0.0.0.0`; rejeita outras grafias de curinga, `::`, loopback, IP privado literal, hostnames.
- Ordem no `loadConfig`: nomes proibidos → `RISK_MIGRATION_*` → schema base → escopo/transporte (sempre, mesmo com HTTP desligado) → se HTTP off retorna → schema HTTP → host por escopo → headers ≤ request.
- Erros: `ConfigError`, exit 2 (servidor e CLI), mensagem fixa sem o valor recebido.

| ENABLED | SCOPE | TRANSPORT | HOST | Resultado |
|---|---|---|---|---|
| false | ausente/válido | coerente | qualquer | OK, `http.enabled=false` |
| qualquer | inválido | qualquer | qualquer | `RISK_HTTP_BIND_SCOPE: valor inválido` |
| qualquer | qualquer | presente ≠ literal | qualquer | `RISK_HTTP_TRANSPORT: valor inválido` |
| qualquer | `private-network` | ausente | qualquer | `RISK_HTTP_BIND_SCOPE=private-network exige RISK_HTTP_TRANSPORT=plaintext-encrypted-overlay (ADR-0011)` |
| qualquer | ausente/`loopback` | literal | qualquer | `RISK_HTTP_TRANSPORT só é permitido com RISK_HTTP_BIND_SCOPE=private-network` |
| true | ausente/`loopback` | ausente | IP loopback | OK |
| true | ausente/`loopback` | ausente | outro | `RISK_HTTP_HOST: escopo loopback aceita só IP de loopback` |
| true | `private-network` | literal | `0.0.0.0` | OK |
| true | `private-network` | literal | outro | `RISK_HTTP_HOST: escopo private-network aceita só 0.0.0.0` |

- `RiskConfig.http` (habilitado) ganha `bindScope: 'loopback' | 'private-network'` e `transport: 'plaintext-encrypted-overlay' | null`.
- `loadMigrationConfig` não muda; o serviço de migração não entra na rede transacional.
- Módulo novo puro `src/infrastructure/config/httpBind.ts` (`isLoopbackIp`, `isAcceptedWildcard`, `resolveBind`, `healthProbeHost`) — único lugar de `src` com o literal `'0.0.0.0'`.

## 2. Healthcheck
- `healthProbeHost(http)`: escopo `loopback` → o host configurado; `private-network` → `127.0.0.1`. A CLI usa isso em vez do literal fixo; continua sem banco e exigindo `RISK_HTTP_ENABLED=true`.
- `HEALTHCHECK` do Dockerfile: comando igual, só comentário; nenhum número.

## 3. Logs/métricas
- `http.listening` ganha `bindScope` e `transport` (enum fechado; `transport` ausente em loopback). Sem host, porta, URL. Adicionar a `LogFields` e `ALLOWED`. Nenhuma métrica nova.

## 4. Deploy e docs (exemplo, NÃO APLICADO)
- `deploy/stack.example.yml`: `risk-engine` com as 3 variáveis, `networks: [risk_transactional]`, sem `ports:`; `risk-engine-migrate` fora dessa rede; `risk_transactional` `external: true`, `name:` a definir; comentário de criação: overlay, `--opt encrypted`, não attachable, `--internal`. Banner NÃO APLICADO mantido. Rede de acesso ao Postgres: a definir.
- `docs/operacao/deploy.md` (variáveis, checklist pré-deploy com `docker network inspect`/`docker service inspect`), `seguranca.md` (mecanismo, riscos residuais, segundo nó), `troubleshooting.md` (mensagens novas), `runbook.md`, `.env.example` (`RISK_HTTP_BIND_SCOPE=loopback` explícito, `# RISK_HTTP_TRANSPORT=` comentado), `README.md`.

## 5. Testes
- Unit: `tests/unit/infrastructure/config/loadConfigBindScope.test.ts` (matriz completa, mensagens exatas, sem vazar valor, variantes de curinga/caixa/espaço, HTTP desligado, default, campos retornados, `healthProbeHost` com `::1` e `127.5.5.5`); `loadConfig.test.ts` sem regressão.
- Arquitetura: curinga (`'0.0.0.0'`, `'::'`) só em `httpBind.ts`; `http/main.ts` faz listen só com `http.host` da config; `cli/main.ts` sem literal `'127.0.0.1'`.
- `operationalScripts.test.ts`: `docker network rm` só sobre `docker network ls -q --filter "label=$LABEL_KV"` e após o `docker rm -f`; sem prune/system/volume rm/image rm; criação de rede com as duas labels, `--internal`, bridge, checagem de pré-existência.
- Logger: novos campos passam pela allowlist.
- Integração (`tests/integration/Cli.test.ts`): healthcheck `private-network`+`0.0.0.0` (servidor em 127.0.0.1) → 0; `loopback`+`::1` → 0; `private-network` sem transporte → 2.
- E2E `tests/e2e/privateNetwork.e2e.test.ts`: o `scripts/test-e2e.sh` cria rede bridge `--internal` com labels do projeto, conecta o banco do ciclo com alias, cria segredo `runtime_database_url_net`, exporta `RISK_E2E_NETWORK`, `RISK_E2E_DB_ALIAS`, `RISK_E2E_SECRETS_DIR`; regressão principal continua em `--network host`. Dois contêineres da app sem `-p`: (a) private-network, (b) loopback. Cliente = outro contêiner da mesma imagem. Provas: /health/live 200 em (a); rota transacional sem/ com token inválido → 401; com Bearer de fixture ≠ 401/403 e sem autorização; (b) inalcançável mas `healthcheck` interno 0; `--network none` não alcança (a); `healthcheck` interno de (a) 0; `PortBindings` vazio; logs com `bindScope`/`transport` sem token/URL; boot recusado (exit 2) nas combinações inválidas. Limpeza só por label; nunca prune, nunca `aegis-postgres`.

## 6. Ondas
1. Tester: T1 (`boundaries.test.ts`), T2 (`operationalScripts.test.ts`) — verdes no código atual.
2. Backend: B1 (`httpBind.ts` + `loadConfig.ts`), B2 (Logger/JsonLogger/http main), B3 (CLI healthcheck). Tester: T3 (matriz), T4 (logger), T5 (Cli integração).
3. Backend: B4 (`test-e2e.sh`), B5 (Dockerfile comentário + `image:build`), B6 (stack exemplo), B7 (docs/operacao, `.env.example`, README). Tester: T6 (e2e, verde duas vezes, nenhum recurso com label ao final).
4. Revisor e consolidação pelo líder.

## 7. Pontos para o usuário
- **P1:** o bind `0.0.0.0` escuta em todas as redes do contêiner. Se o engine precisar de uma segunda rede para chegar ao Postgres compartilhado, o HTTP fica alcançável pelos serviços dessa rede (protegido só por Bearer + grants). Decidir no deploy: aceitar, isolar o acesso ao banco, ou bind por interface/sub-rede (exigiria ADR novo substituindo o 0011).
- **P2 (adotado provisoriamente):** só `0.0.0.0`, sem `::`.
- **P3 (adotado no exemplo, confirmar no deploy):** overlay de produção `internal` e não attachable.
- **P4:** nome da rede e anexação do OpenClaw exigem aprovação no deploy.
- **P5:** `sslmode` fora desta tarefa.
- **P6 (adotado):** `RISK_HTTP_TRANSPORT` com escopo loopback é rejeitado por ambiguidade.

## Execução e verificação (2026-11-15)
- Onda 1 (tester): testes de arquitetura ajustados (curinga só em `httpBind.ts`; `listen` só com host da config; rede do e2e só por label, `connect` restrito à rede/contêiner do ciclo).
- Onda 2–3 (backend): B1–B7 implementados conforme o plano. Tester: matriz completa (`loadConfigBindScope.test.ts`), allowlist do logger, healthcheck na integração, `privateNetwork.e2e.test.ts` (cliente em outro contêiner, sem `-p`), teste estático de `deploy/stack.example.yml`.
- Revisor: APROVADO COM RESSALVAS — 0 crítico/alto/médio, 7 baixos, todos corrigidos (asserção de log por chave; nomes de teste; casos `::ffff:`/`%lo`/NUL travados; teste do stack; `RISK_E2E_SECRETS_DIR` sempre do ciclo; textos de cabeçalho/banner; checagem de porta em uso via `node` em vez de `/dev/tcp`, que nunca funcionava no dash).
- Verificação final do líder: typecheck/lint limpos; unit 888/888 (24); contract 178/178 (4); integration 414/414 (22); imagem reconstruída; e2e 157/157 (14) com portas 55521/55522; checagem de porta ocupada aborta com exit 1 antes de criar recursos; nenhum contêiner/rede com label ao final.
- Lacuna declarada: a rede do e2e é bridge `--internal`; a cifragem de uma overlay real não é testada (item do checklist de deploy).
- Nada foi implantado; rede de produção, anexação do OpenClaw, P1 e `sslmode` continuam dependendo do usuário no deploy.

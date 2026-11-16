# Troubleshooting

Os logs nunca trazem token, credencial, corpo de requisição nem mensagem de erro do `pg`; só nomes de evento, códigos fechados e `errorKind`. Use `requestId` (devolvido no corpo de erro) para correlacionar.

## `GET /health/ready` devolve 503

Corpo: `{"status":"not_ready","checks":{"database":"ok|fail","schema":"ok|fail","privileges":"ok|fail","reconciliation":"ok|fail","draining":"ok|fail"}}`. Qualquer check em `fail` = 503. A readiness **não** depende de market data, catálogo nem snapshot. Cada verificação tem prazo total finito (ver [Prazos do cliente do banco](#prazos-do-cliente-do-banco)): banco congelado ou sem resposta vira `fail`, nunca uma requisição pendurada.

| Check em `fail` | Causa provável | Ação |
|---|---|---|
| `database` | Banco inalcançável, credencial inválida, timeout (`RISK_DB_CONNECTION_TIMEOUT_MS`/`RISK_DB_STATEMENT_TIMEOUT_MS`), rede entre app e banco | Verifique conectividade e a URL do secret; procure `db.client_error`/`pool.error` e `http.request` 503 |
| `schema` | Alguma migração da imagem não está aplicada, ou está aplicada com checksum diferente, ou `schema_migrations` ilegível, ou a imagem não tem migrações empacotadas | Rode o one-shot `migrate` com a credencial de migração (requer aprovação). Migração extra no banco **não** causa `fail` (N-1). Checksum divergente = arquivo alterado depois de aplicado: não editar; escale |
| `privileges` | O login de runtime excede o mínimo ou a verificação falhou | Rode `verify-runtime-privileges`; veja os códigos abaixo |
| `reconciliation` | `restore_pending=true` (banco restaurado de backup, ou marcado com `mark-restore-pending`), linha de estado ausente (migração `0004` não aplicada) ou leitura falhou | Se houve restauração: siga o procedimento de [backup-restauracao.md](backup-restauracao.md) (`reconcile-after-restore` com a credencial de migração). **Não** limpe a flag por SQL manual. Enquanto pendente, evaluate/consume/release também respondem 503 (log `*.unavailable` com `errorKind=RestorePendingError`) |
| `draining` | O processo recebeu `SIGTERM`/`SIGINT` e está encerrando | Normal durante parada/rollout. `live` continua 200 |

Se a readiness estiver `fail` em tudo, a causa mais comum é o banco indisponível ou congelado (a verificação de privilégios e a de reconciliação também dependem dele).

### Prazos do cliente do banco

`statement_timeout` e `lock_timeout` são aplicados pelo **servidor**; com o banco congelado (processo parado, rede cortada, `docker pause`) eles nunca disparam. Por isso o cliente aplica prazos próprios, derivados só de variáveis já obrigatórias (nenhum número novo):

| Operação | Prazo | Fórmula |
|---|---|---|
| Espera por conexão do pool (`PgTransactionManager`, readiness, inspetor) | `connectMs` | `RISK_DB_CONNECTION_TIMEOUT_MS` |
| Cada comando SQL numa conexão já obtida | `queryMs` | `RISK_DB_CONNECTION_TIMEOUT_MS + RISK_DB_STATEMENT_TIMEOUT_MS` |
| Cada verificação da readiness (`database`, `schema`, `reconciliation`) e o inspetor de privilégios, do início ao fim | prazo total | `RISK_DB_CONNECTION_TIMEOUT_MS + RISK_DB_STATEMENT_TIMEOUT_MS` |

Ao estourar: a conexão é destruída (`release(true)`, nunca volta ao pool), a verificação vira `fail` (readiness/inspetor) ou a transação lança erro, que os casos de uso devolvem como `UNAVAILABLE` (**503**, nunca `ALLOW_PAPER`) e emite `metric.dependency_failure kind=DATABASE`. Uma operação de negócio com banco congelado leva, no pior caso, `connectMs` para obter conexão ou `queryMs` por comando em curso. A margem de uma conexão sobre o `statement_timeout` evita corrida com o timeout do servidor. Se a config não for passada ao componente, usa-se o `connectionTimeoutMillis` do pool e, sem ele, o `statement_timeout`: nunca há espera infinita.

### Códigos de `verify-runtime-privileges` (exit 1)

Impressos em stderr, separados por vírgula, sem nomes de objetos: `SUPERUSER`, `BYPASSRLS`, `CREATEROLE`, `CREATEDB`, `REPLICATION` (atributos da role), `OWNS_RELATION` (login é dono de tabela), `CREATE_ON_PUBLIC`, `MEMBER_OF_OWNER` (login é membro de `openclaw_risk_owner`; use outro login), `EXCESS_TABLE_PRIVILEGE` (DELETE/TRUNCATE/TRIGGER/REFERENCES, ou INSERT/UPDATE além da `0003`), `INSPECTION_FAILED` (não foi possível verificar: banco indisponível ou erro; fail-closed).

## O servidor não sobe (exit codes)

| Exit | Mensagem típica (stderr) | Causa e ação |
|---|---|---|
| 2 | `configuração inválida: <campos>` / `configuração HTTP inválida: <campos>` | Variável ausente ou inválida (a mensagem cita só nomes). Veja a tabela de `deploy.md` |
| 2 | `RISK_DATABASE_URL ou RISK_DATABASE_URL_FILE é obrigatório` / `... mutuamente exclusivos` / `..._FILE: arquivo ilegível` / `conteúdo inválido` | Secret ausente, não montado ou ilegível para o uid 1000; conteúdo vazio ou com mais de uma linha |
| 2 | `credencial de migração não pertence ao ambiente de runtime` | `RISK_MIGRATION_*` presente no ambiente do servidor. Remova |
| 2 | `ambiente contém variáveis com padrão de credencial de exchange/corretora` | Alguma variável de ambiente tem nome com padrão proibido (inclui sufixos `_KEY`, `_PASSWORD`, `_TOKEN`). Remova ou renomeie. Não existe exceção |
| 2 | `RISK_HTTP_BIND_SCOPE: valor inválido` | Use `loopback` ou `private-network`, exatamente (minúsculas, sem espaços, não vazio) |
| 2 | `RISK_HTTP_TRANSPORT: valor inválido` | O único valor aceito é `plaintext-encrypted-overlay` |
| 2 | `RISK_HTTP_BIND_SCOPE=private-network exige RISK_HTTP_TRANSPORT=plaintext-encrypted-overlay (ADR-0011)` | Faltou declarar o transporte |
| 2 | `RISK_HTTP_TRANSPORT só é permitido com RISK_HTTP_BIND_SCOPE=private-network` | Remova a variável (escopo loopback) ou mude o escopo |
| 2 | `RISK_HTTP_HOST: escopo loopback aceita só IP de loopback` | Host é hostname, curinga ou IP de rede com escopo loopback |
| 2 | `RISK_HTTP_HOST: escopo private-network aceita só 0.0.0.0` | Com `private-network` o host deve ser exatamente o curinga IPv4 canônico |
| 2 | `RISK_HTTP_ENABLED não é true; servidor HTTP não iniciado` | Defina `true` |
| 2 | `arquivo de principais ...` | `RISK_PRINCIPALS_FILE` ausente, ilegível, JSON/versão/formato inválido, `principalId` repetido ou hash duplicado |
| 1 | `privilégios do usuário de runtime excedem o mínimo ou não puderam ser verificados; servidor não iniciado` | Rode `verify-runtime-privileges`; ou banco inacessível no boot |
| 1 | `falha ao iniciar o servidor HTTP` | Erro de `listen` (porta em uso, endereço inválido) ou falha inesperada |

CLI: exit 2 = uso/config (inclusive subcomando desconhecido), exit 1 = falha de execução. `migrate` com exit 1 imprime `migração falhou; nada foi confirmado para a migração em curso`; as migrações anteriores já confirmadas permanecem aplicadas (cada migração é uma transação).

## Respostas HTTP

| Status | Código | Causa | Ação |
|---|---|---|---|
| 200 | (decisão) | `BLOCK` **ou** `ALLOW_PAPER` (inclui replay, com cabeçalho `Idempotent-Replayed: true`). Hoje só `BLOCK`, pois as fontes são `Unconfigured` | Veja `violations[].code`. **A resposta (inclusive `GET /v1/risk/decisions/{id}` e o replay) mostra a decisão histórica, não a validade atual:** um `ALLOW_PAPER` devolvido pode já estar vencido, consumido ou liberado. O portão é o **consume** (`POST .../consume`), que revalida a reserva e `authorizationExpiresAt` |
| 400 | `INVALID_JSON` / `INVALID_CONTENT_TYPE` | Corpo não é JSON ou `Content-Type` não é `application/json` | Corrija o cliente |
| 401 | `UNAUTHENTICATED` | Sem `Authorization: Bearer`, token desconhecido ou token errado | Verifique token e hash no arquivo de principals; token rotacionado e arquivo não recarregado (exige reiniciar o processo) |
| 403 | `FORBIDDEN` | Papel errado (`AGENT` vs `PAPER_EXECUTOR`), `agentId` do payload diferente do autenticado, ou sem grant na conta (grant só em log `evaluate.forbidden`, não em auditoria). Nada é gravado | Confira `risk_access_grants` (revogado? conta certa?) |
| 404 | `NOT_FOUND` | Rota inexistente; decisão de outro agente/conta (propositalmente igual a inexistente); release de reserva inexistente **ou sem grant** (release não informa a conta, então 403 revelaria a existência) | |
| 405 | `METHOD_NOT_ALLOWED` | Método errado (inclui `/health/*`); cabeçalho `Allow` | |
| 409 | `IDEMPOTENCY_CONFLICT` | Mesma `(accountId, idempotencyKey)` com hash de proposta diferente | Use nova chave de idempotência para outra proposta |
| 409 | `NOT_AUTHORIZED` (`reason`) | Consume de decisão que não autoriza: `reason` = `EXPIRED` (TTL vencido; a reserva é fechada como `EXPIRED`), `BLOCKED` (decisão `BLOCK`), `RELEASED` ou `PROPOSAL_MISMATCH` (`proposalHash` divergente) | Reavaliar a proposta |
| 409 | `CONFLICT` | Consume/release de reserva em estado incompatível (já consumida/liberada/expirada); no release vem `{status}`, p.ex. `EXPIRED` | Idempotente: o mesmo consume/release repetido devolve o resultado original |
| 413 | `PAYLOAD_TOO_LARGE` | Corpo acima de `RISK_HTTP_MAX_BODY_BYTES` | Reduza o corpo |
| 422 | `INVALID_CONTRACT` | Proposta ou corpo viola o contrato (não é `BLOCK`; só aparece no log `http.request`, sem auditoria) | Veja `violations`/`fields` na resposta |
| 500 | `INTERNAL_ERROR` | Exceção inesperada (nunca vira 200). Log `http.internal_error` com `errorKind` | Investigar sempre |
| 503 | `UNAVAILABLE` | Infraestrutura (banco indisponível, timeout, conexão perdida). **Não é autorização** | Ver `database` na readiness; `metric.dependency_failure` |

Erros de transporte (401/403/400/422/409/503) são distintos de `BLOCK`, e nenhum autoriza.

## Conexão perdida (`db.client_error`)

Evento de nível `error` com `errorKind` quando um cliente em uso perde a conexão (reinício do PostgreSQL, rede, `57P01`). O cliente é destruído e não volta ao pool; a operação em curso falha (fail-closed): o chamador recebe 503, sem autorização, e a transação em curso não foi confirmada. Se persistir, verifique o banco e `database` na readiness. Não reinicie o processo por causa de um evento isolado: o pool se recupera. Uma queda do banco em massa gera `metric.dependency_failure kind=DATABASE` e 503.

## Outros sintomas

- **Tudo `BLOCK`:** esperado hoje (fontes `Unconfigured`, política ausente por conta, ou D-01 a D-10 em aberto). Veja `violations[].code`.
- **`healthcheck` com `private-network`:** a CLI sonda `127.0.0.1` do próprio contêiner (o bind curinga inclui o loopback); não depende da rede transacional. Com `loopback`, sonda o host configurado.
- **`healthcheck` da imagem falha com exit 2:** a CLI exige a config de runtime completa e `RISK_HTTP_ENABLED=true` no ambiente do contêiner; sem isso o `HEALTHCHECK` falha mesmo com o servidor vivo.
- **Reservas que não liberam capacidade:** só a varredura `expire-reservations`, consume ou release as fecham. Agendamento é a definir.
- **`migrate` falha: `migração ... foi alterada depois de aplicada`:** um `.sql` aplicado foi editado. Restaure o arquivo original; mudança = nova migração.
- **`migrate` falha na 0003:** a role `openclaw_risk_runtime` não existe (rode `roles.sql`) ou o login de migração herda a role de runtime (use outro login).
- **Logs ausentes de métricas:** `RISK_LOG_LEVEL=warn|error` suprime `metric.*`.

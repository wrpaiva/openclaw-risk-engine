# Segurança operacional

Resumo das proteções existentes e dos riscos residuais. Base: SPEC §11.1, ADR-0003, ADR-0008, ADR-0010. Rede/TLS: ADR-0011 (Aceito em 2026-11-15: O2, overlay dedicada e cifrada; mecanismo de bind implementado, deploy não aprovado).

## Somente paper

- Sem credencial de exchange/corretora, nem como variável opcional. O `loadConfig` recusa `RISK_ENVIRONMENT` diferente de `PAPER` e recusa subir se qualquer variável de ambiente tiver nome com padrão de credencial de exchange/corretora (inclui `*_KEY`, `*_PASSWORD`, `*_TOKEN`, `*SECRET*`). A tabela `risk_accounts` só aceita `environment = 'PAPER'`.
- `ALLOW_PAPER` só existe após `COMMIT` com reserva persistida; falhas resultam em não autorização. Hoje, só `BLOCK` (fontes `Unconfigured`).

## Privilégio mínimo no banco

- **Duas roles:** `openclaw_risk_owner` (dona do schema; executa migrações) e `openclaw_risk_runtime` (grupo NOLOGIN; o login de runtime herda dela). `roles.sql` revoga `CREATE` em `public` de `PUBLIC`.
- **Grants das migrações `0003`/`0004`** (única fonte do que o runtime tem):
  - `SELECT` em `risk_accounts`, `risk_policies`, `risk_access_grants`, `schema_migrations`;
  - `SELECT, INSERT` em `trade_proposals`, `risk_decisions`, `risk_audit_events`, `risk_outbox`, `risk_reservations`;
  - `UPDATE (status, closed_at, paper_order_id)` em `risk_reservations`;
  - (migração `0004`) `SELECT` em `risk_operational_state` (estado de reconciliação pós-restauração); o histórico `risk_operational_state_history` não tem grant ao runtime; escrita só pela conta de migração (CLI `reconcile-after-restore`/`mark-restore-pending`);
  - nenhum `DELETE`, `TRUNCATE`, `TRIGGER` ou `REFERENCES`; sem `CREATE` em `public`.
- **Imutabilidade:** triggers rejeitam `UPDATE`/`DELETE` em propostas, decisões, auditoria, políticas e grants (exceto as transições permitidas de reserva, desativação de política e revogação de grant). A `0003` adiciona triggers `BEFORE TRUNCATE` nas oito tabelas (a `0004` faz o mesmo nas suas duas; a linha de estado não pode ser apagada), que barram até o superuser comum.
- **Risco residual:** `owner`, superuser ou quem tem `ALTER TABLE` pode **desabilitar ou remover triggers** e alterar histórico; os triggers protegem contra o runtime e contra erro, não contra o dono do schema. Mitigação: a credencial de migração (`openclaw_risk_owner`) só existe em **janela de deploy**, em contêiner one-shot; nunca no ambiente da app; acesso de DBA/superuser a esta base é uma decisão de governança do usuário (a definir).
- **Autoverificação no boot:** o servidor inspeciona o login conectado antes de ouvir e **não sobe** (exit 1) se houver superuser, `BYPASSRLS`, `CREATEROLE`, `CREATEDB`, `REPLICATION`, dono de relação, `CREATE` em `public`, `CREATE` ou `TEMP` no banco (`CREATE_ON_DATABASE`, `TEMP_ON_DATABASE`; o `roles.sql` revoga `TEMP` de `PUBLIC`), dono de schema ou `CREATE` em qualquer schema além de `pg_catalog`/`information_schema` (`OWNS_OR_CREATES_IN_SCHEMA`), `SELECT` em `risk_operational_state_history`, membro de `openclaw_risk_owner` ou qualquer grant além do das migrações `0003`/`0004`. A conexão do runtime fixa `search_path=public` (opção de startup), para que um schema criado por terceiros ou o schema do próprio usuário não sombreie tabelas ou funções. A readiness repete a checagem. `verify-runtime-privileges` faz a mesma checagem on demand.
- **Separação de ambientes:** o servidor recusa `RISK_MIGRATION_*` no ambiente; as CLIs do operador (`migrate`, `reconcile-after-restore`, `mark-restore-pending`) usam só `RISK_MIGRATION_DATABASE_URL(_FILE)` e **exigem** `RISK_DB_CONNECTION_TIMEOUT_MS`, `RISK_DB_STATEMENT_TIMEOUT_MS` e `RISK_DB_LOCK_TIMEOUT_MS` (a credencial dona do schema nunca roda sem prazo). A `0003` recusa migrar com o login de runtime.
- **Futuras funções `SECURITY DEFINER` (regra):** hoje não existe nenhuma. Se uma migração criar, ela deve (1) declarar `SET search_path = public, pg_temp` (ou `pg_catalog, public`) na própria função, (2) fazer `REVOKE EXECUTE ... FROM PUBLIC` e conceder `EXECUTE` só a quem precisa, (3) qualificar objetos, e (4) vir acompanhada de uma checagem no `PgPrivilegeInspector` (ex.: runtime não é dono nem pode executar funções definer além do conjunto aprovado) e de teste de integração. Sem isso, a migração não deve ser aceita.
- **`pg_hba.conf` (a confirmar na instância):** as roles `openclaw_risk_owner`, `openclaw_risk_runtime` e seus logins **não** podem ter linha `trust`; use autenticação por senha (`scram-sha-256`) e restrinja origem. Verificar antes do deploy; é decisão de infraestrutura do usuário.
- **Segredo da URL de banco:** em produção prefira `RISK_DATABASE_URL_FILE`/`RISK_MIGRATION_DATABASE_URL_FILE`. A URL direta em variável de ambiente aparece em `docker inspect` e em `/proc/<pid>/environ`; o arquivo montado (somente leitura, 0400 do uid de execução) não. No `test-e2e.sh` os segredos de teste são 0400 num diretório 0700 e os contêineres rodam com o uid do usuário do host.
- **Scripts locais de backup/restore/provisionamento:** recusam URL com `?`, `host=`, `hostaddr=`, `dbname=`, `service=` ou `%`, e validam a conexão efetiva (`current_database()` `*_test`, servidor em endereço local/privado) antes de qualquer escrita. Limite conhecido: Postgres em contêiner aparece com IP privado da bridge Docker, então o endereço privado é aceito; a trava forte continua sendo o nome `*_test` e o host da URL.

## Rede e transporte (D-10 / ADR-0011)

- Escopo `loopback` (default): bind só em IP literal de loopback (`127.0.0.0/8` ou `::1`). Escopo `private-network` (ADR-0011, O2): bind só em `0.0.0.0` (sem `::`), exigido junto de `RISK_HTTP_TRANSPORT=plaintext-encrypted-overlay`, que declara nominalmente HTTP e Bearer em texto claro dentro de overlay cifrada. Configuração ausente, parcial ou ambígua impede o boot (exit 2, mensagem fixa sem o valor recebido). `RISK_HTTP_TRANSPORT` com escopo loopback é rejeitado. O processo **não verifica** a cifragem da rede: a verificação é do checklist pré-deploy (`deploy.md`). Não há `ports:` publicados no exemplo de stack, e nenhum endpoint passa pelo Traefik.
- **Bearer sem TLS só é aceitável em loopback ou em overlay dedicada e cifrada** (O2). O `sslmode` da conexão com o PostgreSQL será confirmado no deploy (fora desta implementação). Até a aprovação do deploy, o serviço não deve ser integrado ao OpenClaw.
- **Riscos residuais da O2:** (P1) o bind curinga escuta em **todas** as redes do contêiner; se o engine precisar de uma segunda rede para chegar ao Postgres compartilhado, o HTTP fica alcançável pelos serviços dessa rede, protegido só por Bearer e grants agente×conta. Decidir no deploy: aceitar, isolar o acesso ao banco, ou bind por interface/sub-rede (exigiria novo ADR substituindo o 0011). Um serviço indevido anexado à rede transacional também alcança o HTTP: mitigado por rede dedicada, Bearer por principal (tokens rotacionáveis) e nenhuma porta publicada. O Bearer trafega em claro dentro da overlay.
- **Segundo nó no Swarm:** hoje há um único nó e o tráfego não sai do host. Se um segundo nó for adicionado, revisar o ADR-0011 e a cifragem da overlay (`--opt encrypted`) passa a ser obrigatória.
- Rate-limit, limite de conexões e TLS de borda não existem no processo (decisão: rate-limit na borda). Limites do processo: corpo máximo e timeouts configuráveis (valores a definir). **Pendente de decisão (ADR-0011 / usuário):** TLS e `sslmode` da conexão com o PostgreSQL (S2) e limites HTTP adicionais, como máximo de conexões/cabeçalhos e keep-alive (S5). Métodos com corpo (POST/PUT/PATCH/DELETE) em 404/405 e 401/403 respondem com `Connection: close` e o socket é destruído, sem drenar o corpo.
- **`/health/ready` e carga:** a verificação é **single-flight**: chamadas concorrentes compartilham a mesma verificação em voo (sem cache nem TTL). Risco remanescente: o endpoint é público (sem auth) e, com a sondagem em voo, cada nova rodada ainda abre conexões do pool (uma por check); um chamador em laço contínuo mantém o pool e o banco ocupados em ritmo de uma verificação por vez, competindo com o tráfego real. A mitigação definitiva (limite de taxa, restrição de origem, cache com TTL) é de borda/decisão do usuário.
- `/health/*` não exige autenticação e devolve só o status e os quatro checks (`ok`/`fail`), sem versão, hostname nem mensagens.

## Autenticação e tokens

- Identidade vem da conexão autenticada (Bearer opaco por principal `AGENT` ou `PAPER_EXECUTOR`). `agentId` divergente no payload é rejeitado antes de gravar qualquer coisa. O `Authorization` é avaliado antes de ler o corpo.
- O arquivo `RISK_PRINCIPALS_FILE` guarda **só hashes SHA-256** (nunca tokens). A comparação usa `timingSafeEqual` contra todos os hashes. Qualquer erro no arquivo impede o boot.
- **Gerar token:** `sh scripts/generate-principal-token.sh` imprime, uma vez, um token de 256 bits e seu `tokenSha256`; nada é gravado em arquivo. Entregue o token ao cliente por canal seguro e coloque só o hash no secret.
- **Rotação com múltiplos hashes:** `tokenSha256` é um array. Para rotacionar: (1) gere um novo token; (2) adicione o novo hash ao array do principal, mantendo o antigo; (3) atualize o secret e **reinicie** o processo (o arquivo é lido uma vez no boot; não há recarga); (4) migre o cliente para o novo token; (5) remova o hash antigo, atualize o secret e reinicie de novo. O mesmo hash não pode se repetir entre principals.
- Papéis: avaliação exige `AGENT` com grant na conta; consume/release exigem `PAPER_EXECUTOR` com grant (consume) ou grant na conta da reserva (release). Grants são linhas em `risk_access_grants`, revogáveis por `revoked_at`; inseridos hoje por SQL (D-08).
- Os IDs dos agentes ainda são fixtures (`fixture-agent-1` a `fixture-agent-7`).

## Logs e dados

- Logs em JSON com **allowlist de campos**: não saem headers, corpo, token, credencial, prompt, payload de agente nem `error.message` do `pg`. Strings são truncadas e caracteres de controle escapados. As mensagens da CLI e do boot são fixas.
- Auditoria registra só metadados. 403 por falta de grant e 422 de contrato inválido ficam **só em log**, sem gravar em `risk_audit_events` (decisão do usuário).
- **Retenção** de logs, decisões e auditoria: **a definir** (SPEC §7.3); nenhum prazo foi inventado. Nada é apagado automaticamente: as tabelas são append-only.

## Imagem e execução

- Base `node:22-bookworm-slim` fixada por digest; multi-stage; só dependências de produção (`npm ci --omit=dev`); `NODE_ENV=production`.
- Roda como **uid/gid 1000, não-root**; o processo não escreve em disco, então funciona com `--read-only` e sem tmpfs; no exemplo, `cap_drop: [ALL]` e `no-new-privileges`.
- `.dockerignore` exclui testes, docs, scripts, `.env*` e `.claude` da imagem. Segredos entram só por arquivos montados (`RISK_*_FILE`), legíveis pelo uid 1000.
- Imagem local, sem registry. Atualizar a base: ver o cabeçalho do `Dockerfile` (reconstruir e rodar `npm run test:e2e`).
- O runtime **não leva** `npm`, `npx`, `corepack` nem `yarn` (removidos do estágio final): `HEALTHCHECK`, `ENTRYPOINT` e a CLI usam só `node`. Isso elimina as dependências embutidas do `npm` como superfície.
- **Resultados de varredura (2026-11-14, autorizados pelo usuário, Q15):**
  - `npm audit`: produção **0** vulnerabilidades; desenvolvimento **7 moderadas** (`minimatch` via `typescript-eslint`), não explorável (só ferramenta de build/lint, fora da imagem).
  - `trivy` (imagem via `docker save`): **0 segredos, 0 misconfigurações**. CVEs do SO Debian: 1 CRITICAL (`zlib`/minizip, `will_not_fix`) e 38 HIGH sem correção disponível, não exploráveis no contexto (sem entrada de arquivos zip nem processo privilegiado). CVEs do `npm` embutido na base: **eliminadas** pela remoção do npm da imagem (S1); o líder decide se repete o trivy para confirmar.
  - **Rebuild periódico** com novo digest da base (ver o cabeçalho do `Dockerfile`) e nova varredura; a periodicidade é decisão do usuário.

## Backup (ADR-0012)

- **Cifragem `age` com chave pública na VPS e privada fora dela**: um invasor da VPS não lê backups; **a perda da chave privada torna os backups irrecuperáveis** (custódia a definir, U9). Nunca coloque a identidade na VPS nem na imagem.
- **Credencial de backup**: login próprio somente leitura (membro só de `openclaw_risk_backup`; nunca de owner/runtime); o job recusa, antes de gravar, login com SUPERUSER/CREATEROLE/CREATEDB/REPLICATION/BYPASSRLS, membro (direto ou transitivo, com ou sem INHERIT) de qualquer role além de `openclaw_risk_backup`, dono do banco, de schema ou de objeto, e privilégio de escrita, USAGE em sequência ou CREATE (schema/banco). Barreira de login, não substitui a revisão do provisionamento (`default_transaction_read_only` é só recomendação: o próprio login pode desligá-lo na sessão).
- **Segredos só em arquivos**: `pgpass`, `age_recipients`, `rclone.conf` em 0400 num diretório 0700 do uid do cron, montados somente leitura em `/run/secrets`. Nada de senha ou chave em argv, variável de ambiente, `docker inspect` ou log. O job só loga linhas JSON fixas (sem stderr bruto das ferramentas).
- **Sem dump em claro em disco**: `pg_dump | age -o`; o arquivo parcial já é cifrado e só é publicado (sem sobrescrever) depois de validado.
- **Contêiner**: `--read-only` (sem `tmpfs`), `--cap-drop ALL`, `no-new-privileges`, uid do host, sem portas; só a rede Docker necessária.
- **Bucket**: credencial de envio sem listar/apagar quando o provedor permitir; o job nunca apaga no bucket (retenção por ciclo de vida do provedor).
- **Restauração cifrada** (`restore-encrypted-local.sh`): `.sha256` obrigatório e conferido antes de decifrar; a decifragem roda em contêiner `--network none`; o dump em claro existe só no pipe; só alvo `*_test` local.
- Esta rotina é só paper e não toca exchange/corretora; nenhuma credencial desse tipo é lida ou aceita.

## O que continua proibido

Tocar `openclaw-trading_openclaw`, `pixel-agents_web`, `pixel-events_receiver`, o PostgreSQL/Redis de produção ou o Traefik; criar serviço Swarm sem aprovação; usar o canal `pixel-events` para propostas; colocar lógica de risco em `/opt/pixel-agents-trading` ou no receiver.

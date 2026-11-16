#!/bin/sh
# E2E da imagem (SPEC §9.4): Postgres 14 descartável + migração e aplicação PELA IMAGEM, depois `vitest run tests/e2e`.
# Pré-requisito: imagem local construída (npm run image:build). Nada é publicado fora de 127.0.0.1; nenhum serviço Swarm; usa uma rede bridge --internal por ciclo (com label) além do loopback.
#
# Variáveis exportadas para os testes (tests/e2e):
#   RISK_E2E_BASE_URL            http://127.0.0.1:<porta da app>
#   RISK_E2E_DATABASE_URL        superuser de TESTE do banco descartável (postgres://...@127.0.0.1:<porta>/openclaw_risk_e2e_test)
#   RISK_E2E_APP_CONTAINER       nome do contêiner da app (docker kill/stop/start/restart nos testes)
#   RISK_E2E_DB_CONTAINER        nome do contêiner do banco (docker stop/start nos testes de indisponibilidade)
#   RISK_E2E_IMAGE               tag da imagem em teste
#   RISK_E2E_LABEL               label exclusiva DESTE ciclo (com.openclaw-risk-engine.e2e-run=<pid>); o teardown remove só por ela
#   RISK_E2E_AGENT_TOKEN         Bearer do principal AGENT de fixture (principalId=RISK_E2E_AGENT_ID)
#   RISK_E2E_AGENT_ID            principalId do agente de fixture
#   RISK_E2E_EXECUTOR_TOKEN      Bearer do principal PAPER_EXECUTOR de fixture (principalId=RISK_E2E_EXECUTOR_ID)
#   RISK_E2E_EXECUTOR_ID         principalId do executor de fixture
#   RISK_E2E_RUNTIME_DATABASE_URL  URL do login de runtime (testes de privilégio; só teste)
#   RISK_E2E_NETWORK             rede bridge --internal do ciclo (ADR-0011); sem rota externa, sem publicação de portas
#   RISK_E2E_DB_ALIAS            alias do banco nessa rede (porta interna 5432)
#   RISK_E2E_SECRETS_DIR         diretório dos segredos do ciclo; inclui runtime_database_url_net (host = alias, porta interna)
# Tokens e senhas são aleatórios por execução e vivem só no ambiente do vitest e em arquivos temporários removidos no fim.
# A app principal roda com --network host (loopback), --read-only, segredos em /run/secrets (somente leitura), com o MESMO uid:gid do usuário
# do host (o login que executa este script; o teste de imagem espera uid 1000, que é o uid padrão da imagem). Os arquivos de
# segredo são 0400 no diretório 0700 do usuário: outros usuários do host não os leem (nem durante o ciclo).
# Trava: o banco é local e termina em _test. Teardown (trap) remove apenas recursos com a label por ciclo (e2e-run=<pid>):
# nunca mata contêineres de backup/restore manuais nem de outro ciclo e2e.
set -eu
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
IMAGE="openclaw-risk-engine:${VERSION}"
LABEL_KV="com.openclaw-risk-engine.e2e-run=$$"
GENERIC_LABEL="com.openclaw-risk-engine.test=1"
RUN_USER="$(id -u):$(id -g)"
DB_NAME=openclaw-risk-e2e-db
NET_NAME=openclaw-risk-e2e-net-$$
DB_ALIAS=openclaw-risk-e2e-db-net
APP_NAME=openclaw-risk-e2e-app
DB_PORT=${RISK_E2E_DB_PORT:-55442}
APP_PORT=${RISK_E2E_APP_PORT:-55443}
DB=openclaw_risk_e2e_test
PGIMAGE=postgres:14-alpine

docker image inspect "$IMAGE" >/dev/null 2>&1 || { echo "imagem $IMAGE não existe; rode: npm run image:build" >&2; exit 1; }
[ -d tests/e2e ] || { echo "tests/e2e não existe ainda (criado pelo tester); nada a executar" >&2; E2E_EMPTY=1; }
E2E_EMPTY=${E2E_EMPTY:-0}

# Trava de banco: local e *_test.
case "$DB" in *_test) ;; *) echo "recusado: banco deve terminar em _test" >&2; exit 1 ;; esac
for p in "$DB_PORT" "$APP_PORT"; do
  # Fail-closed: só segue se conseguir escutar na porta em 127.0.0.1 (livre); qualquer erro aborta antes de criar recursos.
  node -e "const s=require('node:net').createServer();s.on('error',()=>process.exit(1));s.listen(Number(process.argv[1]),'127.0.0.1',()=>s.close(()=>process.exit(0)))" "$p" || { echo "porta $p já em uso" >&2; exit 1; }
done
for n in "$DB_NAME" "$APP_NAME"; do
  if [ -n "$(docker ps -a -q --filter "name=^${n}$")" ]; then echo "contêiner $n já existe; remova-o manualmente se for seu" >&2; exit 1; fi
done

if [ -n "$(docker network ls -q --filter "name=^${NET_NAME}$")" ]; then echo "rede $NET_NAME já existe; remova-a manualmente se for sua" >&2; exit 1; fi

SECRETS=$(mktemp -d)
cleanup() {
  # Só recursos com a label exclusiva deste projeto: primeiro os contêineres, depois as redes do ciclo.
  ids=$(docker ps -a -q --filter "label=$LABEL_KV" 2>/dev/null || true)
  [ -z "$ids" ] || docker rm -f $ids >/dev/null 2>&1 || true
  nets=$(docker network ls -q --filter "label=$LABEL_KV" 2>/dev/null || true)
  [ -z "$nets" ] || docker network rm $nets >/dev/null 2>&1 || true
  rm -rf "$SECRETS"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

rand() { node -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('hex'))"; }
PG_SUPER_PW=$(rand); OWNER_PW=$(rand); RUNTIME_PW=$(rand)
AGENT_TOKEN=$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))")
EXEC_TOKEN=$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))")
AGENT_ID=agent-e2e-01
EXEC_ID=executor-e2e-01

# Rede bridge interna (sem rota externa) para os testes de rede privada; a regressão principal segue em --network host.
docker network create --driver bridge --internal --label "$LABEL_KV" --label "$GENERIC_LABEL" "$NET_NAME" >/dev/null

docker run -d --name "$DB_NAME" --label "$LABEL_KV" --label "$GENERIC_LABEL" \
  -p "127.0.0.1:${DB_PORT}:5432" --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_USER=risk_e2e_admin -e "POSTGRES_PASSWORD=$PG_SUPER_PW" -e "POSTGRES_DB=$DB" \
  "$PGIMAGE" >/dev/null
i=0
until docker exec "$DB_NAME" pg_isready -h 127.0.0.1 -U risk_e2e_admin -d "$DB" >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -gt 60 ] && { echo "banco e2e não ficou pronto" >&2; exit 1; }
  sleep 1
done
# O entrypoint reinicia o servidor após o init; confirma estabilidade com uma consulta real.
until docker exec "$DB_NAME" psql -h 127.0.0.1 -U risk_e2e_admin -d "$DB" -Atc 'select 1' >/dev/null 2>&1; do sleep 1; done

docker network connect --alias "$DB_ALIAS" "$NET_NAME" "$DB_NAME"

PSQL="docker exec -i $DB_NAME psql -h 127.0.0.1 -U risk_e2e_admin -d $DB -v ON_ERROR_STOP=1 -q"
$PSQL -v dbname="$DB" <scripts/provision/roles.sql >/dev/null
$PSQL >/dev/null <<SQL
CREATE ROLE e2e_migrator LOGIN INHERIT PASSWORD '$OWNER_PW' IN ROLE openclaw_risk_owner;
CREATE ROLE e2e_runtime LOGIN INHERIT PASSWORD '$RUNTIME_PW' IN ROLE openclaw_risk_runtime;
SQL

DBHOST="127.0.0.1:${DB_PORT}"
umask 077
printf '%s\n' "postgres://e2e_migrator:${OWNER_PW}@${DBHOST}/${DB}" >"$SECRETS/migration_database_url"
printf '%s\n' "postgres://e2e_runtime:${RUNTIME_PW}@${DBHOST}/${DB}" >"$SECRETS/runtime_database_url"
printf '%s\n' "postgres://e2e_runtime:${RUNTIME_PW}@${DB_ALIAS}:5432/${DB}" >"$SECRETS/runtime_database_url_net"
node -e "
const c=require('node:crypto');const h=t=>c.createHash('sha256').update(t,'utf8').digest('hex');
process.stdout.write(JSON.stringify({version:1,principals:[
 {principalId:process.argv[1],kind:'AGENT',tokenSha256:[h(process.argv[2])]},
 {principalId:process.argv[3],kind:'PAPER_EXECUTOR',tokenSha256:[h(process.argv[4])]}]}));
" "$AGENT_ID" "$AGENT_TOKEN" "$EXEC_ID" "$EXEC_TOKEN" >"$SECRETS/principals.json"
chmod 0700 "$SECRETS"; chmod 0400 "$SECRETS"/*

echo "== migrate (pela imagem, credencial de migração)"
docker run --rm --label "$LABEL_KV" --label "$GENERIC_LABEL" --user "$RUN_USER" --network host --read-only --cap-drop ALL --security-opt no-new-privileges \
  -v "$SECRETS:/run/secrets:ro" \
  -e RISK_ENVIRONMENT=PAPER -e RISK_MIGRATION_DATABASE_URL_FILE=/run/secrets/migration_database_url \
  -e RISK_DB_CONNECTION_TIMEOUT_MS=2000 -e RISK_DB_STATEMENT_TIMEOUT_MS=5000 -e RISK_DB_LOCK_TIMEOUT_MS=2000 \
  --entrypoint node "$IMAGE" dist/interfaces/cli/main.js migrate

echo "== app (pela imagem, credencial de runtime)"
docker run -d --name "$APP_NAME" --label "$LABEL_KV" --label "$GENERIC_LABEL" --user "$RUN_USER" --network host --read-only --cap-drop ALL \
  --security-opt no-new-privileges -v "$SECRETS:/run/secrets:ro" \
  -e RISK_ENVIRONMENT=PAPER -e RISK_DATABASE_URL_FILE=/run/secrets/runtime_database_url \
  -e RISK_LOG_LEVEL=info -e RISK_CLOCK_SKEW_TOLERANCE_MS=1000 \
  -e RISK_DB_CONNECTION_TIMEOUT_MS=2000 -e RISK_DB_STATEMENT_TIMEOUT_MS=5000 -e RISK_DB_LOCK_TIMEOUT_MS=2000 \
  -e RISK_HTTP_ENABLED=true -e RISK_HTTP_HOST=127.0.0.1 -e "RISK_HTTP_PORT=$APP_PORT" \
  -e RISK_HTTP_MAX_BODY_BYTES=65536 -e RISK_HTTP_REQUEST_TIMEOUT_MS=10000 -e RISK_HTTP_HEADERS_TIMEOUT_MS=5000 \
  -e RISK_PRINCIPALS_FILE=/run/secrets/principals.json \
  "$IMAGE" >/dev/null

BASE="http://127.0.0.1:${APP_PORT}"
i=0
until [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/health/ready" || true)" = "200" ]; do
  i=$((i + 1))
  if [ "$i" -gt 60 ] || [ "$(docker inspect -f '{{.State.Running}}' "$APP_NAME" 2>/dev/null)" != "true" ]; then
    echo "app não ficou ready; últimas linhas do log (mensagens fixas, sem segredos):" >&2
    docker logs --tail 20 "$APP_NAME" >&2 || true
    exit 1
  fi
  sleep 1
done
echo "app ready em $BASE"

if [ "$E2E_EMPTY" = 1 ]; then
  echo "tests/e2e ausente: ciclo (banco, migração, app ready, teardown) executado sem testes"
  exit 0
fi

RISK_E2E_BASE_URL="$BASE" \
RISK_E2E_DATABASE_URL="postgres://risk_e2e_admin:${PG_SUPER_PW}@${DBHOST}/${DB}" \
RISK_E2E_RUNTIME_DATABASE_URL="postgres://e2e_runtime:${RUNTIME_PW}@${DBHOST}/${DB}" \
RISK_E2E_APP_CONTAINER="$APP_NAME" RISK_E2E_DB_CONTAINER="$DB_NAME" RISK_E2E_IMAGE="$IMAGE" RISK_E2E_LABEL="$LABEL_KV" \
RISK_E2E_NETWORK="$NET_NAME" RISK_E2E_DB_ALIAS="$DB_ALIAS" RISK_E2E_SECRETS_DIR="$SECRETS" \
RISK_E2E_AGENT_ID="$AGENT_ID" RISK_E2E_AGENT_TOKEN="$AGENT_TOKEN" \
RISK_E2E_EXECUTOR_ID="$EXEC_ID" RISK_E2E_EXECUTOR_TOKEN="$EXEC_TOKEN" \
  npx vitest run tests/e2e --no-file-parallelism --testTimeout=60000 --hookTimeout=60000 "$@"

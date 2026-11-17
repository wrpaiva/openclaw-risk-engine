#!/bin/bash
# Testes do job de backup (ADR-0012): sobe um postgres:14 Debian e um S3-compatível LOCAL de teste (versitygw), ambos por digest,
# prepara roles/migrações/grants/chaves e executa `vitest run tests/backup`. Nada toca produção nem recursos sem label.
#   npm run test:backup            (ou: bash scripts/test-backup.sh [args extras do vitest])
# Pré-requisitos (docker pull deliberado, uma vez; o script NUNCA baixa imagens):
#   postgres:14-bookworm@sha256:a54c8b1e143b22f16b0fd3e249e9297a6f08828a143ee7108b1b5ca51f352765
#   versity/versitygw@sha256:8319a530d08d537426e2f855bae5280709795dc73a3f0c347973ef915d6343c5
#   openclaw-risk-backup:<version do package.json>   (npm run image:build:backup)
# Portas (127.0.0.1): RISK_BACKUP_TEST_DB_PORT (padrão 55452) e RISK_BACKUP_TEST_S3_PORT (padrão 55453); o script recusa
# se a porta for inválida, repetida ou estiver ocupada. Não colide com test-db (55432) nem com e2e (55442/55443).
#
# Recursos Docker: labels com.openclaw-risk-engine.test=1 e com.openclaw-risk-engine.backup-test-run=<pid>. O teardown (trap) remove
# SÓ por essa label do ciclo (contêineres e rede) e também contêineres do job com a label com.openclaw-risk-engine.backup=<banco de teste>
# (valor exclusivo deste teste). Nunca prune. O diretório temporário do ciclo (0700) é apagado no fim.
#
# ===== Interface para tests/backup (variáveis exportadas ao vitest; TUDO é só de teste, valores aleatórios por ciclo) =====
#   RISK_BACKUP_TEST_REPO_ROOT        raiz do repositório
#   RISK_BACKUP_TEST_LABEL            label do ciclo (chave=valor): com.openclaw-risk-engine.backup-test-run=<pid>
#   RISK_BACKUP_TEST_GENERIC_LABEL    com.openclaw-risk-engine.test=1 (use as DUAS labels em qualquer recurso que o teste criar)
#   RISK_BACKUP_TEST_JOB_LABEL        com.openclaw-risk-engine.backup=<RISK_BACKUP_TEST_DB> (label que backup-prod.sh põe no contêiner do job)
#   RISK_BACKUP_TEST_DB               banco de teste (openclaw_risk_backup_test), já com roles, migrações e grants de backup
#   RISK_BACKUP_TEST_ADMIN_URL        postgres://<superuser de teste>:<senha>@127.0.0.1:<porta>/<RISK_BACKUP_TEST_DB>
#   RISK_BACKUP_TEST_ADMIN_URL_BASE   postgres://<superuser de teste>:<senha>@127.0.0.1:<porta>  (acrescente /<banco>_test para criar/restaurar outro banco)
#   RISK_BACKUP_TEST_DB_PORT / RISK_BACKUP_TEST_S3_PORT   portas publicadas em 127.0.0.1
#   RISK_BACKUP_TEST_DB_CONTAINER / RISK_BACKUP_TEST_S3_CONTAINER   nomes dos contêineres (docker stop/start nos testes de falha)
#   RISK_BACKUP_TEST_NETWORK          rede bridge --internal do ciclo (sem rota externa); o job roda nela
#   RISK_BACKUP_TEST_DB_ALIAS         alias do banco nessa rede (porta interna 5432)
#   RISK_BACKUP_TEST_S3_ALIAS         alias do S3 nessa rede (porta interna 7070)
#   RISK_BACKUP_TEST_S3_ENDPOINT      http://127.0.0.1:<porta>   (do host)
#   RISK_BACKUP_TEST_S3_ENDPOINT_NET  http://<alias>:7070        (de dentro da rede do ciclo; é o endpoint do rclone.conf)
#   RISK_BACKUP_TEST_S3_ACCESS_KEY / RISK_BACKUP_TEST_S3_SECRET_KEY   credencial raiz do S3 de teste (versitygw; sem restrição de list/delete)
#   RISK_BACKUP_TEST_S3_BUCKET        bucket já criado (vazio)
#   RISK_BACKUP_TEST_S3_PREFIX        prefixo usado pelo backup
#   RISK_BACKUP_TEST_BACKUP_LOGIN     login de backup (membro SÓ de openclaw_risk_backup, default_transaction_read_only=on)
#   RISK_BACKUP_TEST_BACKUP_PASSWORD  senha desse login (só teste; para o T6 procurar vazamento em ps/inspect/logs)
#   RISK_BACKUP_TEST_IMAGE            imagem do job (openclaw-risk-backup:<version>)
#   RISK_BACKUP_TEST_PG_IMAGE / RISK_BACKUP_TEST_S3_IMAGE   imagens por digest
#   RISK_BACKUP_TEST_WORKDIR          diretório do ciclo (0700), apagado no fim; coloque ali os artefatos dos testes
#   RISK_BACKUP_TEST_RCLONE_CONTIMEOUT / _TIMEOUT / _RETRIES / _LOW_LEVEL_RETRIES   valores de TESTE (pequenos) gravados no CONFIG_FILE; o job exige
#                                     RISK_BACKUP_RCLONE_{CONTIMEOUT,TIMEOUT,RETRIES,LOW_LEVEL_RETRIES} (sem default): ao rodar a imagem direto, passe -e com estes valores
#   RISK_BACKUP_TEST_BACKUP_DIR       diretório de saída dos backups cifrados (0700, vazio); é o RISK_BACKUP_DIR de backup-prod.sh
#   RISK_BACKUP_TEST_SECRETS_DIR      0700, arquivos 0400: pgpass (host = alias da rede), age_recipients (chave pública de teste), rclone.conf (remote risk-backup)
#   RISK_BACKUP_TEST_CONFIG_FILE      backup.env VÁLIDO para backup-prod.sh (usa os diretórios, imagem, rede, banco, bucket e prefixo acima)
#   RISK_BACKUP_TEST_AGE_KEYS_DIR     0700 com: identity.txt (0400, identidade privada de teste), recipient.txt (pública),
#                                     identity-wrong.txt (0400) e recipient-wrong.txt (outro par, para testes de chave errada)
#   RISK_BACKUP_TEST_AGE_IDENTITY_FILE / RISK_BACKUP_TEST_AGE_IDENTITY_WRONG_FILE   caminhos de identity.txt / identity-wrong.txt
#   RISK_BACKUP_TEST_AGE_RECIPIENT / RISK_BACKUP_TEST_AGE_RECIPIENT_WRONG           strings age1... (conteúdo de recipient*.txt)
# Como rodar o backup contra o banco de teste (a partir do host, sem docker manual):
#     bash "$RISK_BACKUP_TEST_REPO_ROOT/scripts/backup-prod.sh" "$RISK_BACKUP_TEST_CONFIG_FILE"
#   Para variar a configuração, copie o arquivo e altere linhas CHAVE=VALOR (diretório de secrets/backup deve continuar 0700; secrets 0400).
#   Para stubs (pg_dump/age/rclone/date), rode a imagem direto, com as labels do ciclo para o teardown achá-la:
#     docker run --rm --label "$RISK_BACKUP_TEST_LABEL" --label "$RISK_BACKUP_TEST_GENERIC_LABEL" --user "$(id -u):$(id -g)"
#       --network "$RISK_BACKUP_TEST_NETWORK" -v <dir de saída>:/out -v <secrets>:/run/secrets:ro -v <stubs>:/stubs:ro
#       -e PATH=/stubs:/usr/lib/postgresql/14/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
#       -e RISK_BACKUP_EXPECTED_DB=... -e RISK_BACKUP_S3_BUCKET=... -e RISK_BACKUP_S3_PREFIX=...
#       -e RISK_BACKUP_RCLONE_CONTIMEOUT=... -e RISK_BACKUP_RCLONE_TIMEOUT=... -e RISK_BACKUP_RCLONE_RETRIES=... -e RISK_BACKUP_RCLONE_LOW_LEVEL_RETRIES=... --entrypoint /usr/local/bin/backup-job.sh "$RISK_BACKUP_TEST_IMAGE"
# Restauração cifrada: RISK_RESTORE_URL="$RISK_BACKUP_TEST_ADMIN_URL_BASE/<novo>_test" RISK_RESTORE_AGE_IDENTITY_FILE="$RISK_BACKUP_TEST_AGE_IDENTITY_FILE"
#   bash scripts/restore-encrypted-local.sh <arquivo.dump.age>   (o banco <novo>_test deve existir e estar vazio; crie-o via ADMIN_URL_BASE/postgres).
# Se tests/backup não existir, o ciclo (infra, bucket, grants, chaves, teardown) roda sem testes.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO_ROOT=$PWD

VERSION=$(node -p "require('./package.json').version")
IMAGE="openclaw-risk-backup:${VERSION}"
PG_IMAGE=postgres:14-bookworm@sha256:a54c8b1e143b22f16b0fd3e249e9297a6f08828a143ee7108b1b5ca51f352765
S3_IMAGE=versity/versitygw@sha256:8319a530d08d537426e2f855bae5280709795dc73a3f0c347973ef915d6343c5
LABEL_KV="com.openclaw-risk-engine.backup-test-run=$$"
GENERIC_LABEL="com.openclaw-risk-engine.test=1"
DB=openclaw_risk_backup_test
JOB_LABEL="com.openclaw-risk-engine.backup=$DB"
DB_PORT=${RISK_BACKUP_TEST_DB_PORT:-55452}
S3_PORT=${RISK_BACKUP_TEST_S3_PORT:-55453}
DB_CONTAINER=openclaw-risk-backup-test-db
S3_CONTAINER=openclaw-risk-backup-test-s3
JOB_CONTAINER=openclaw-risk-backup-$DB
NET_NAME=openclaw-risk-backup-test-net-$$
DB_ALIAS=openclaw-risk-backup-test-db-net
S3_ALIAS=openclaw-risk-backup-test-s3-net
BUCKET=openclaw-risk-backup-test-bucket
PREFIX=risk-backup-test
ADMIN=risk_backup_test_admin
BACKUP_LOGIN=risk_backup_test_login
MIGRATOR=risk_backup_test_migrator
# Valores de TESTE (não são valores de produção; U5 decide os de produção).
RC_CONTIMEOUT=3s
RC_TIMEOUT=10s
RC_RETRIES=1
RC_LL_RETRIES=1

for v in "$DB_PORT" "$S3_PORT"; do [[ "$v" =~ ^[0-9]+$ && "$v" -ge 1024 && "$v" -le 65535 ]] || { echo "porta inválida" >&2; exit 1; }; done
[[ "$DB_PORT" != "$S3_PORT" ]] || { echo "RISK_BACKUP_TEST_DB_PORT e RISK_BACKUP_TEST_S3_PORT devem ser diferentes" >&2; exit 1; }
for p in "$DB_PORT" "$S3_PORT"; do
  # Fail-closed: só segue se conseguir escutar a porta em 127.0.0.1 (livre); qualquer erro aborta antes de criar recursos.
  node -e "const s=require('node:net').createServer();s.on('error',()=>process.exit(1));s.listen(Number(process.argv[1]),'127.0.0.1',()=>s.close(()=>process.exit(0)))" "$p" || { echo "porta $p já em uso" >&2; exit 1; }
done
for img in "$IMAGE" "$PG_IMAGE" "$S3_IMAGE"; do
  docker image inspect "$img" >/dev/null 2>&1 || { echo "imagem ausente localmente: $img (este script não baixa imagens; veja os pré-requisitos no topo)" >&2; exit 1; }
done
for n in "$DB_CONTAINER" "$S3_CONTAINER" "$JOB_CONTAINER"; do
  [[ -z "$(docker ps -a -q --filter "name=^${n}\$")" ]] || { echo "contêiner $n já existe; remova-o manualmente se for seu" >&2; exit 1; }
done
[[ -z "$(docker network ls -q --filter "name=^${NET_NAME}\$")" ]] || { echo "rede $NET_NAME já existe" >&2; exit 1; }

umask 077
WORK=$(mktemp -d)
chmod 0700 "$WORK"
cleanup() {
  # Só por label do ciclo (contêineres e rede) e pelo contêiner do job deste banco de teste.
  local ids nets
  ids=$(docker ps -a -q --filter "label=$LABEL_KV" 2>/dev/null || true)
  [[ -z "$ids" ]] || docker rm -f -v $ids >/dev/null 2>&1 || true
  ids=$(docker ps -a -q --filter "label=$JOB_LABEL" 2>/dev/null || true)
  [[ -z "$ids" ]] || docker rm -f -v $ids >/dev/null 2>&1 || true
  nets=$(docker network ls -q --filter "label=$LABEL_KV" 2>/dev/null || true)
  [[ -z "$nets" ]] || docker network rm $nets >/dev/null 2>&1 || true
  [[ -z "${WORK:-}" ]] || rm -rf "${WORK:?}"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

rand() { node -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('hex'))"; }
ADMIN_PW=$(rand); OWNER_PW=$(rand); BACKUP_PW=$(rand); S3_ACCESS=$(rand); S3_SECRET=$(rand)

BACKUP_DIR="$WORK/backups"; SECRETS_DIR="$WORK/secrets"; KEYS_DIR="$WORK/age-keys"; MIG_DIR="$WORK/migration"
mkdir -m 0700 "$BACKUP_DIR" "$SECRETS_DIR" "$KEYS_DIR" "$MIG_DIR"

# ---- chaves age de teste (geradas pela própria imagem; a identidade privada fica só em $KEYS_DIR, 0400) ----
genkey() { # arquivo-identidade arquivo-recipient
  local idf="$KEYS_DIR/$1" rcf="$KEYS_DIR/$2" full="$KEYS_DIR/$1.full"
  docker run --rm --pull never --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
    --label "$GENERIC_LABEL" --label "$LABEL_KV" --entrypoint age-keygen "$IMAGE" >"$full" 2>/dev/null
  grep -v '^#' "$full" >"$idf"
  sed -n 's/^# public key: //p' "$full" >"$rcf"
  rm -f "${full:?}"
  chmod 0400 "$idf" "$rcf"
}
genkey identity.txt recipient.txt
genkey identity-wrong.txt recipient-wrong.txt

# ---- rede interna + banco + S3 ----
docker network create --driver bridge --internal --label "$LABEL_KV" --label "$GENERIC_LABEL" "$NET_NAME" >/dev/null
docker run -d --name "$DB_CONTAINER" --label "$LABEL_KV" --label "$GENERIC_LABEL" \
  -p "127.0.0.1:${DB_PORT}:5432" --tmpfs /var/lib/postgresql/data \
  -e "POSTGRES_USER=$ADMIN" -e "POSTGRES_PASSWORD=$ADMIN_PW" -e "POSTGRES_DB=$DB" "$PG_IMAGE" >/dev/null
docker run -d --name "$S3_CONTAINER" --label "$LABEL_KV" --label "$GENERIC_LABEL" \
  -p "127.0.0.1:${S3_PORT}:7070" --tmpfs /data \
  -e "ROOT_ACCESS_KEY=$S3_ACCESS" -e "ROOT_SECRET_KEY=$S3_SECRET" \
  "$S3_IMAGE" --port :7070 posix --nometa /data >/dev/null
docker network connect --alias "$DB_ALIAS" "$NET_NAME" "$DB_CONTAINER"
docker network connect --alias "$S3_ALIAS" "$NET_NAME" "$S3_CONTAINER"

i=0
until docker exec "$DB_CONTAINER" pg_isready -h 127.0.0.1 -U "$ADMIN" -d "$DB" >/dev/null 2>&1; do
  i=$((i + 1)); [[ "$i" -le 60 ]] || { echo "banco de teste não ficou pronto" >&2; exit 1; }
  sleep 1
done
# O entrypoint reinicia o servidor após o init; confirma estabilidade com uma consulta real.
until docker exec "$DB_CONTAINER" psql -h 127.0.0.1 -U "$ADMIN" -d "$DB" -Atc 'select 1' >/dev/null 2>&1; do sleep 1; done
i=0
until curl -s -o /dev/null "http://127.0.0.1:${S3_PORT}/"; do
  i=$((i + 1)); [[ "$i" -le 60 ]] || { echo "S3 de teste não ficou pronto" >&2; exit 1; }
  sleep 1
done

# ---- provisionamento do banco: roles, migrações (dono), grants de backup e login de backup somente leitura ----
PSQL=(docker exec -i "$DB_CONTAINER" psql -h 127.0.0.1 -U "$ADMIN" -d "$DB" -v ON_ERROR_STOP=1 -q)
"${PSQL[@]}" -v dbname="$DB" <scripts/provision/roles.sql >/dev/null
"${PSQL[@]}" >/dev/null <<SQL
CREATE ROLE $MIGRATOR LOGIN INHERIT PASSWORD '$OWNER_PW' IN ROLE openclaw_risk_owner;
SQL
printf '%s\n' "postgres://${MIGRATOR}:${OWNER_PW}@127.0.0.1:${DB_PORT}/${DB}" >"$MIG_DIR/migration_database_url"
chmod 0400 "$MIG_DIR/migration_database_url"
npm run build >/dev/null
# Ambiente limpo (env -i): a config da app rejeita variáveis com padrão de credencial presentes no ambiente do operador.
env -i PATH="$PATH" RISK_ENVIRONMENT=PAPER RISK_MIGRATION_DATABASE_URL_FILE="$MIG_DIR/migration_database_url" \
  RISK_DB_CONNECTION_TIMEOUT_MS=2000 RISK_DB_STATEMENT_TIMEOUT_MS=5000 RISK_DB_LOCK_TIMEOUT_MS=2000 \
  node dist/interfaces/cli/main.js migrate >/dev/null
"${PSQL[@]}" <scripts/provision/backup-grants.sql >/dev/null   # reaplicado após cada migrate (checklist de deploy)
"${PSQL[@]}" >/dev/null <<SQL
CREATE ROLE $BACKUP_LOGIN LOGIN INHERIT PASSWORD '$BACKUP_PW' IN ROLE openclaw_risk_backup;
ALTER ROLE $BACKUP_LOGIN SET default_transaction_read_only = on;
SQL

# ---- secrets do job (0400 em diretório 0700), configuração de backup-prod.sh ----
printf '%s\n' "${DB_ALIAS}:5432:${DB}:${BACKUP_LOGIN}:${BACKUP_PW}" >"$SECRETS_DIR/pgpass"
cp "$KEYS_DIR/recipient.txt" "$SECRETS_DIR/age_recipients"
cat >"$SECRETS_DIR/rclone.conf" <<CONF
[risk-backup]
type = s3
provider = Other
env_auth = false
access_key_id = $S3_ACCESS
secret_access_key = $S3_SECRET
endpoint = http://${S3_ALIAS}:7070
region = us-east-1
CONF
chmod 0400 "$SECRETS_DIR/pgpass" "$SECRETS_DIR/age_recipients" "$SECRETS_DIR/rclone.conf"
CONFIG_FILE="$WORK/backup.env"
cat >"$CONFIG_FILE" <<CONF
RISK_BACKUP_EXPECTED_DB=$DB
RISK_BACKUP_DIR=$BACKUP_DIR
RISK_BACKUP_SECRETS_DIR=$SECRETS_DIR
RISK_BACKUP_S3_BUCKET=$BUCKET
RISK_BACKUP_S3_PREFIX=$PREFIX
RISK_BACKUP_IMAGE=$IMAGE
RISK_BACKUP_DOCKER_NETWORK=$NET_NAME
RISK_BACKUP_RCLONE_CONTIMEOUT=$RC_CONTIMEOUT
RISK_BACKUP_RCLONE_TIMEOUT=$RC_TIMEOUT
RISK_BACKUP_RCLONE_RETRIES=$RC_RETRIES
RISK_BACKUP_RCLONE_LOW_LEVEL_RETRIES=$RC_LL_RETRIES
CONF

# ---- bucket de teste (criado fora do job: o job nunca cria bucket) ----
docker run --rm --pull never --label "$LABEL_KV" --label "$GENERIC_LABEL" --user "$(id -u):$(id -g)" --network "$NET_NAME" \
  --read-only --cap-drop ALL --security-opt no-new-privileges -v "$SECRETS_DIR:/run/secrets:ro" \
  --entrypoint rclone "$IMAGE" --config /run/secrets/rclone.conf mkdir "risk-backup:${BUCKET}" >/dev/null
echo "infra de backup pronta (banco 127.0.0.1:${DB_PORT}, S3 127.0.0.1:${S3_PORT})"

if [[ ! -d tests/backup ]]; then
  echo "tests/backup ausente (criado pelo tester): ciclo (infra, bucket, grants, chaves, teardown) executado sem testes"
  exit 0
fi

export RISK_BACKUP_TEST_REPO_ROOT="$REPO_ROOT" RISK_BACKUP_TEST_LABEL="$LABEL_KV" RISK_BACKUP_TEST_GENERIC_LABEL="$GENERIC_LABEL" \
  RISK_BACKUP_TEST_JOB_LABEL="$JOB_LABEL" RISK_BACKUP_TEST_DB="$DB" \
  RISK_BACKUP_TEST_ADMIN_URL="postgres://${ADMIN}:${ADMIN_PW}@127.0.0.1:${DB_PORT}/${DB}" \
  RISK_BACKUP_TEST_ADMIN_URL_BASE="postgres://${ADMIN}:${ADMIN_PW}@127.0.0.1:${DB_PORT}" \
  RISK_BACKUP_TEST_DB_PORT="$DB_PORT" RISK_BACKUP_TEST_S3_PORT="$S3_PORT" \
  RISK_BACKUP_TEST_DB_CONTAINER="$DB_CONTAINER" RISK_BACKUP_TEST_S3_CONTAINER="$S3_CONTAINER" \
  RISK_BACKUP_TEST_NETWORK="$NET_NAME" RISK_BACKUP_TEST_DB_ALIAS="$DB_ALIAS" RISK_BACKUP_TEST_S3_ALIAS="$S3_ALIAS" \
  RISK_BACKUP_TEST_S3_ENDPOINT="http://127.0.0.1:${S3_PORT}" RISK_BACKUP_TEST_S3_ENDPOINT_NET="http://${S3_ALIAS}:7070" \
  RISK_BACKUP_TEST_S3_ACCESS_KEY="$S3_ACCESS" RISK_BACKUP_TEST_S3_SECRET_KEY="$S3_SECRET" \
  RISK_BACKUP_TEST_S3_BUCKET="$BUCKET" RISK_BACKUP_TEST_S3_PREFIX="$PREFIX" \
  RISK_BACKUP_TEST_RCLONE_CONTIMEOUT="$RC_CONTIMEOUT" RISK_BACKUP_TEST_RCLONE_TIMEOUT="$RC_TIMEOUT" \
  RISK_BACKUP_TEST_RCLONE_RETRIES="$RC_RETRIES" RISK_BACKUP_TEST_RCLONE_LOW_LEVEL_RETRIES="$RC_LL_RETRIES" \
  RISK_BACKUP_TEST_BACKUP_LOGIN="$BACKUP_LOGIN" RISK_BACKUP_TEST_BACKUP_PASSWORD="$BACKUP_PW" \
  RISK_BACKUP_TEST_IMAGE="$IMAGE" RISK_BACKUP_TEST_PG_IMAGE="$PG_IMAGE" RISK_BACKUP_TEST_S3_IMAGE="$S3_IMAGE" \
  RISK_BACKUP_TEST_WORKDIR="$WORK" RISK_BACKUP_TEST_BACKUP_DIR="$BACKUP_DIR" RISK_BACKUP_TEST_SECRETS_DIR="$SECRETS_DIR" \
  RISK_BACKUP_TEST_CONFIG_FILE="$CONFIG_FILE" RISK_BACKUP_TEST_AGE_KEYS_DIR="$KEYS_DIR" \
  RISK_BACKUP_TEST_AGE_IDENTITY_FILE="$KEYS_DIR/identity.txt" RISK_BACKUP_TEST_AGE_IDENTITY_WRONG_FILE="$KEYS_DIR/identity-wrong.txt" \
  RISK_BACKUP_TEST_AGE_RECIPIENT="$(cat "$KEYS_DIR/recipient.txt")" RISK_BACKUP_TEST_AGE_RECIPIENT_WRONG="$(cat "$KEYS_DIR/recipient-wrong.txt")"
npx vitest run tests/backup --no-file-parallelism --testTimeout=120000 --hookTimeout=120000 "$@"

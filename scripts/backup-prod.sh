#!/bin/bash
# Backup de PRODUÇÃO da base openclaw_risk (ADR-0012). Disparado pelo cron do host (deploy/backup/crontab.example, NÃO APLICADO).
#   bash scripts/backup-prod.sh /caminho/backup.env
# Roda um contêiner descartável da imagem openclaw-risk-backup (docker run --rm) que executa scripts/backup/backup-job.sh.
# NÃO executar em produção sem aprovação do usuário (credencial de backup, diretório, bucket e cron dependem do deploy).
#
# Arquivo de configuração (não secreto), linhas CHAVE=VALOR (sem aspas, sem expansão; não é "sourced"). Todas obrigatórias, sem default:
#   RISK_BACKUP_EXPECTED_DB       [A-Za-z0-9_]+ (nome da base; o job recusa se current_database() ou o pgpass divergirem)
#   RISK_BACKUP_DIR               diretório absoluto dos backups cifrados (existente, não symlink, dono = uid atual, 0700)
#   RISK_BACKUP_SECRETS_DIR       diretório absoluto dos secrets (idem; arquivos pgpass, age_recipients, rclone.conf em 0400)
#   RISK_BACKUP_S3_BUCKET         bucket S3-compatível (a definir no deploy)
#   RISK_BACKUP_S3_PREFIX         prefixo no bucket (a definir no deploy)
#   RISK_BACKUP_IMAGE             imagem local (docker image inspect precisa achá-la; --pull never)
#   RISK_BACKUP_DOCKER_NETWORK    rede Docker existente que alcança o PostgreSQL e o S3 (a definir no deploy)
# Segredos NUNCA em argv/env/log: vão por arquivos montados somente leitura em /run/secrets do contêiner.
# Códigos de saída: 0 OK | 2 configuração recusada (nada executado) | 3 outra execução em andamento (flock) | 4 falha de dump/cifragem/
#   publicação local, ou falha do docker | 5 cópia local OK, upload/verificação falhou | 6 retenção local falhou com backup OK.
set -euo pipefail
umask 077

CONF=${1:-}
[[ -n "$CONF" && "$#" -eq 1 ]] || { echo "uso: $0 <arquivo.env>" >&2; exit 2; }
[[ -f "$CONF" && ! -L "$CONF" && -r "$CONF" ]] || { echo "recusado: arquivo de configuração ausente, ilegível ou symlink" >&2; exit 2; }

declare -A CFG=()
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
  if [[ "$line" =~ ^(RISK_BACKUP_[A-Z0-9_]+)=([^[:space:]\"\'\$\`\\]*)$ ]]; then
    CFG["${BASH_REMATCH[1]}"]=${BASH_REMATCH[2]}
  else
    echo "recusado: linha inválida na configuração" >&2; exit 2
  fi
done <"$CONF"
for k in "${!CFG[@]}"; do
  case "$k" in
    RISK_BACKUP_EXPECTED_DB|RISK_BACKUP_DIR|RISK_BACKUP_SECRETS_DIR|RISK_BACKUP_S3_BUCKET|RISK_BACKUP_S3_PREFIX|RISK_BACKUP_IMAGE|RISK_BACKUP_DOCKER_NETWORK) ;;
    *) echo "recusado: chave desconhecida na configuração" >&2; exit 2 ;;
  esac
done
for k in RISK_BACKUP_EXPECTED_DB RISK_BACKUP_DIR RISK_BACKUP_SECRETS_DIR RISK_BACKUP_S3_BUCKET RISK_BACKUP_S3_PREFIX RISK_BACKUP_IMAGE RISK_BACKUP_DOCKER_NETWORK; do
  [[ -n "${CFG[$k]:-}" ]] || { echo "recusado: configuração incompleta ($k)" >&2; exit 2; }
done
DB=${CFG[RISK_BACKUP_EXPECTED_DB]}
BUCKET=${CFG[RISK_BACKUP_S3_BUCKET]}
PREFIX=${CFG[RISK_BACKUP_S3_PREFIX]}
DIR=${CFG[RISK_BACKUP_DIR]}
SECRETS=${CFG[RISK_BACKUP_SECRETS_DIR]}
IMAGE=${CFG[RISK_BACKUP_IMAGE]}
NETWORK=${CFG[RISK_BACKUP_DOCKER_NETWORK]}
[[ "$DB" =~ ^[A-Za-z0-9_]+$ ]] || { echo "recusado: nome de banco inválido" >&2; exit 2; }
[[ "$BUCKET" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ && "$BUCKET" != *..* ]] || { echo "recusado: bucket inválido" >&2; exit 2; }
[[ "$PREFIX" =~ ^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$ && "$PREFIX" != *..* ]] || { echo "recusado: prefixo inválido" >&2; exit 2; }
[[ "$IMAGE" =~ ^[A-Za-z0-9][A-Za-z0-9._/:@-]*$ ]] || { echo "recusado: imagem inválida" >&2; exit 2; }
[[ "$NETWORK" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { echo "recusado: rede inválida" >&2; exit 2; }

UID_NOW=$(id -u)
check_dir() { # caminho modo-esperado
  local p=$1 want=$2
  [[ "$p" == /* && "$p" != *..* ]] || return 1
  [[ -d "$p" && ! -L "$p" ]] || return 1
  [[ "$(stat -c '%u %a' "$p")" == "$UID_NOW $want" ]] || return 1
}
check_dir "$DIR" 700 || { echo "recusado: RISK_BACKUP_DIR deve ser absoluto, existente, não symlink, do uid atual e 0700" >&2; exit 2; }
check_dir "$SECRETS" 700 || { echo "recusado: RISK_BACKUP_SECRETS_DIR deve ser absoluto, existente, não symlink, do uid atual e 0700" >&2; exit 2; }
[[ "$DIR" != "$SECRETS" ]] || { echo "recusado: diretórios de backup e de secrets devem ser distintos" >&2; exit 2; }
for f in pgpass age_recipients rclone.conf; do
  p="$SECRETS/$f"
  [[ -f "$p" && ! -L "$p" && "$(stat -c '%u %a' "$p")" == "$UID_NOW 400" ]] || { echo "recusado: secret $f ausente ou fora de 0400 do uid atual" >&2; exit 2; }
done
docker image inspect "$IMAGE" >/dev/null 2>&1 || { echo "recusado: imagem de backup não existe localmente" >&2; exit 2; }
docker network inspect "$NETWORK" >/dev/null 2>&1 || { echo "recusado: rede Docker inexistente" >&2; exit 2; }

# Uma execução por vez.
exec 9>"$DIR/.lock"
flock -n 9 || { echo "outra execução de backup em andamento" >&2; exit 3; }

NAME="openclaw-risk-backup-$DB"
LABEL="com.openclaw-risk-engine.backup=$DB"
cleanup() {
  # Só o contêiner deste job (nome fixo E label); nada mais.
  local ids
  ids=$(docker ps -a -q --filter "name=^${NAME}\$" --filter "label=$LABEL" 2>/dev/null || true)
  [[ -z "$ids" ]] || docker rm -f -v $ids >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM
if [[ -n "$(docker ps -a -q --filter "name=^${NAME}\$")" ]]; then echo "recusado: contêiner $NAME já existe" >&2; exit 2; fi

export RISK_BACKUP_EXPECTED_DB="$DB" RISK_BACKUP_S3_BUCKET="$BUCKET" RISK_BACKUP_S3_PREFIX="$PREFIX"
set +e
docker run --rm --pull never --name "$NAME" --label "$LABEL" \
  --user "$UID_NOW:$(id -g)" --read-only --cap-drop ALL --security-opt no-new-privileges \
  --network "$NETWORK" \
  -v "$DIR:/out" -v "$SECRETS:/run/secrets:ro" \
  -e RISK_BACKUP_EXPECTED_DB -e RISK_BACKUP_S3_BUCKET -e RISK_BACKUP_S3_PREFIX \
  --entrypoint /usr/local/bin/backup-job.sh "$IMAGE" 9>&-
rc=$?
set -e
case "$rc" in 0|2|4|5|6) exit "$rc" ;; *) echo "falha do docker ou código inesperado ($rc)" >&2; exit 4 ;; esac

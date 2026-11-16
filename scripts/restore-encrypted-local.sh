#!/bin/bash
# Restauração de um backup CIFRADO (ADR-0012) em um banco NOVO, VAZIO, LOCAL e *_test. Só ensaio/teste de recuperação;
# produção segue o procedimento aprovado de docs/operacao/backup-restauracao.md. Nunca rode com a chave privada na VPS:
# o ensaio é feito na estação do operador, que fornece a identidade age.
#   RISK_RESTORE_URL=postgres://admin:senha@127.0.0.1:PORTA/<novo>_test \
#   RISK_RESTORE_AGE_IDENTITY_FILE=/caminho/identidade.txt \
#     bash scripts/restore-encrypted-local.sh /caminho/<banco>-<UTC>.dump.age
# Requisitos: <arquivo>.sha256 ao lado (obrigatório; conferido ANTES de decifrar); identidade 0400/0600 do uid atual
# (lida só pelo contêiner, somente leitura; nunca copiada); imagem local openclaw-risk-backup (RISK_RESTORE_AGE_IMAGE, ou a
# versão do package.json). O dump em claro existe apenas no pipe: `age -d` (contêiner --network none, --read-only, sem
# capabilities) | restore-local.sh - . Etapas após o pg_restore, mesmos travamentos e mensagens de restore-local.sh.
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
ROOT=$PWD
IN=${1:?uso: RISK_RESTORE_URL=... RISK_RESTORE_AGE_IDENTITY_FILE=... $0 <arquivo.dump.age>}
: "${RISK_RESTORE_URL:?defina RISK_RESTORE_URL}"
: "${RISK_RESTORE_AGE_IDENTITY_FILE:?defina RISK_RESTORE_AGE_IDENTITY_FILE}"
. "$ROOT/scripts/lib/guard-url.sh"
guard_url_syntax "$RISK_RESTORE_URL" || exit 1
case "$db" in *_test) ;; *) echo "recusado: banco deve terminar em _test" >&2; exit 1 ;; esac
case "$IN" in /*) ;; *) IN="$PWD/$IN" ;; esac
ID=$RISK_RESTORE_AGE_IDENTITY_FILE
case "$ID" in /*) ;; *) echo "recusado: identidade deve ser caminho absoluto" >&2; exit 1 ;; esac
[[ -f "$IN" && ! -L "$IN" && -r "$IN" ]] || { echo "recusado: arquivo cifrado ausente, ilegível ou symlink" >&2; exit 1; }
[[ "$IN" == *.dump.age ]] || { echo "recusado: o arquivo deve terminar em .dump.age" >&2; exit 1; }
[[ -f "$ID" && ! -L "$ID" ]] || { echo "recusado: identidade ausente ou symlink" >&2; exit 1; }
case "$(stat -c '%u %a' "$ID")" in "$(id -u) 400"|"$(id -u) 600") ;; *) echo "recusado: identidade deve ser do uid atual e 0400/0600" >&2; exit 1 ;; esac
SHA="$IN.sha256"
[[ -f "$SHA" && ! -L "$SHA" && -r "$SHA" ]] || { echo "recusado: .sha256 ausente (obrigatório)" >&2; exit 1; }
[[ $(wc -l <"$SHA") -eq 1 ]] || { echo "recusado: .sha256 inválido" >&2; exit 1; }
read -r want_hash want_name <"$SHA" || true
[[ "$want_hash" =~ ^[0-9a-f]{64}$ && "$want_name" == "$(basename "$IN")" ]] || { echo "recusado: .sha256 inválido" >&2; exit 1; }
got_hash=$(sha256sum <"$IN")
[[ "${got_hash%% *}" == "$want_hash" ]] || { echo "recusado: checksum diverge; arquivo corrompido ou adulterado" >&2; exit 1; }

VERSION=$(node -p "require('./package.json').version")
AGE_IMAGE=${RISK_RESTORE_AGE_IMAGE:-openclaw-risk-backup:${VERSION}}
docker image inspect "$AGE_IMAGE" >/dev/null 2>&1 || { echo "recusado: imagem $AGE_IMAGE não existe (npm run image:build:backup)" >&2; exit 1; }

RUN_LABEL="com.openclaw-risk-engine.restore-decrypt-run=$$"
cleanup() {
  local ids
  ids=$(docker ps -a -q --filter "label=$RUN_LABEL" 2>/dev/null || true)
  [[ -z "$ids" ]] || docker rm -f -v $ids >/dev/null 2>&1 || true
}
trap cleanup EXIT
decrypt() {
  docker run --rm --label com.openclaw-risk-engine.test=1 --label "$RUN_LABEL" --pull never \
    --user "$(id -u):$(id -g)" --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
    -v "$IN:/in/dump.age:ro" -v "$ID:/run/identity/key:ro" \
    --entrypoint age "$AGE_IMAGE" -d -i /run/identity/key /in/dump.age
}

# Pré-checagem: decifra só o início (no pipe) para falhar ANTES de o restore-local.sh provisionar roles/revogar CONNECT.
set +o pipefail
magic=$(decrypt 2>/dev/null | head -c 5)
set -o pipefail
[[ "$magic" == "PGDMP" ]] || { echo "recusado: não foi possível decifrar com a identidade fornecida (ou o conteúdo não é um dump custom)" >&2; exit 1; }

decrypt | sh "$ROOT/scripts/restore-local.sh" -

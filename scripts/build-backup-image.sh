#!/bin/sh
# Constrói a imagem LOCAL openclaw-risk-backup:<version do package.json>. Não publica em registry.
#   sh scripts/build-backup-image.sh
# Usa --pull=false: a base (postgres:14-bookworm@sha256:...) precisa estar no daemon local (docker pull deliberado, uma vez).
set -eu
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
TAG="openclaw-risk-backup:${VERSION}"
[ "$#" -eq 0 ] || { echo "uso: $0" >&2; exit 2; }
docker build --builder default --pull=false -f Dockerfile.backup --build-arg "VERSION=${VERSION}" -t "$TAG" .
echo "imagem construída: $TAG"

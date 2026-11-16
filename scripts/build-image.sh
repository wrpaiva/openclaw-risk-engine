#!/bin/sh
# Constrói a imagem LOCAL openclaw-risk-engine:<version do package.json>. Não publica em registry.
#   sh scripts/build-image.sh            só constrói
#   sh scripts/build-image.sh --save     também grava build/openclaw-risk-engine-<version>.tar (docker save)
set -eu
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
TAG="openclaw-risk-engine:${VERSION}"
SAVE=0
case "${1:-}" in
  "") ;;
  --save) SAVE=1 ;;
  *) echo "uso: $0 [--save]" >&2; exit 2 ;;
esac
# builder "default" (driver docker) para que a imagem fique no daemon local sem --load/push
docker build --builder default --pull=false --build-arg "VERSION=${VERSION}" -t "$TAG" .
echo "imagem construída: $TAG"
if [ "$SAVE" = 1 ]; then
  mkdir -p build
  docker save -o "build/openclaw-risk-engine-${VERSION}.tar" "$TAG"
  echo "tar: build/openclaw-risk-engine-${VERSION}.tar"
fi

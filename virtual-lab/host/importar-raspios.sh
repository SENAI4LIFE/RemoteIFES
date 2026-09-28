#!/usr/bin/env bash
# Imports the root filesystem of a pinned Raspberry Pi OS Lite image (raspios.json) as the local Docker
# image raspios-lite:<arm64|armhf>. Only the userland is used: no Raspberry Pi kernel, firmware or boot.
#
#   LAB_HOST_DESCARTAVEL=1 bash virtual-lab/host/importar-raspios.sh arm64
#
# Disposable hosts only (a CI runner): it loop-mounts the image read-only with sudo and adds an image to
# the Docker daemon. The downloaded archive is checked against the pinned sha256 before anything else.
set -euo pipefail

[ "${LAB_HOST_DESCARTAVEL:-}" = "1" ] || { echo "disposable host only (LAB_HOST_DESCARTAVEL=1)"; exit 2; }
ARQ="${1:-}"
case "$ARQ" in
  arm64) PLATAFORMA=linux/arm64 ;;
  armhf) PLATAFORMA=linux/arm/v7 ;;
  *) echo "usage: $0 arm64|armhf"; exit 2 ;;
esac
DIR="$(cd "$(dirname "$0")" && pwd)"
campo() { ARQ="$ARQ" CAMPO="$1" node -e 'const m = require(process.argv[1]); console.log(m[process.env.ARQ][process.env.CAMPO])' "$DIR/raspios.json"; }
URL=$(campo url)
SHA=$(campo sha256)
[[ "$SHA" =~ ^[0-9a-f]{64}$ ]] || { echo "invalid pinned sha256"; exit 1; }

TRAB="${RAIZ_RASPIOS:-${RUNNER_TEMP:-/tmp}/raspios}/$ARQ"
mkdir -p "$TRAB"
cd "$TRAB"
if ! { [ -f imagem.img.xz ] && echo "$SHA  imagem.img.xz" | sha256sum -c --status; }; then
  curl -fsSL --retry 3 -o imagem.img.xz "$URL"
fi
echo "$SHA  imagem.img.xz" | sha256sum -c -
xz -dkfT0 imagem.img.xz

# The root filesystem is the second partition (the first is the FAT boot partition).
INICIO=$(sfdisk -J imagem.img | node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => console.log(JSON.parse(s).partitiontable.partitions[1].start))')
[[ "$INICIO" =~ ^[0-9]+$ ]] || { echo "could not locate the root partition"; exit 1; }
mkdir -p raiz
sudo mount -o loop,ro,offset=$((INICIO * 512)) imagem.img raiz
trap 'sudo umount "$TRAB/raiz" 2>/dev/null || true; rm -f "$TRAB/imagem.img"' EXIT
grep -qE '^ID=(debian|raspbian)$' raiz/etc/os-release
grep -E '^(PRETTY_NAME|VERSION_CODENAME)=' raiz/etc/os-release
sudo tar -C raiz --numeric-owner -cf - . | docker import --platform "$PLATAFORMA" - "raspios-lite:$ARQ"
docker image inspect "raspios-lite:$ARQ" --format '{{.Os}}/{{.Architecture}} {{.Size}}'

#!/usr/bin/env bash
# Raspberry Pi OS Lite (armhf: the 32-bit userland a Raspberry Pi 3 runs) under qemu-user on an x64
# runner, without systemd. ./server.sh (and through it setup.sh) installs Node for armv7l; the server then
# runs with simulated boards that receive and confirm commands; a backup is taken with it running, restored
# with it stopped, and the data verified after a restart.
#
#   LAB_HOST_DESCARTAVEL=1 bash virtual-lab/host/raspios-armhf.sh <results dir>
#
# Evidence: 32-bit ARM userland, Node armv7l and node:sqlite on it, the install path. Not evidence:
# systemd on 32-bit Pi OS, real Pi 3 speed (every instruction is emulated) or any Raspberry Pi hardware.
set -euo pipefail

[ "${LAB_HOST_DESCARTAVEL:-}" = "1" ] || { echo "disposable host only (LAB_HOST_DESCARTAVEL=1)"; exit 2; }
RAIZ_REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SAIDA="${1:?results directory}"
mkdir -p "$SAIDA"
SAIDA="$(cd "$SAIDA" && pwd)"

docker run --rm --platform linux/arm/v7 --memory=1g --memory-swap=1g \
  -v "$RAIZ_REPO:/src:ro" -v "$SAIDA:/saida" raspios-lite:armhf bash -euo pipefail -c '
    export DEBIAN_FRONTEND=noninteractive
    faltam=""
    for c in curl xz tar python3; do command -v "$c" >/dev/null || faltam="$faltam $c"; done
    if [ -n "$faltam" ]; then
      apt-get -o Acquire::Retries=5 update -qq && apt-get -o Acquire::Retries=5 install -y -qq curl ca-certificates xz-utils python3 >/dev/null
    fi
    { grep -E "^(PRETTY_NAME|VERSION_CODENAME)=" /etc/os-release; uname -m; getconf LONG_BIT; } | tee /saida/sistema.txt
    cp -a /src /opt/RemoteIFES
    cd /opt/RemoteIFES
    ./server.sh --preparar 2>&1 | tail -25
    ./server.sh --verificar | tail -3
    cd remoteifes-server
    node -e "console.log(process.version, process.arch, process.platform)" | tee -a /saida/sistema.txt
    [ "$(node -p process.arch)" = "arm" ] || { echo "Node is not the 32-bit ARM build"; exit 1; }

    export NODE_ENV=development PORTA=8099 BIND_ADDR=127.0.0.1 REMOTEIFES_DATA_DIR=/tmp/dados SENHA_ADMIN_INICIAL=armhf-ensaio-senha-forte BACKUP_AUTOMATICO=false
    SENHA=$SENHA_ADMIN_INICIAL
    subir() { node server.js > /saida/servidor-$1.log 2>&1 & echo $! > /tmp/servidor.pid; }
    parar() { kill "$(cat /tmp/servidor.pid)"; while kill -0 "$(cat /tmp/servidor.pid)" 2>/dev/null; do sleep 1; done; }

    subir 1
    node test/support/verificar-implantacao.js --base http://127.0.0.1:8099 --senha "$SENHA" --marcar --dispositivos 2 | tee /saida/verificacao-1.json
    node backup-db.js armhf-ensaio 2>&1 | tail -3
    BACKUP=$(ls -t /tmp/dados/backups/*-armhf-ensaio.db | head -n1)
    parar
    node restore-backup.js "$BACKUP" --sim 2>&1 | tail -5
    subir 2
    node test/support/verificar-implantacao.js --base http://127.0.0.1:8099 --senha "$SENHA" --exigir-marca --dispositivos 1 | tee /saida/verificacao-2.json
    parar
    echo "armhf: install, service, simulated boards, backup, restore and restart verified"
  ' 2>&1 | tee "$SAIDA/raspios-armhf.log"

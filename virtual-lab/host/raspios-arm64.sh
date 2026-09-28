#!/usr/bin/env bash
# Raspberry Pi OS Lite (arm64) userland as a systemd container on a native ARM64 runner, limited to
# 1 GiB of RAM and two CPUs, running the project's own deployment rehearsal inside it
# (remoteifes-server/ensaio-implantacao.sh: install with setup.sh, service, restart, deploy and rollback,
# backup and restore, nginx, HTTPS configuration up to certificate issuance, Console .deb, removal).
#
#   LAB_HOST_DESCARTAVEL=1 bash virtual-lab/host/raspios-arm64.sh <results dir>
#
# Evidence: Raspberry Pi OS packages, systemd and filesystem layout. Not evidence: the Raspberry Pi
# kernel, firmware, boot, SD card or real Pi performance (the container shares the runner's kernel).
set -euo pipefail

[ "${LAB_HOST_DESCARTAVEL:-}" = "1" ] || { echo "disposable host only (LAB_HOST_DESCARTAVEL=1)"; exit 2; }
[ "$(uname -m)" = "aarch64" ] || { echo "needs a native ARM64 host"; exit 2; }
RAIZ_REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SAIDA="${1:?results directory}"
mkdir -p "$SAIDA"
NOME=raspios-arm64-ensaio

docker rm -f "$NOME" >/dev/null 2>&1 || true
# Units for a first boot on real Pi hardware with a console (the new-user prompt, SSH key and EEPROM
# jobs, swap file, consoles) have nothing to do in a container and would keep boot from finishing.
MASCARAR="userconfig.service systemd-firstboot.service regenerate_ssh_host_keys.service sshswitch.service rpi-eeprom-update.service dphys-swapfile.service rpi-resize.service getty@tty1.service serial-getty@ttyAMA0.service console-setup.service keyboard-setup.service"
docker run -d --name "$NOME" --hostname raspberrypi --privileged --cgroupns=host \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock \
  --memory=1g --memory-swap=1g --cpus=2 -e MASCARAR="$MASCARAR" \
  raspios-lite:arm64 /bin/sh -c 'for u in $MASCARAR; do ln -sf /dev/null "/etc/systemd/system/$u"; done; exec /sbin/init' >/dev/null
trap 'docker rm -f "$NOME" >/dev/null 2>&1 || true' EXIT

estado=""
for _ in $(seq 1 90); do
  estado=$(docker exec "$NOME" systemctl is-system-running 2>/dev/null || true)
  case "$estado" in running|degraded) break ;; esac
  sleep 2
done
echo "systemd in the container: $estado"
if [ "$estado" != running ] && [ "$estado" != degraded ]; then
  docker exec "$NOME" systemctl list-jobs --no-pager || true
  echo "systemd did not finish booting in the container"
  exit 1
fi
docker exec "$NOME" systemctl --failed --no-legend --no-pager > "$SAIDA/unidades-com-falha-no-boot.txt" 2>&1 || true
docker exec "$NOME" bash -c 'grep -E "^(PRETTY_NAME|VERSION_CODENAME)=" /etc/os-release; uname -m; systemctl --version | head -1; free -m' | tee "$SAIDA/sistema.txt"

docker exec "$NOME" bash -euc 'export DEBIAN_FRONTEND=noninteractive; apt-get -o Acquire::Retries=5 update -qq; apt-get -o Acquire::Retries=5 install -y -qq git curl ca-certificates sudo >/dev/null'
docker exec "$NOME" bash -euc 'useradd -m -s /bin/bash ensaio; echo "ensaio ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/ensaio; chmod 440 /etc/sudoers.d/ensaio'
# The checkout belongs to the account that runs the service: git refuses a repository owned by another.
docker cp "$RAIZ_REPO" "$NOME:/home/ensaio/RemoteIFES"
docker exec "$NOME" chown -R ensaio:ensaio /home/ensaio/RemoteIFES

set +e
docker exec "$NOME" sudo -u ensaio -H bash -c 'cd ~/RemoteIFES && sudo ENSAIO_HOST_DESCARTAVEL=1 bash remoteifes-server/ensaio-implantacao.sh' 2>&1 | tee "$SAIDA/ensaio-implantacao.log"
codigo=${PIPESTATUS[0]}
set -e
docker stats --no-stream --format '{{.Name}} mem {{.MemUsage}} cpu {{.CPUPerc}}' "$NOME" | tee "$SAIDA/recursos.txt"
docker exec "$NOME" bash -c 'node --version; nginx -v 2>&1; dpkg -l | grep -E "^ii +(nginx|systemd|sqlite3?) " || true' > "$SAIDA/versoes.txt" 2>&1 || true
docker exec "$NOME" journalctl -u remoteifes.service --no-pager 2>/dev/null | tail -200 > "$SAIDA/journal-remoteifes.txt" || true
echo "deployment rehearsal on Raspberry Pi OS arm64 userland: exit $codigo"
exit "$codigo"

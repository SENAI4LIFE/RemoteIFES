#!/usr/bin/env bash
set -e

if [ "$EUID" -ne 0 ]; then
  echo "Rode este script como root (sudo bash install-service.sh)."
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemd não encontrado neste sistema; este script requer systemctl (Linux com systemd, ex.: Raspberry Pi OS)."
  exit 1
fi

cd "$(dirname "$0")"
APP_DIR="$(pwd)"
RUN_USER="${SUDO_USER:-$(whoami)}"
NODE_BIN="$(command -v node || true)"

if [ -z "$NODE_BIN" ]; then
  echo "Node.js não encontrado no PATH. Rode ./setup.sh primeiro."
  exit 1
fi

if [ ! -f "$APP_DIR/.env" ]; then
  echo ".env não encontrado em $APP_DIR. Rode ./setup.sh primeiro."
  exit 1
fi

SERVICE_PATH="/etc/systemd/system/remoteifes.service"

cat > "$SERVICE_PATH" << EOF
[Unit]
Description=RemoteIFES - servidor central
After=network.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN --env-file-if-exists=.env server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable remoteifes.service
systemctl restart remoteifes.service

echo "Serviço remoteifes.service instalado, habilitado no boot e iniciado."
echo "Rodando como usuário: $RUN_USER"
echo "Status:  systemctl status remoteifes.service"
echo "Logs:    journalctl -u remoteifes.service -f"
echo "Reiniciar após alterar .env: sudo systemctl restart remoteifes.service"

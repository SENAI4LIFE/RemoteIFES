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

if grep -qE '^NODE_ENV=' .env; then
  sed -i 's/^NODE_ENV=.*/NODE_ENV=production/' .env
else
  echo 'NODE_ENV=production' >> .env
fi

DATA_DIR=$(grep -E '^REMOTEIFES_DATA_DIR=' .env | head -n1 | cut -d= -f2- | tr -d '[:space:]')
[ -z "$DATA_DIR" ] && DATA_DIR="$APP_DIR/data"
mkdir -p "$DATA_DIR"
chown -R "$RUN_USER" "$DATA_DIR" 2>/dev/null || true

SERVICE_PATH="/etc/systemd/system/remoteifes.service"

cat > "$SERVICE_PATH" << EOF
[Unit]
Description=RemoteIFES - servidor central
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN --env-file-if-exists=.env server.js
Restart=always
RestartSec=5
TimeoutStopSec=15
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full

[Install]
WantedBy=multi-user.target
EOF

HEALTH_SERVICE_PATH="/etc/systemd/system/remoteifes-health.service"
HEALTH_TIMER_PATH="/etc/systemd/system/remoteifes-health.timer"
RECOVER_SERVICE_PATH="/etc/systemd/system/remoteifes-recover.service"
SYSTEMCTL_BIN="$(command -v systemctl)"

cat > "$HEALTH_SERVICE_PATH" << EOF
[Unit]
Description=RemoteIFES - verificação de saúde
After=remoteifes.service
OnFailure=remoteifes-recover.service

[Service]
Type=oneshot
User=$RUN_USER
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/env bash $APP_DIR/health-watchdog.sh
EOF

cat > "$RECOVER_SERVICE_PATH" << EOF
[Unit]
Description=RemoteIFES - reinício de recuperação

[Service]
Type=oneshot
ExecStart=$SYSTEMCTL_BIN restart remoteifes.service
EOF

cat > "$HEALTH_TIMER_PATH" << EOF
[Unit]
Description=RemoteIFES - agenda a verificação de saúde

[Timer]
OnBootSec=2min
OnUnitActiveSec=2min
Unit=remoteifes-health.service

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable remoteifes.service
systemctl restart remoteifes.service
systemctl enable remoteifes-health.timer
systemctl restart remoteifes-health.timer

echo "Serviço remoteifes.service instalado, habilitado no boot e iniciado."
echo "Rodando como usuário: $RUN_USER"
echo "Dados persistentes em: $DATA_DIR"
echo "Watchdog de saúde: remoteifes-health.timer (reinicia o serviço após 3 falhas seguidas do /health)."
echo ""

redes_cli() {
  sudo -u "$RUN_USER" "$NODE_BIN" --env-file-if-exists="$APP_DIR/.env" "$APP_DIR/redes-autorizadas.js" "$@"
}

REDES=$(redes_cli 2>/dev/null | grep -E '^Redes autorizadas:' || true)
if echo "$REDES" | grep -q '(nenhuma)'; then
  echo "Nenhuma faixa de rede local autorizada está configurada."
  if [ -t 0 ]; then
    read -r -p "Faixa(s) de IP da rede local (CIDR, separadas por espaço) ou Enter para configurar depois: " FAIXAS || FAIXAS=""
    if [ -n "$FAIXAS" ]; then
      read -r -a FAIXAS_ARRAY <<< "$FAIXAS"
      redes_cli "${FAIXAS_ARRAY[@]}" || echo "não foi possível gravar as faixas agora; configure depois com: npm run redes -- <cidr>"
      systemctl restart remoteifes.service
    fi
  fi
  echo "Sem faixas e sem modo de teste, o acesso em produção fica bloqueado. Configure com: npm run redes -- 10.10.0.0/16"
fi

echo ""
echo "Status:  systemctl status remoteifes.service"
echo "Logs:    journalctl -u remoteifes.service -f"
echo "Saúde:   npm run health"
echo "Atualizar: bash deploy.sh        Reverter: bash rollback.sh"
echo "Reiniciar após alterar .env: sudo systemctl restart remoteifes.service"

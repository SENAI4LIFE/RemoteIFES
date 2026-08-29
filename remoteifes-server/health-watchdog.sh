#!/usr/bin/env bash
set -u

cd "$(dirname "$0")" || exit 1
APP_DIR="$(pwd)"

LIMITE="${WATCHDOG_LIMITE:-3}"

DATA_DIR=$(grep -E '^REMOTEIFES_DATA_DIR=' .env 2>/dev/null | head -n1 | cut -d= -f2- | tr -d '[:space:]')
[ -z "$DATA_DIR" ] && DATA_DIR="$APP_DIR/data"
mkdir -p "$DATA_DIR"
ESTADO="$DATA_DIR/.health-falhas"
LOCK="$DATA_DIR/.deploy-lock"

if [ -f "$LOCK" ] && [ "$(( $(date +%s) - $(stat -c %Y "$LOCK" 2>/dev/null || echo 0) ))" -lt 1800 ]; then
  exit 0
fi

if bash healthcheck.sh >/dev/null 2>&1; then
  [ -f "$ESTADO" ] && rm -f "$ESTADO"
  exit 0
fi

FALHAS=0
[ -f "$ESTADO" ] && FALHAS=$(cat "$ESTADO" 2>/dev/null || echo 0)
FALHAS=$((FALHAS + 1))
echo "$FALHAS" > "$ESTADO"
logger -t remoteifes-watchdog "health check falhou ($FALHAS/$LIMITE)" 2>/dev/null || true

if [ "$FALHAS" -ge "$LIMITE" ]; then
  rm -f "$ESTADO"
  logger -t remoteifes-watchdog "acionando recuperação após $FALHAS falhas" 2>/dev/null || true
  exit 1
fi

exit 0

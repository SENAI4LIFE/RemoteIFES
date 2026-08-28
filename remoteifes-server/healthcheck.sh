#!/usr/bin/env bash
set -u

cd "$(dirname "$0")"

PORTA_PADRAO=8080
PORTA="${PORTA:-}"
if [ -z "$PORTA" ] && [ -f .env ]; then
  PORTA=$(grep -E '^PORTA=' .env | head -n1 | cut -d= -f2 | tr -d '[:space:]')
fi
PORTA="${PORTA:-$PORTA_PADRAO}"

URL="http://127.0.0.1:${PORTA}/health"
CORPO=$(curl -fsS --max-time 5 "$URL" 2>/dev/null) || {
  echo "sem resposta de $URL"
  exit 1
}

echo "$CORPO"
case "$CORPO" in
  *'"ok":true'*) exit 0 ;;
  *) exit 1 ;;
esac

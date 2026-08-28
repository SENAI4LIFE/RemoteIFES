#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
APP_DIR="$(pwd)"

REF=""
OFFLINE=0
RESTART=1
for arg in "$@"; do
  case "$arg" in
    --offline) OFFLINE=1 ;;
    --no-restart) RESTART=0 ;;
    -h|--help)
      echo "Uso: bash rollback.sh [<ref>] [--offline] [--no-restart]"
      echo "  <ref>  versão para a qual voltar (padrão: data/previous-version gravado pelo deploy)"
      exit 0 ;;
    -*) echo "opção desconhecida: $arg"; exit 1 ;;
    *) REF="$arg" ;;
  esac
done

command -v git >/dev/null 2>&1 || { echo "git não encontrado no PATH."; exit 1; }
command -v node >/dev/null 2>&1 || { echo "node não encontrado no PATH."; exit 1; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "não é um repositório git."; exit 1; }

SYSTEMCTL="systemctl"
[ "$(id -u)" -ne 0 ] && SYSTEMCTL="sudo systemctl"
if [ "$RESTART" -eq 1 ] && ! $SYSTEMCTL cat remoteifes.service >/dev/null 2>&1; then
  echo "serviço remoteifes.service não encontrado. Use --no-restart."
  exit 1
fi

DATA_DIR=$(grep -E '^REMOTEIFES_DATA_DIR=' .env 2>/dev/null | head -n1 | cut -d= -f2- | tr -d '[:space:]')
[ -z "$DATA_DIR" ] && DATA_DIR="$APP_DIR/data"
DB_PATH=$(node --env-file-if-exists=.env -e 'process.stdout.write(require("./src/config/paths").CAMINHO_DB)')

if [ -z "$REF" ]; then
  [ -f "$DATA_DIR/previous-version" ] || { echo "nenhum $DATA_DIR/previous-version gravado; informe o ref explicitamente."; exit 1; }
  REF=$(tr -d '[:space:]' < "$DATA_DIR/previous-version")
fi

mkdir -p "$DATA_DIR"
LOCK="$DATA_DIR/.deploy-lock"
if [ -f "$LOCK" ] && [ "$(( $(date +%s) - $(stat -c %Y "$LOCK" 2>/dev/null || echo 0) ))" -ge 1800 ]; then
  rm -f "$LOCK"
fi
if ! ( set -o noclobber; echo "$$ $(date -Iseconds)" > "$LOCK" ) 2>/dev/null; then
  echo "outra atualização/rollback parece estar em andamento ($LOCK). Aguarde ou remova o arquivo se for resíduo."
  exit 1
fi
trap 'rm -f "$LOCK"' EXIT

[ "$OFFLINE" -eq 1 ] || git fetch --tags --prune origin >/dev/null 2>&1 || true

ALVO=$(git rev-parse --verify --quiet "${REF}^{commit}") || { echo "não foi possível resolver o ref '${REF}'."; exit 1; }
ANTES=$(git rev-parse HEAD)
if [ "$ALVO" = "$ANTES" ]; then
  echo "Já está em $ALVO. Nada a fazer."
  exit 0
fi

if [ -f "$DB_PATH" ]; then
  echo "Backup do banco antes do rollback..."
  node --env-file-if-exists=.env backup-db.js pre-rollback || { echo "backup falhou; abortando."; exit 1; }
fi

echo "Voltando de $ANTES para $ALVO..."
CUR_BRANCH=$(git symbolic-ref --quiet --short HEAD || echo "")
if [ "$CUR_BRANCH" = "main" ] && git merge-base --is-ancestor "$ALVO" main 2>/dev/null; then
  git reset --hard "$ALVO"
else
  git checkout --force --quiet "$ALVO"
  echo "Nota: HEAD destacado em $ALVO. Para voltar à linha principal: git checkout main"
fi

if git diff --name-only "$ANTES" "$ALVO" -- package.json package-lock.json | grep -q .; then
  echo "Dependências mudaram; rodando npm ci..."
  flags="--omit=dev --no-audit --no-fund"
  [ "$OFFLINE" -eq 1 ] && flags="$flags --offline"
  npm ci $flags || echo "npm ci falhou; mantendo node_modules atual."
else
  echo "Dependências inalteradas; pulando npm ci."
fi

if [ "$RESTART" -eq 0 ]; then
  echo "Código revertido para $ALVO. Serviço não reiniciado (--no-restart)."
  exit 0
fi

echo "Reiniciando remoteifes.service..."
$SYSTEMCTL restart remoteifes.service || echo "aviso: 'systemctl restart' retornou erro; verificando o /health mesmo assim."

for _ in $(seq 1 20); do
  if bash healthcheck.sh >/dev/null 2>&1; then
    mkdir -p "$DATA_DIR"
    echo "$(date -Iseconds) rollback ${ANTES} -> ${ALVO} ok" >> "$DATA_DIR/deploy.log"
    echo "$ANTES" > "$DATA_DIR/previous-version"
    echo "$ALVO" > "$DATA_DIR/current-version"
    bash healthcheck.sh
    echo ""
    echo "Rollback concluído: $ALVO"
    echo "Se a versão revertida usa um esquema de banco mais antigo e incompatível, restaure também o backup pré-atualização: npm run restore"
    exit 0
  fi
  sleep 2
done

echo "ATENÇÃO: rollback aplicado mas o /health continua falhando."
echo "Verifique 'journalctl -u remoteifes.service -e'. Se necessário, restaure o banco: npm run restore"
exit 1

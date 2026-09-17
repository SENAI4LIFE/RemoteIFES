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
ESPERA_SAUDE_TENTATIVAS="${ESPERA_SAUDE_TENTATIVAS:-20}"
ESPERA_SAUDE_INTERVALO="${ESPERA_SAUDE_INTERVALO:-2}"
if [ "$RESTART" -eq 1 ] && ! $SYSTEMCTL cat remoteifes.service >/dev/null 2>&1; then
  echo "serviço remoteifes.service não encontrado. Use --no-restart."
  exit 1
fi

DATA_DIR=$(node --env-file-if-exists=.env -e 'process.stdout.write(require("./src/config/paths").DIR_DADOS)') || { echo "não foi possível resolver o diretório de dados (src/config/paths.js)."; exit 1; }
DB_PATH=$(node --env-file-if-exists=.env -e 'process.stdout.write(require("./src/config/paths").CAMINHO_DB)') || { echo "não foi possível resolver o caminho do banco (src/config/paths.js)."; exit 1; }

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
  flags=(--omit=dev --no-audit --no-fund)
  [ "$OFFLINE" -eq 1 ] && flags+=(--offline)
  if ! npm ci "${flags[@]}"; then
    echo "npm ci falhou: as dependências de $ALVO não foram instaladas de forma íntegra."
    echo "O código já está em $ALVO, mas o serviço NÃO foi reiniciado. Corrija o npm ci (rede, espaço em disco) e rode 'npm ci --omit=dev' seguido de 'sudo systemctl restart remoteifes.service'."
    exit 1
  fi
else
  echo "Dependências inalteradas; pulando npm ci."
fi

if [ "$RESTART" -eq 0 ]; then
  echo "Código revertido para $ALVO. Serviço não reiniciado (--no-restart)."
  exit 0
fi

echo "Reiniciando remoteifes.service..."
$SYSTEMCTL restart remoteifes.service || echo "aviso: 'systemctl restart' retornou erro; verificando qual versão está em execução mesmo assim."

# Commit reportado pelo /health do processo em execução (vazio se ele não informa). Falha se o /health não responde.
versao_em_execucao() {
  local corpo
  corpo=$(bash healthcheck.sh 2>/dev/null) || return 1
  printf '%s' "$corpo" | sed -n 's/.*"commit":"\([0-9a-f]\{40\}\)".*/\1/p'
}

# Só é rollback concluído quando o processo em execução informa o commit alvo; um processo antigo que
# sobreviveu a um 'restart' que falhou responde saudável e não conta. Uma versão alvo anterior ao campo
# de commit no /health (que não o informa) é aceita pelo /health saudável, com aviso.
VERSAO_EM_EXECUCAO=""
for _ in $(seq 1 "$ESPERA_SAUDE_TENTATIVAS"); do
  if VERSAO_EM_EXECUCAO=$(versao_em_execucao); then
    if [ "$VERSAO_EM_EXECUCAO" = "$ALVO" ] || [ -z "$VERSAO_EM_EXECUCAO" ]; then
      [ -z "$VERSAO_EM_EXECUCAO" ] && echo "aviso: o processo em execução não informa o commit no /health (versão anterior a esse campo); aceitando pelo /health saudável."
      mkdir -p "$DATA_DIR"
      echo "$(date -Iseconds) rollback ${ANTES} -> ${ALVO} ok (processo em execução: ${VERSAO_EM_EXECUCAO:-sem commit informado})" >> "$DATA_DIR/deploy.log"
      echo "$ANTES" > "$DATA_DIR/previous-version"
      echo "$ALVO" > "$DATA_DIR/current-version"
      bash healthcheck.sh
      echo ""
      echo "Rollback concluído: $ALVO"
      echo "Se a versão revertida usa um esquema de banco mais antigo e incompatível, restaure também o backup pré-atualização: npm run restore"
      exit 0
    fi
  fi
  sleep "$ESPERA_SAUDE_INTERVALO"
done

if [ -z "$VERSAO_EM_EXECUCAO" ]; then
  echo "ATENÇÃO: código revertido para $ALVO, mas o /health não respondeu saudável."
else
  echo "ATENÇÃO: código revertido para $ALVO, mas o processo em execução continua em ${VERSAO_EM_EXECUCAO} (o reinício não aplicou a reversão)."
fi
echo "$(date -Iseconds) rollback ${ANTES} -> ${ALVO} FALHOU: processo em execução ${VERSAO_EM_EXECUCAO:-sem resposta do /health}" >> "$DATA_DIR/deploy.log"
echo "Verifique 'journalctl -u remoteifes.service -e'. Se necessário, restaure o banco: npm run restore"
exit 1

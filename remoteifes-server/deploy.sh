#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
APP_DIR="$(pwd)"

REF=""
OFFLINE=0
FORCE=0
RESTART=1
for arg in "$@"; do
  case "$arg" in
    --offline) OFFLINE=1 ;;
    --force) FORCE=1 ;;
    --no-restart) RESTART=0 ;;
    -h|--help)
      echo "Uso: bash deploy.sh [<ref>] [--offline] [--force] [--no-restart]"
      echo "  <ref>        tag, branch ou commit a implantar (padrão: origin/main)"
      echo "  --offline    não acessar a rede (git fetch e npm ci --offline)"
      echo "  --force      prosseguir mesmo com alterações locais não commitadas"
      echo "  --no-restart não reiniciar o serviço systemd nem verificar o /health"
      exit 0 ;;
    -*) echo "opção desconhecida: $arg"; exit 1 ;;
    *) REF="$arg" ;;
  esac
done

command -v git >/dev/null 2>&1 || { echo "git não encontrado no PATH."; exit 1; }
command -v node >/dev/null 2>&1 || { echo "node não encontrado no PATH. Rode ./setup.sh primeiro."; exit 1; }
[ -f "$APP_DIR/.env" ] || { echo ".env não encontrado em $APP_DIR. Rode ./setup.sh primeiro."; exit 1; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "não é um repositório git."; exit 1; }

SYSTEMCTL="systemctl"
[ "$(id -u)" -ne 0 ] && SYSTEMCTL="sudo systemctl"
ESPERA_SAUDE_TENTATIVAS="${ESPERA_SAUDE_TENTATIVAS:-20}"
ESPERA_SAUDE_INTERVALO="${ESPERA_SAUDE_INTERVALO:-2}"
if [ "$RESTART" -eq 1 ] && ! $SYSTEMCTL cat remoteifes.service >/dev/null 2>&1; then
  echo "serviço remoteifes.service não encontrado. Rode 'sudo bash install-service.sh' ou use --no-restart."
  exit 1
fi

DATA_DIR=$(node --env-file-if-exists=.env -e 'process.stdout.write(require("./src/config/paths").DIR_DADOS)') || { echo "não foi possível resolver o diretório de dados (src/config/paths.js)."; exit 1; }
DB_PATH=$(node --env-file-if-exists=.env -e 'process.stdout.write(require("./src/config/paths").CAMINHO_DB)') || { echo "não foi possível resolver o caminho do banco (src/config/paths.js)."; exit 1; }
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

if [ "$FORCE" -ne 1 ] && [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "há alterações locais não commitadas no repositório. Reverta-as ou use --force."
  git status --short
  exit 1
fi

ANTES=$(git rev-parse HEAD)
echo "Versão atual: $ANTES"

if [ -f "$DB_PATH" ]; then
  echo "Backup do banco antes da atualização..."
  node --env-file-if-exists=.env backup-db.js pre-update || { echo "backup pré-atualização falhou; abortando."; exit 1; }
else
  echo "Nenhum banco em $DB_PATH ainda; seguindo sem backup pré-atualização."
fi

if [ "$OFFLINE" -eq 1 ]; then
  echo "Modo offline: sem git fetch."
else
  git remote get-url origin >/dev/null 2>&1 || { echo "remoto 'origin' não configurado."; exit 1; }
  echo "Buscando atualizações de origin..."
  git fetch --tags --prune origin
fi

ALVO_REF="${REF:-origin/main}"
ALVO=$(git rev-parse --verify --quiet "${ALVO_REF}^{commit}") || {
  echo "não foi possível resolver o ref '${ALVO_REF}'."
  [ "$OFFLINE" -eq 1 ] && echo "Em --offline, use um ref que já exista localmente (tag ou commit)."
  exit 1
}

DESTACADO=0
case "$ALVO_REF" in
  origin/main|main)
    git checkout --quiet main
    git reset --hard "$ALVO"
    ;;
  *)
    git checkout --force --quiet "$ALVO"
    DESTACADO=1
    ;;
esac

DEPOIS=$(git rev-parse HEAD)
if [ "$DEPOIS" = "$ANTES" ]; then
  echo "Já está na versão alvo ($DEPOIS). Nada a fazer."
  exit 0
fi
echo "Nova versão: $DEPOIS"
[ "$DESTACADO" -eq 1 ] && echo "Nota: HEAD destacado em $ALVO_REF. Para voltar à linha principal: git checkout main"

instalar_deps() {
  if git diff --name-only "$1" "$2" -- package.json package-lock.json | grep -q .; then
    echo "Dependências mudaram; rodando npm ci..."
    local flags=(--omit=dev --no-audit --no-fund)
    [ "$OFFLINE" -eq 1 ] && flags+=(--offline)
    npm ci "${flags[@]}" || return 1
  else
    echo "Dependências inalteradas; pulando npm ci."
  fi
  return 0
}

reverter() {
  echo ""
  echo "Revertendo para $ANTES..."
  if [ "$DESTACADO" -eq 1 ]; then
    git checkout --force --quiet "$ANTES"
  else
    git checkout --quiet main
    git reset --hard "$ANTES"
  fi
  instalar_deps "$DEPOIS" "$ANTES" || echo "aviso: não foi possível reinstalar as dependências da versão anterior."
  if [ "$RESTART" -eq 1 ]; then
    $SYSTEMCTL restart remoteifes.service || true
    if aguardar_versao "$ANTES" legado; then
      echo "Revertido para $ANTES e o servidor em execução está saudável nessa versão."
    else
      echo "ATENÇÃO: código revertido para $ANTES, mas o processo em execução não confirma essa versão (${VERSAO_EM_EXECUCAO:-sem resposta do /health}). Verifique 'journalctl -u remoteifes.service -e' e, se necessário, restaure o banco com: npm run restore"
    fi
  fi
}

# Commit reportado pelo /health do processo em execução (vazio se ele não informa). Falha se o /health não responde.
versao_em_execucao() {
  local corpo
  corpo=$(bash healthcheck.sh 2>/dev/null) || return 1
  printf '%s' "$corpo" | sed -n 's/.*"commit":"\([0-9a-f]\{40\}\)".*/\1/p'
}

# Um /health saudável não basta: um processo antigo que sobreviveu a um 'restart' que falhou responde
# igual. Só é sucesso quando o processo em execução informa exatamente o commit esperado. Com "legado",
# um processo que não informa commit (versão anterior a esse campo) é aceito, com aviso.
aguardar_versao() {
  local esperado="$1" modo="${2:-estrito}"
  VERSAO_EM_EXECUCAO=""
  for _ in $(seq 1 "$ESPERA_SAUDE_TENTATIVAS"); do
    if VERSAO_EM_EXECUCAO=$(versao_em_execucao); then
      if [ "$VERSAO_EM_EXECUCAO" = "$esperado" ]; then
        return 0
      fi
      if [ -z "$VERSAO_EM_EXECUCAO" ] && [ "$modo" = "legado" ]; then
        echo "aviso: o processo em execução não informa o commit no /health (versão anterior a esse campo); aceitando pelo /health saudável."
        return 0
      fi
    fi
    sleep "$ESPERA_SAUDE_INTERVALO"
  done
  return 1
}

if ! instalar_deps "$ANTES" "$DEPOIS"; then
  echo "npm ci falhou; as dependências da nova versão não foram instaladas de forma íntegra. Abortando e revertendo."
  reverter
  exit 1
fi

if [ "$RESTART" -eq 0 ]; then
  echo "Atualização aplicada ($ANTES -> $DEPOIS). Serviço não reiniciado (--no-restart)."
  exit 0
fi

echo "Reiniciando remoteifes.service..."
$SYSTEMCTL restart remoteifes.service || echo "aviso: 'systemctl restart' retornou erro; verificando qual versão está em execução mesmo assim."

if aguardar_versao "$DEPOIS"; then
  echo "$(date -Iseconds) deploy ${ANTES} -> ${DEPOIS} (${ALVO_REF}) ok (processo em execução confirmou ${DEPOIS})" >> "$DATA_DIR/deploy.log"
  echo "$ANTES" > "$DATA_DIR/previous-version"
  echo "$DEPOIS" > "$DATA_DIR/current-version"
  bash healthcheck.sh
  echo ""
  echo "Deploy concluído: $DEPOIS (confirmado pelo processo em execução)"
  echo "Se algo estiver errado agora, volte com: bash rollback.sh"
else
  if [ -z "$VERSAO_EM_EXECUCAO" ]; then
    MOTIVO="o /health não respondeu saudável ou não informou o commit em execução"
  else
    MOTIVO="o processo em execução continua em ${VERSAO_EM_EXECUCAO}, não em ${DEPOIS} (o reinício não aplicou a nova versão)"
  fi
  echo "$(date -Iseconds) deploy ${ANTES} -> ${DEPOIS} (${ALVO_REF}) FALHOU: ${MOTIVO}; revertido" >> "$DATA_DIR/deploy.log"
  echo "A atualização não foi confirmada: ${MOTIVO}."
  reverter
  exit 1
fi

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
      echo "Uso: bash rollback.sh [<ref>] [--offline] [--force] [--no-restart]"
      echo "  <ref>    versão para a qual voltar (padrão: data/previous-version gravado pelo deploy)"
      echo "  --force  prosseguir mesmo com alterações locais não commitadas (elas são descartadas)"
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
# The lock holds "<pid> <date>". Whether its process is alive: kill -0, then /proc (a process of
# another user answers kill with EPERM), then ps. A PID that cannot be read counts as alive, so an
# uncertain lock is kept rather than taken over.
trava_viva() {
  local pid
  pid=$(awk 'NR == 1 { print $1 }' "$LOCK" 2>/dev/null)
  case "$pid" in ''|*[!0-9]*) return 0 ;; esac
  kill -0 "$pid" 2>/dev/null || [ -d "/proc/$pid" ] || ps -p "$pid" >/dev/null 2>&1
}

# A lock older than 30 minutes is left over only when its process is gone: a run stuck in git fetch
# or npm ci is still alive and keeps it (the Console renews its own lock every minute). find -mmin
# works with GNU, BSD and BusyBox alike; a failure to read the age keeps the lock.
trava_residual() {
  [ -f "$LOCK" ] && [ -n "$(find "$LOCK" -mmin +30 2>/dev/null)" ] && ! trava_viva
}

# Taking over a left-over lock is serialized by a directory created with mkdir (atomic), the same one
# the Console uses, and the lock is judged again while holding it: a reclaimer that paused between
# its first look and the removal cannot delete the lock another operation has just taken over. The
# directory is never removed by age (that would race the same way one level up): one left behind by a
# reclaimer that died inside these few lines stops automatic takeover until someone removes it.
MUTEX_RECLAMACAO="$LOCK.reclamacao"
if trava_residual && mkdir "$MUTEX_RECLAMACAO" 2>/dev/null; then
  trava_residual && rm -f "$LOCK"
  rmdir "$MUTEX_RECLAMACAO" 2>/dev/null || true
fi
MINHA_TRAVA="$$ $(date -Iseconds)"
if ! ( set -o noclobber; echo "$MINHA_TRAVA" > "$LOCK" ) 2>/dev/null; then
  echo "outra atualização/rollback parece estar em andamento ($LOCK). Aguarde ou remova o arquivo se for resíduo."
  [ -d "$MUTEX_RECLAMACAO" ] && echo "Há também $MUTEX_RECLAMACAO: se nenhuma operação de manutenção estiver rodando, é resíduo; remova com rmdir."
  exit 1
fi
# Only this run's lock is released: if another operation took over the file, it stays.
trap '[ "$(cat "$LOCK" 2>/dev/null)" = "$MINHA_TRAVA" ] && rm -f "$LOCK"' EXIT

# Reverting runs `reset --hard` / `checkout --force`, which would discard exactly the local work
# deploy.sh refuses to touch: the same refusal, the same escape hatch.
if [ "$FORCE" -ne 1 ] && [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "há alterações locais não commitadas no repositório. Reverta-as ou use --force (que as descarta)."
  git status --short
  exit 1
fi

[ "$OFFLINE" -eq 1 ] || git fetch --tags --prune origin >/dev/null 2>&1 || true

# shellcheck source=verificar-versao.sh
. ./verificar-versao.sh
ROTULO_VERSAO="a reversão"

ALVO=$(git rev-parse --verify --quiet "${REF}^{commit}") || { echo "não foi possível resolver o ref '${REF}'."; exit 1; }
ANTES=$(git rev-parse HEAD)

registrar_rollback_ok() {
  mkdir -p "$DATA_DIR"
  echo "$(date -Iseconds) rollback ${1} -> ${ALVO} ok (${VERSAO_CONFIRMACAO})" >> "$DATA_DIR/deploy.log"
  [ -n "$1" ] && [ "$1" != "$ALVO" ] && echo "$1" > "$DATA_DIR/previous-version"
  echo "$ALVO" > "$DATA_DIR/current-version"
  bash healthcheck.sh
  echo ""
  echo "Rollback concluído: $ALVO (${VERSAO_RESUMO})"
  echo "Se a versão revertida usa um esquema de banco mais antigo e incompatível, restaure também o backup pré-atualização: npm run restore"
}

# HEAD is already the target (interrupted rollback, earlier rollback whose restart was not
# confirmed, or --no-restart): it is only "nothing to do" when the running process confirms the
# version.
if [ "$ALVO" = "$ANTES" ]; then
  if [ "$RESTART" -eq 0 ]; then
    echo "Já está em $ALVO. Serviço não reiniciado nem verificado (--no-restart)."
    exit 0
  fi
  if ler_saude && [ "$VERSAO_EM_EXECUCAO" = "$ALVO" ]; then
    echo "Já está em $ALVO e o processo em execução a confirma. Nada a fazer."
    exit 0
  fi
  echo "O código já está em $ALVO, mas o processo em execução $(descrever_em_execucao); reiniciando para aplicá-la."
  EM_EXECUCAO_ANTES="$VERSAO_EM_EXECUCAO"
  if [ -f "$DB_PATH" ]; then
    echo "Backup do banco antes do rollback..."
    node --env-file-if-exists=.env backup-db.js pre-rollback || { echo "backup falhou; abortando."; exit 1; }
  fi
  PRECISA_NPM=0
  if [ -z "$EM_EXECUCAO_ANTES" ] || ! git cat-file -e "${EM_EXECUCAO_ANTES}^{commit}" 2>/dev/null; then
    echo "Versão em execução desconhecida; rodando npm ci para garantir as dependências de $ALVO..."
    PRECISA_NPM=1
  elif git diff --name-only "$EM_EXECUCAO_ANTES" "$ALVO" -- package.json package-lock.json | grep -q .; then
    echo "Dependências mudaram em relação à versão em execução; rodando npm ci..."
    PRECISA_NPM=1
  fi
  if [ "$PRECISA_NPM" -eq 1 ]; then
    flags=(--omit=dev --no-audit --no-fund)
    [ "$OFFLINE" -eq 1 ] && flags+=(--offline)
    npm ci "${flags[@]}" || { echo "npm ci falhou; o serviço não foi reiniciado."; exit 1; }
  fi
  reiniciar_servico
  if aguardar_versao "$ALVO"; then
    registrar_rollback_ok "$EM_EXECUCAO_ANTES"
    exit 0
  fi
  echo "ATENÇÃO: o código está em $ALVO, mas ${VERSAO_MOTIVO}."
  mkdir -p "$DATA_DIR"
  echo "$(date -Iseconds) rollback ${EM_EXECUCAO_ANTES:-?} -> ${ALVO} FALHOU: ${VERSAO_MOTIVO}" >> "$DATA_DIR/deploy.log"
  echo "Verifique 'journalctl -u remoteifes.service -e'. Se necessário, restaure o banco: npm run restore"
  exit 1
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

reiniciar_servico

if aguardar_versao "$ALVO"; then
  registrar_rollback_ok "$ANTES"
  exit 0
fi

echo "ATENÇÃO: código revertido para $ALVO, mas ${VERSAO_MOTIVO}."
mkdir -p "$DATA_DIR"
echo "$(date -Iseconds) rollback ${ANTES} -> ${ALVO} FALHOU: ${VERSAO_MOTIVO}" >> "$DATA_DIR/deploy.log"
echo "Verifique 'journalctl -u remoteifes.service -e'. Se necessário, restaure o banco: npm run restore"
exit 1

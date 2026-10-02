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
# The lock holds "<pid> <date> [<identity>]". The PID is the one the Console checks too: under Git
# Bash (MSYS/Cygwin), $$, kill -0 and ps -p belong to the emulation and do not see the Console's
# Windows processes, so the Windows PID is recorded there and looked up in the Windows process list.
# The identity, where /proc has it (Linux), is the boot and the process's start time: after a crash
# or a reboot the PID may belong to another process, which then does not pass for the owner.
if [ -r "/proc/$$/winpid" ]; then
  MEU_PID=$(cat "/proc/$$/winpid")
  pid_existe() {
    local lista
    # A list that cannot be read counts the process as alive.
    lista=$(ps -W 2>/dev/null) && [ -n "$lista" ] || return 0
    printf '%s\n' "$lista" | awk -v p="$1" 'NR > 1 { w = ($1 ~ /^[0-9]+$/) ? $4 : $5; if (w == p) achou = 1 } END { exit !achou }'
  }
else
  MEU_PID=$$
  # kill -0, then /proc (a process of another user answers kill with EPERM), then ps.
  pid_existe() { kill -0 "$1" 2>/dev/null || [ -d "/proc/$1" ] || ps -p "$1" >/dev/null 2>&1; }
fi
identidade_de() {
  local boot stat
  boot=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null) && stat=$(cat "/proc/$1/stat" 2>/dev/null) || return 0
  # Field 22 is the start time; the command name (field 2) may contain spaces and parentheses.
  set -- ${stat##*") "}
  case "${20:-}" in ''|*[!0-9]*) return 0 ;; esac
  printf '%s:%s' "$boot" "${20}"
}
# Alive unless certainly gone. A PID that cannot be read counts as alive, so an uncertain owner is
# kept rather than taken over; an identity recorded in another boot, or different from the running
# process's, means the PID now belongs to another process.
processo_vivo() {
  local boot atual
  case "${1:-}" in ''|*[!0-9]*) return 0 ;; esac
  pid_existe "$1" || return 1
  case "${2:-}" in *:*) ;; *) return 0 ;; esac
  boot=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null) || return 0
  [ "${2%%:*}" = "$boot" ] || return 1
  atual=$(identidade_de "$1")
  [ -z "$atual" ] || [ "$atual" = "$2" ]
}
trava_viva() {
  set -- $(awk 'NR == 1 { print $1, $3 }' "$LOCK" 2>/dev/null)
  processo_vivo "${1:-}" "${2:-}"
}

# A lock older than 30 minutes is left over only when its process is gone: a run stuck in git fetch
# or npm ci is still alive and keeps it (the Console renews its own lock every minute). find -mmin
# works with GNU, BSD and BusyBox alike; a failure to read the age keeps the lock.
trava_residual() {
  [ -f "$LOCK" ] && [ -n "$(find "$LOCK" -mmin +30 2>/dev/null)" ] && ! trava_viva
}

# Taking over a left-over lock is serialized by a directory created with mkdir (atomic), the same one
# the Console uses, and the lock is judged again while holding it: a reclaimer that paused between
# its first look and the removal cannot delete the lock another operation has just taken over.
#
# The holder records itself in the directory as "<pid> <identity|-> <nonce>": in `dono`, or, when it
# took over from a holder that died, in `sucessor.<that holder's nonce>`; the current holder is the
# end of that chain. Each record is hard-linked into place, which fails if the name exists, so only
# one process takes over from a given holder, and one that judged a directory since released and
# created again lands outside the chain and backs off. Nothing is removed by age, so one level up
# does not race the same way: a holder that died is taken over at once, and a directory without a
# record (an older version never writes one; this one writes it microseconds after the mkdir) after
# 10 minutes. Release moves the directory aside first, so it disappears in one step.
MUTEX_RECLAMACAO="$LOCK.reclamacao"
MINHA_IDENTIDADE=$(identidade_de "$$")
MEU_NONCE=$(od -An -N8 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n') || MEU_NONCE=""
[ -n "$MEU_NONCE" ] || MEU_NONCE="$MEU_PID$RANDOM$RANDOM"
MEU_REGISTRO="$MEU_PID ${MINHA_IDENTIDADE:--} $MEU_NONCE"
mutex_dono() {
  local registro nonce n=0
  registro=$(cat "$MUTEX_RECLAMACAO/dono" 2>/dev/null) || return 0
  while [ "$n" -lt 100 ]; do
    nonce=$(printf '%s\n' "$registro" | awk 'NR == 1 { print $3 }')
    case "$nonce" in ''|*[!0-9A-Za-z]*) break ;; esac
    [ -f "$MUTEX_RECLAMACAO/sucessor.$nonce" ] || break
    registro=$(cat "$MUTEX_RECLAMACAO/sucessor.$nonce" 2>/dev/null) || break
    n=$((n + 1))
  done
  printf '%s' "$registro"
}
mutex_adquirir() {
  local alvo dono temp criado=0
  rm -rf "$MUTEX_RECLAMACAO".lixo.* 2>/dev/null || true
  if mkdir "$MUTEX_RECLAMACAO" 2>/dev/null; then
    alvo="$MUTEX_RECLAMACAO/dono"
    criado=1
  else
    [ -d "$MUTEX_RECLAMACAO" ] || return 1
    dono=$(mutex_dono)
    if [ -z "$dono" ]; then
      [ -n "$(find "$MUTEX_RECLAMACAO" -prune -mmin +10 2>/dev/null)" ] || return 1
      alvo="$MUTEX_RECLAMACAO/dono"
    else
      set -- $dono
      case "${3:-}" in ''|*[!0-9A-Za-z]*) return 1 ;; esac
      # A record with this process's PID is not another live holder's.
      [ "${1:-}" = "$MEU_PID" ] || ! processo_vivo "${1:-}" "${2:-}" || return 1
      alvo="$MUTEX_RECLAMACAO/sucessor.$3"
    fi
  fi
  temp="$MUTEX_RECLAMACAO/.novo.$MEU_NONCE"
  if printf '%s\n' "$MEU_REGISTRO" > "$temp" 2>/dev/null; then
    # Without hard links (FAT, exFAT): exclusive creation, the record written right after.
    ln "$temp" "$alvo" 2>/dev/null || ( set -o noclobber; printf '%s\n' "$MEU_REGISTRO" > "$alvo" ) 2>/dev/null || true
    rm -f "$temp"
    [ "$(mutex_dono)" = "$MEU_REGISTRO" ] && return 0
    [ "$(cat "$alvo" 2>/dev/null)" = "$MEU_REGISTRO" ] && rm -f "$alvo"
  fi
  # A directory this run created and could not record itself in is removed if still empty (rmdir
  # leaves it to whoever recorded itself there instead).
  [ "$criado" -eq 1 ] && rmdir "$MUTEX_RECLAMACAO" 2>/dev/null
  return 1
}
mutex_liberar() {
  local registro
  [ "$(mutex_dono)" = "$MEU_REGISTRO" ] || return 0
  if mv "$MUTEX_RECLAMACAO" "$MUTEX_RECLAMACAO.lixo.$MEU_NONCE" 2>/dev/null; then
    rm -rf "$MUTEX_RECLAMACAO.lixo.$MEU_NONCE" 2>/dev/null || true
    return 0
  fi
  # Could not move it aside: this process gives up its place, and the rest is taken over as left over.
  for registro in "$MUTEX_RECLAMACAO"/dono "$MUTEX_RECLAMACAO"/sucessor.*; do
    [ "$(cat "$registro" 2>/dev/null)" = "$MEU_REGISTRO" ] && rm -f "$registro"
  done
  rmdir "$MUTEX_RECLAMACAO" 2>/dev/null || true
}
if trava_residual && mutex_adquirir; then
  trava_residual && rm -f "$LOCK"
  mutex_liberar
fi
MINHA_TRAVA="$MEU_PID $(date -Iseconds)${MINHA_IDENTIDADE:+ $MINHA_IDENTIDADE}"
if ! ( set -o noclobber; echo "$MINHA_TRAVA" > "$LOCK" ) 2>/dev/null; then
  echo "outra atualização/rollback parece estar em andamento ($LOCK). Aguarde ou remova o arquivo se for resíduo."
  [ -d "$MUTEX_RECLAMACAO" ] && echo "Há também $MUTEX_RECLAMACAO, de uma retomada em andamento ou interrompida. Uma interrompida é assumida automaticamente: de imediato quando o processo registrado nela não existe mais, ou após 10 minutos quando não há registro. Tente de novo."
  exit 1
fi
# Only this run's lock is released: if another operation took over the file, it stays.
trap '[ "$(cat "$LOCK" 2>/dev/null)" = "$MINHA_TRAVA" ] && rm -f "$LOCK"' EXIT

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
    reiniciar_servico
    ROTULO_VERSAO="a reversão"
    if aguardar_versao "$ANTES"; then
      echo "Revertido para $ANTES e o servidor em execução está saudável nessa versão (${VERSAO_RESUMO})."
    else
      echo "ATENÇÃO: código revertido para $ANTES, mas ${VERSAO_MOTIVO}. Verifique 'journalctl -u remoteifes.service -e' e, se necessário, restaure o banco com: npm run restore"
    fi
  fi
}

# shellcheck source=verificar-versao.sh
. ./verificar-versao.sh
ROTULO_VERSAO="a nova versão"

# HEAD is already the target. That does not prove the service runs it: an interrupted update, a
# manual 'git pull' or a deploy --no-restart leave the code ahead of the process. It is only
# "nothing to do" when the running process confirms the version; otherwise the service is restarted
# and verified.
if [ "$DEPOIS" = "$ANTES" ]; then
  if [ "$RESTART" -eq 0 ]; then
    echo "Já está na versão alvo ($DEPOIS). Serviço não reiniciado nem verificado (--no-restart)."
    exit 0
  fi
  if ler_saude && [ "$VERSAO_EM_EXECUCAO" = "$DEPOIS" ]; then
    echo "Já está na versão alvo ($DEPOIS) e o processo em execução a confirma. Nada a fazer."
    exit 0
  fi
  echo "O código já está em $DEPOIS, mas o processo em execução $(descrever_em_execucao); reiniciando para aplicá-la."
  EM_EXECUCAO_ANTES="$VERSAO_EM_EXECUCAO"
  if [ -n "$EM_EXECUCAO_ANTES" ] && git cat-file -e "${EM_EXECUCAO_ANTES}^{commit}" 2>/dev/null; then
    instalar_deps "$EM_EXECUCAO_ANTES" "$DEPOIS" || { echo "npm ci falhou; o serviço não foi reiniciado."; exit 1; }
  else
    echo "Versão em execução desconhecida; rodando npm ci para garantir as dependências de $DEPOIS..."
    flags=(--omit=dev --no-audit --no-fund)
    [ "$OFFLINE" -eq 1 ] && flags+=(--offline)
    npm ci "${flags[@]}" || { echo "npm ci falhou; o serviço não foi reiniciado."; exit 1; }
  fi
  reiniciar_servico
  if aguardar_versao "$DEPOIS"; then
    echo "$(date -Iseconds) deploy ${EM_EXECUCAO_ANTES:-?} -> ${DEPOIS} (${ALVO_REF}) ok (código já estava em ${DEPOIS}; ${VERSAO_CONFIRMACAO})" >> "$DATA_DIR/deploy.log"
    [ -n "$EM_EXECUCAO_ANTES" ] && [ "$EM_EXECUCAO_ANTES" != "$DEPOIS" ] && echo "$EM_EXECUCAO_ANTES" > "$DATA_DIR/previous-version"
    echo "$DEPOIS" > "$DATA_DIR/current-version"
    bash healthcheck.sh
    echo ""
    echo "Deploy concluído: $DEPOIS (${VERSAO_RESUMO})"
    exit 0
  fi
  echo "$(date -Iseconds) deploy ${EM_EXECUCAO_ANTES:-?} -> ${DEPOIS} (${ALVO_REF}) FALHOU: ${VERSAO_MOTIVO}" >> "$DATA_DIR/deploy.log"
  echo "ATENÇÃO: o código está em $DEPOIS, mas ${VERSAO_MOTIVO}. Verifique 'journalctl -u remoteifes.service -e'."
  exit 1
fi
echo "Nova versão: $DEPOIS"
[ "$DESTACADO" -eq 1 ] && echo "Nota: HEAD destacado em $ALVO_REF. Para voltar à linha principal: git checkout main"

if ! instalar_deps "$ANTES" "$DEPOIS"; then
  echo "npm ci falhou; as dependências da nova versão não foram instaladas de forma íntegra. Abortando e revertendo."
  reverter
  exit 1
fi

if [ "$RESTART" -eq 0 ]; then
  echo "Atualização aplicada ($ANTES -> $DEPOIS). Serviço não reiniciado (--no-restart)."
  exit 0
fi

reiniciar_servico

if aguardar_versao "$DEPOIS"; then
  echo "$(date -Iseconds) deploy ${ANTES} -> ${DEPOIS} (${ALVO_REF}) ok (${VERSAO_CONFIRMACAO})" >> "$DATA_DIR/deploy.log"
  echo "$ANTES" > "$DATA_DIR/previous-version"
  echo "$DEPOIS" > "$DATA_DIR/current-version"
  bash healthcheck.sh
  echo ""
  echo "Deploy concluído: $DEPOIS (${VERSAO_RESUMO})"
  echo "Se algo estiver errado agora, volte com: bash rollback.sh"
else
  echo "$(date -Iseconds) deploy ${ANTES} -> ${DEPOIS} (${ALVO_REF}) FALHOU: ${VERSAO_MOTIVO}; revertido" >> "$DATA_DIR/deploy.log"
  echo "A atualização não foi confirmada: ${VERSAO_MOTIVO}."
  reverter
  exit 1
fi

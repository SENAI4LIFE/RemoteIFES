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

# A deployment holds the lock: restarting now would fight it. A lock counts while it is younger than
# 30 minutes or its process is alive, the same rule the scripts use before taking one over; find
# -mmin is portable across find variants.
if [ -f "$LOCK" ] && { [ -n "$(find "$LOCK" -mmin -30 2>/dev/null)" ] || trava_viva; }; then
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

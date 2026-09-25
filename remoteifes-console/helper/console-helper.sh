#!/usr/bin/env bash
#
# Privileged helper of the RemoteIFES Operations Console.
#
# INSTALLATION: /usr/local/lib/remoteifes/console-helper.sh, root:root, mode 0755, with
# /usr/local/lib/remoteifes also root:root 0755. The Console user must NOT be able to write this
# file or any directory on its path: a sudoers entry pointing to a script the Console itself can
# edit separates no privilege.
#
# CONTRACT: every verb has a fixed target. No unit name, path, command, environment variable or
# working directory is accepted from the caller. Arguments exist only where there is a closed list
# of values (which journal to read, how many lines).
#
# What this helper deliberately does NOT do: git, npm, shell, file editing, package installation,
# unit changes. Those operations run unprivileged, as the checkout owner, or do not exist.

set -uo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
unset BASH_ENV ENV CDPATH IFS LD_PRELOAD LD_LIBRARY_PATH

UNIDADE_APP="remoteifes.service"
UNIDADE_SAUDE="remoteifes-health.timer"
UNIDADE_CONSOLE="remoteifes-console.service"
UNIDADE_RECUPERACAO="remoteifes-recover.service"

morrer() {
  echo "$1" >&2
  exit 2
}

# Checks that this script and every directory above it belong to root and are not writable by
# others. If someone could modify anything here, privilege is already compromised and continuing
# would only help the attacker.
verificar_propriedade() {
  local alvo
  alvo="$(readlink -f "${BASH_SOURCE[0]}")" || morrer "não foi possível resolver o caminho do auxiliar"
  local caminho="$alvo"
  while :; do
    local dono perm
    dono="$(stat -c %u "$caminho" 2>/dev/null)" || morrer "não foi possível inspecionar $caminho"
    perm="$(stat -c %a "$caminho" 2>/dev/null)"
    [ "$dono" = "0" ] || morrer "recusando: $caminho não pertence ao root"
    # stat may return 3 or 4 digits (with setuid/setgid/sticky). The check always uses the last two,
    # group and others, never a fixed position.
    grupo="${perm: -2:1}"
    outros="${perm: -1}"
    case "$outros" in
      [2367]) morrer "recusando: $caminho é gravável por outros além do root" ;;
    esac
    case "$grupo" in
      [2367]) morrer "recusando: $caminho é gravável pelo grupo" ;;
    esac
    [ "$caminho" = "/" ] && break
    caminho="$(dirname "$caminho")"
  done
}

verificar_propriedade

VERBO="${1:-}"
shift || true

case "$VERBO" in
  servico-estado)
    exec systemctl show "$UNIDADE_APP" \
      --property=ActiveState --property=SubState --property=UnitFileState \
      --property=ActiveEnterTimestamp --property=Result --property=NRestarts \
      --property=MainPID --property=MemoryCurrent
    ;;

  servico-iniciar)
    exec systemctl start "$UNIDADE_APP"
    ;;

  servico-parar)
    exec systemctl stop "$UNIDADE_APP"
    ;;

  servico-reiniciar)
    exec systemctl restart "$UNIDADE_APP"
    ;;

  watchdog-estado)
    exec systemctl show "$UNIDADE_SAUDE" \
      --property=ActiveState --property=UnitFileState --property=NextElapseUSecRealtime
    ;;

  watchdog-ligar)
    systemctl start "$UNIDADE_SAUDE" || exit 1
    exit 0
    ;;

  watchdog-desligar)
    # Only the timer is stopped. The recovery unit stays installed: disabling the schedule suspends
    # automatic recovery without removing the ability to recover.
    systemctl stop "$UNIDADE_SAUDE" || exit 1
    exit 0
    ;;

  journal)
    # The only verb with an argument, and still closed: unit alias and line count.
    alvo="${1:-app}"
    linhas="${2:-200}"
    prioridade="${3:-}"
    case "$alvo" in
      app) unidade="$UNIDADE_APP" ;;
      health) unidade="$UNIDADE_SAUDE" ;;
      console) unidade="$UNIDADE_CONSOLE" ;;
      recover) unidade="$UNIDADE_RECUPERACAO" ;;
      *) morrer "unidade de log não permitida" ;;
    esac
    case "$linhas" in
      ''|*[!0-9]*) morrer "número de linhas inválido" ;;
    esac
    [ "$linhas" -ge 10 ] && [ "$linhas" -le 2000 ] || morrer "número de linhas fora do intervalo"
    if [ -n "$prioridade" ]; then
      case "$prioridade" in
        [0-7]) ;;
        *) morrer "prioridade inválida" ;;
      esac
      exec journalctl -u "$unidade" -n "$linhas" -p "$prioridade" --no-pager --output=short-iso
    fi
    exec journalctl -u "$unidade" -n "$linhas" --no-pager --output=short-iso
    ;;

  console-reiniciar)
    # Detached from the calling process: the Console is this process's parent and dies on restart.
    exec systemctl restart --no-block "$UNIDADE_CONSOLE"
    ;;

  portas)
    # Listening diagnostics: shows who holds the ports, to identify a duplicate process.
    exec ss -ltnp
    ;;

  pacotes-pendentes)
    # Count only, from the existing cache. Never runs `apt update` (network and I/O on a Pi) and
    # never installs anything: system package updates remain a terminal operation with a human
    # decision.
    if command -v apt-get >/dev/null 2>&1; then
      apt-get --just-print upgrade 2>/dev/null | grep -c '^Inst ' || echo 0
      exit 0
    fi
    echo "indisponivel"
    exit 0
    ;;

  # Host reboot exists; shutdown does not. On a Pi without a physical console, a remote shutdown has
  # no way back over the network; whoever needs it has physical or SSH access.
  reiniciar-host)
    exec systemctl reboot
    ;;

  *)
    morrer "verbo não permitido"
    ;;
esac

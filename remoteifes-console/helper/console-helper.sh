#!/usr/bin/env bash
#
# Auxiliar privilegiado do Console de Operações RemoteIFES.
#
# INSTALAÇÃO: /usr/local/lib/remoteifes/console-helper.sh, root:root, modo 0755, com
# /usr/local/lib/remoteifes também root:root 0755. O usuário do console NÃO pode ter permissão
# de escrita neste arquivo nem em nenhum diretório do caminho: uma lista de sudoers apontando
# para um script que o próprio console pode editar não separa privilégio nenhum.
#
# CONTRATO: cada verbo tem alvo fixo. Não se recebe nome de unidade, caminho, comando,
# variável de ambiente nem diretório de trabalho vindos de quem chama. Argumentos existem
# apenas onde há uma lista fechada de valores (qual journal ler, quantas linhas).
#
# O que este auxiliar deliberadamente NÃO faz: git, npm, shell, edição de arquivo, instalação
# de pacote, alteração de unidade. Essas operações rodam sem privilégio, como o usuário dono do
# checkout, ou não existem.

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

# Confere que este script e todos os diretórios acima dele pertencem ao root e não são
# graváveis por outros. Se alguém conseguiu mexer aqui, o privilégio já foi comprometido e
# continuar executando só ajudaria o atacante.
verificar_propriedade() {
  local alvo
  alvo="$(readlink -f "${BASH_SOURCE[0]}")" || morrer "não foi possível resolver o caminho do auxiliar"
  local caminho="$alvo"
  while :; do
    local dono perm
    dono="$(stat -c %u "$caminho" 2>/dev/null)" || morrer "não foi possível inspecionar $caminho"
    perm="$(stat -c %a "$caminho" 2>/dev/null)"
    [ "$dono" = "0" ] || morrer "recusando: $caminho não pertence ao root"
    # stat pode devolver 3 ou 4 dígitos (com setuid/setgid/sticky). A checagem usa sempre os
    # dois últimos — grupo e outros —, nunca uma posição fixa.
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
    # Só o timer é parado. A unidade de recuperação continua instalada: desligar o agendamento
    # suspende a recuperação automática sem remover a capacidade de recuperar.
    systemctl stop "$UNIDADE_SAUDE" || exit 1
    exit 0
    ;;

  journal)
    # Único verbo com argumento, e ainda assim fechado: apelido de unidade e número de linhas.
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
    # Desacoplado do processo que chama: o console é o pai deste processo e morre no restart.
    exec systemctl restart --no-block "$UNIDADE_CONSOLE"
    ;;

  portas)
    # Diagnóstico de escuta: mostra quem ocupa as portas, para identificar processo duplicado.
    exec ss -ltnp
    ;;

  pacotes-pendentes)
    # Apenas contagem, a partir do cache existente. Nunca roda `apt update` (rede e I/O num Pi)
    # e nunca instala nada: atualização de pacote do sistema continua sendo operação de
    # terminal, com decisão humana.
    if command -v apt-get >/dev/null 2>&1; then
      apt-get --just-print upgrade 2>/dev/null | grep -c '^Inst ' || echo 0
      exit 0
    fi
    echo "indisponivel"
    exit 0
    ;;

  # Reinício do host existe; desligamento, não. Num Pi sem console físico, desligar remotamente
  # não tem caminho de volta pela rede — quem precisa disso tem acesso físico ou SSH.
  reiniciar-host)
    exec systemctl reboot
    ;;

  *)
    morrer "verbo não permitido"
    ;;
esac

#!/usr/bin/env bash
# Ciclo de vida da aplicação, visto pelo console.
#
# Só existe para dar *sequência e visibilidade* às chamadas do auxiliar privilegiado: parar a
# aplicação sem desligar o watchdog não é uma parada durável (ele reinicia em até ~6 min, após
# 3 falhas do /health em intervalos de 2 min), e iniciar sem religar o watchdog deixa o sistema
# sem recuperação automática. As duas coisas andam juntas.
#
# Nenhum argumento deste script vira nome de unidade, caminho ou comando: o verbo é fixo e o
# auxiliar revalida do lado privilegiado.
set -uo pipefail

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
AUXILIAR="${CONSOLE_AUXILIAR:-/usr/local/lib/remoteifes/console-helper.sh}"
SUDO="${CONSOLE_SUDO:-sudo}"

aux() {
  if [ ! -f "$AUXILIAR" ]; then
    echo "auxiliar privilegiado não instalado em $AUXILIAR" >&2
    return 90
  fi
  "$SUDO" -n "$AUXILIAR" "$@"
}

saude() {
  node "$RAIZ/bin/saude.js"
}

case "${1:-}" in
  reiniciar)
    echo "== Reiniciando remoteifes.service"
    aux servico-reiniciar || exit 1
    echo "== Aguardando o /health responder saudável"
    for _ in $(seq 1 20); do
      if saude >/dev/null 2>&1; then
        saude
        echo "Serviço reiniciado e saudável."
        exit 0
      fi
      sleep 2
    done
    echo "ATENÇÃO: o serviço foi reiniciado, mas o /health não respondeu saudável no prazo." >&2
    echo "Verifique os logs da aplicação antes de concluir que a operação deu certo." >&2
    exit 1
    ;;

  parar)
    echo "== Desligando o watchdog de saúde"
    echo "Sem isso, o watchdog reiniciaria a aplicação em poucos minutos e a parada não seria durável."
    aux watchdog-desligar || { echo "não foi possível desligar o watchdog; abortando para não parar a aplicação sem controle" >&2; exit 1; }
    echo "== Parando remoteifes.service"
    aux servico-parar || exit 1
    echo "== Confirmando que a aplicação parou de responder"
    for _ in $(seq 1 15); do
      if ! saude >/dev/null 2>&1; then
        echo "Aplicação parada. O watchdog está desligado e NÃO vai reiniciá-la."
        echo "Use 'Iniciar o RemoteIFES' para voltar à operação normal."
        exit 0
      fi
      sleep 1
    done
    echo "ATENÇÃO: algo continua respondendo na porta da aplicação depois da parada." >&2
    exit 1
    ;;

  iniciar)
    echo "== Iniciando remoteifes.service"
    aux servico-iniciar || exit 1
    echo "== Religando o watchdog de saúde"
    aux watchdog-ligar || echo "AVISO: o serviço subiu, mas o watchdog não pôde ser religado; a recuperação automática está desligada." >&2
    echo "== Aguardando o /health responder saudável"
    for _ in $(seq 1 20); do
      if saude >/dev/null 2>&1; then
        saude
        echo "Aplicação no ar e watchdog religado."
        exit 0
      fi
      sleep 2
    done
    echo "ATENÇÃO: o serviço foi iniciado, mas o /health não respondeu saudável no prazo." >&2
    exit 1
    ;;

  reiniciar-host)
    echo "== Reiniciando o host"
    echo "A conexão com o console vai cair agora. Reabra a página depois que o host subir."
    aux reiniciar-host || exit 1
    echo "Pedido de reinício enviado ao systemd."
    exit 0
    ;;

  *)
    echo "uso: servico.sh {reiniciar|parar|iniciar|reiniciar-host}" >&2
    exit 2
    ;;
esac

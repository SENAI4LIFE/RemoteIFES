#!/usr/bin/env bash
# Auto-atualização do console.
#
# O console roda de /opt/remoteifes-console/atual, fora do checkout, porque `deploy.sh`/`rollback.sh`
# trocam o checkout inteiro — e um rollback para revisão anterior ao console apagaria o
# diretório de onde ele estaria rodando. Atualizar é, portanto, copiar do checkout já atualizado
# para a instalação e reiniciar o serviço do console.
#
# A cópia vai para um diretório novo e só então é trocada por rename: uma cópia interrompida
# nunca deixa a instalação pela metade. O diretório anterior fica como .anterior para reparo.
set -euo pipefail

CHECKOUT="${1:?checkout}"
DESTINO="${2:?destino}"
ORIGEM="$CHECKOUT/remoteifes-console"
AUXILIAR="${CONSOLE_AUXILIAR:-/usr/local/lib/remoteifes/console-helper.sh}"
SUDO="${CONSOLE_SUDO:-sudo}"

[ -f "$ORIGEM/console.js" ] || { echo "o checkout não contém remoteifes-console/console.js" >&2; exit 1; }
[ -d "$DESTINO" ] || { echo "instalação não encontrada em $DESTINO" >&2; exit 1; }
case "$DESTINO" in
  /*) ;;
  *) echo "destino precisa ser caminho absoluto" >&2; exit 2 ;;
esac

VERSAO_ORIGEM=$(node -e 'process.stdout.write(require(process.argv[1]+"/package.json").version)' "$ORIGEM" 2>/dev/null || echo "?")
VERSAO_ATUAL=$(node -e 'process.stdout.write(require(process.argv[1]+"/package.json").version)' "$DESTINO" 2>/dev/null || echo "?")
echo "Console instalado: $VERSAO_ATUAL"
echo "Console no checkout: $VERSAO_ORIGEM"
echo ""

echo "== Validando a origem antes de copiar"
node --check "$ORIGEM/console.js"
for arquivo in "$ORIGEM"/src/*.js "$ORIGEM"/bin/*.js; do
  [ -e "$arquivo" ] || continue
  node --check "$arquivo"
done
echo "Sintaxe dos módulos do console: ok"

# A troca acontece dentro da raiz da instalação (<raiz>/atual e <raiz>/anterior), que pertence
# ao usuário do console. Assim a auto-atualização não precisa de root nem de escrita em /opt.
RAIZ_INSTALACAO="$(dirname "$DESTINO")"
NOVO="$RAIZ_INSTALACAO/.novo.$$"
ANTERIOR="$RAIZ_INSTALACAO/anterior"

[ -w "$RAIZ_INSTALACAO" ] || { echo "sem permissão de escrita em $RAIZ_INSTALACAO; reinstale com: sudo bash $ORIGEM/install-console.sh" >&2; exit 1; }

echo "== Copiando para $NOVO"
rm -rf "$NOVO"
mkdir -p "$NOVO"
# Sem --delete e sem tocar no destino em uso: a troca é por rename no final.
tar -C "$ORIGEM" --exclude=node_modules --exclude=.git -cf - . | tar -C "$NOVO" -xf -

echo "== Trocando a instalação"
rm -rf "$ANTERIOR"
mv "$DESTINO" "$ANTERIOR"
mv "$NOVO" "$DESTINO"
echo "Instalação trocada. A anterior ficou em $ANTERIOR para reparo."

echo ""
echo "== Reiniciando o serviço do console"
echo "Esta sessão cai por alguns segundos; a página reconecta sozinha."
if [ -f "$AUXILIAR" ]; then
  # O reinício é pedido em segundo plano: este processo é filho do console e morreria junto
  # com ele antes de conseguir relatar o resultado.
  "$SUDO" -n "$AUXILIAR" console-reiniciar &
  echo "Pedido de reinício enviado."
else
  echo "AVISO: auxiliar não instalado; reinicie manualmente com: sudo systemctl restart remoteifes-console.service" >&2
fi
exit 0

#!/usr/bin/env bash
#
# Instalador do Console de Operações RemoteIFES.
#
# O que ele faz, e por quê:
#   1. copia o console do checkout para /opt/remoteifes-console/atual — fora do checkout, porque
#      `deploy.sh`/`rollback.sh` trocam o checkout inteiro e um rollback para revisão anterior
#      ao console apagaria o diretório de onde ele estaria rodando;
#   2. instala o auxiliar privilegiado em /usr/local/lib/remoteifes/ como root:root, e a regra
#      de sudo apontando só para ele, com verbos fixos;
#   3. instala socket + serviço systemd, de modo que nada fique residente enquanto ninguém usa;
#   4. gera um segredo de instalação de uso único para criar o primeiro operador.
#
# Não cria conta de aplicação, não toca no banco, não reinicia o RemoteIFES.
set -euo pipefail

if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  echo "Rode como root: sudo bash install-console.sh" >&2
  exit 1
fi

command -v systemctl >/dev/null 2>&1 || { echo "systemd não encontrado; este instalador requer systemctl." >&2; exit 1; }

ORIGEM="$(cd "$(dirname "$0")" && pwd)"
DESTINO_PADRAO="${CONSOLE_DESTINO:-/opt/remoteifes-console}"
ESTADO_PADRAO="${CONSOLE_ESTADO_DIR:-/var/lib/remoteifes-console}"

if [ "${1:-}" = "--remover" ]; then
  echo "== Removendo o Console de Operações"
  systemctl disable --now remoteifes-console.socket 2>/dev/null || true
  systemctl stop remoteifes-console.service 2>/dev/null || true
  rm -f /etc/systemd/system/remoteifes-console.socket /etc/systemd/system/remoteifes-console.service
  rm -f /etc/sudoers.d/remoteifes-console
  rm -f /usr/local/lib/remoteifes/console-helper.sh
  rmdir /usr/local/lib/remoteifes 2>/dev/null || true
  systemctl daemon-reload
  rm -rf "$DESTINO_PADRAO"
  echo "Unidades, auxiliar, regra de sudo e instalação removidos."
  echo "O estado em $ESTADO_PADRAO foi PRESERVADO (operadores, auditoria e histórico)."
  echo "Para apagá-lo também: sudo rm -rf $ESTADO_PADRAO"
  echo "O RemoteIFES não foi tocado."
  exit 0
fi

CHECKOUT="$(cd "$ORIGEM/.." && pwd)"
# Raiz da instalação, pertencente ao usuário do console, e o diretório de código dentro dela.
# A troca na auto-atualização é feita por rename DENTRO desta raiz; por isso ela não pode ser
# root-only. Isso não afeta a separação de privilégio: o serviço já roda como este usuário, e o
# que dá acesso a root é o auxiliar em /usr/local/lib/remoteifes, que segue root:root.
RAIZ_INSTALACAO="${CONSOLE_DESTINO:-/opt/remoteifes-console}"
DESTINO="$RAIZ_INSTALACAO/atual"
DIR_ESTADO="${CONSOLE_ESTADO_DIR:-/var/lib/remoteifes-console}"
DIR_AUXILIAR="/usr/local/lib/remoteifes"
AUXILIAR="$DIR_AUXILIAR/console-helper.sh"
USUARIO="${SUDO_USER:-$(whoami)}"
NODE_BIN="$(command -v node || true)"

[ -n "$NODE_BIN" ] || { echo "Node.js não encontrado no PATH." >&2; exit 1; }
[ -f "$CHECKOUT/remoteifes-server/package.json" ] || { echo "não encontrei remoteifes-server em $CHECKOUT" >&2; exit 1; }

DIR_DADOS="$("$NODE_BIN" -e '
const p = require(process.argv[1] + "/remoteifes-server/src/config/paths.js");
process.stdout.write(p.DIR_DADOS);
' "$CHECKOUT" 2>/dev/null || echo "$CHECKOUT/remoteifes-server/data")"

echo "Console          : $DESTINO"
echo "Checkout         : $CHECKOUT"
echo "Estado           : $DIR_ESTADO"
echo "Dados do servidor: $DIR_DADOS"
echo "Usuário          : $USUARIO"
echo ""

# --- 1. Instalação do console ------------------------------------------------------------
echo "== Instalando o console em $DESTINO"
mkdir -p "$RAIZ_INSTALACAO"
NOVO="$RAIZ_INSTALACAO/.novo.$$"
rm -rf "$NOVO"
mkdir -p "$NOVO"
tar -C "$ORIGEM" --exclude=node_modules --exclude=.git -cf - . | tar -C "$NOVO" -xf -
if [ -d "$DESTINO" ] && [ -n "$(ls -A "$DESTINO" 2>/dev/null)" ]; then
  rm -rf "$RAIZ_INSTALACAO/anterior"
  mv "$DESTINO" "$RAIZ_INSTALACAO/anterior"
fi
mv "$NOVO" "$DESTINO"
chown -R "$USUARIO" "$RAIZ_INSTALACAO"
chmod 755 "$RAIZ_INSTALACAO"
chmod -R go-w "$DESTINO"
echo "Console instalado em $DESTINO (a auto-atualização troca este diretório por rename)."

# --- 2. Estado -----------------------------------------------------------------------------
echo "== Preparando o diretório de estado"
mkdir -p "$DIR_ESTADO" "$DIR_ESTADO/saidas"
chown -R "$USUARIO" "$DIR_ESTADO"
chmod 700 "$DIR_ESTADO" "$DIR_ESTADO/saidas"
printf '%s\n' "$CHECKOUT" > "$DIR_ESTADO/checkout-dir"
chown "$USUARIO" "$DIR_ESTADO/checkout-dir"
chmod 600 "$DIR_ESTADO/checkout-dir"

# --- 3. Auxiliar privilegiado ----------------------------------------------------------------
echo "== Instalando o auxiliar privilegiado"
mkdir -p "$DIR_AUXILIAR"
install -o root -g root -m 0755 "$ORIGEM/helper/console-helper.sh" "$AUXILIAR"
chown root:root "$DIR_AUXILIAR"
chmod 0755 "$DIR_AUXILIAR"
# O auxiliar recusa executar se ele ou algum diretório acima for gravável por quem não é root;
# esta checagem antecipa o erro na instalação em vez de na primeira operação.
if ! runuser -u "$USUARIO" -- test -r "$AUXILIAR"; then
  echo "aviso: $USUARIO não consegue ler $AUXILIAR" >&2
fi

SUDOERS="/etc/sudoers.d/remoteifes-console"
cat > "$SUDOERS" <<SUDO
# Console de Operações RemoteIFES.
# Uma única entrada, apontando para um script root:root em diretório root:root. O script aceita
# somente verbos fixos com alvo fixo; não há git, npm, shell, caminho nem unidade arbitrários.
$USUARIO ALL=(root) NOPASSWD: $AUXILIAR
SUDO
chmod 0440 "$SUDOERS"
if ! visudo -cf "$SUDOERS" >/dev/null; then
  rm -f "$SUDOERS"
  echo "regra de sudo inválida; nada foi instalado em /etc/sudoers.d" >&2
  exit 1
fi
echo "Regra de sudo validada com visudo."

# --- 4. Unidades systemd ---------------------------------------------------------------------
echo "== Instalando as unidades systemd"
install -o root -g root -m 0644 "$ORIGEM/systemd/remoteifes-console.socket" /etc/systemd/system/remoteifes-console.socket
sed -e "s#__USUARIO__#$USUARIO#g" \
    -e "s#__RAIZ_CONSOLE__#$DESTINO#g" \
    -e "s#__NODE__#$NODE_BIN#g" \
    -e "s#__DIR_ESTADO__#$DIR_ESTADO#g" \
    -e "s#__DIR_DADOS__#$DIR_DADOS#g" \
    -e "s#__CHECKOUT__#$CHECKOUT#g" \
    -e "s#__RAIZ_INSTALACAO__#$RAIZ_INSTALACAO#g" \
    "$ORIGEM/systemd/remoteifes-console.service.modelo" > /etc/systemd/system/remoteifes-console.service
chmod 0644 /etc/systemd/system/remoteifes-console.service

systemctl daemon-reload
systemctl enable remoteifes-console.socket
systemctl restart remoteifes-console.socket
echo "Socket habilitado no boot. O serviço só sobe quando alguém abrir o console."

# --- 5. Primeiro operador ----------------------------------------------------------------------
PORTA="$(grep -oE 'ListenStream=127\.0\.0\.1:[0-9]+' /etc/systemd/system/remoteifes-console.socket | cut -d: -f3)"
PORTA="${PORTA:-8099}"

if [ -f "$DIR_ESTADO/operadores.json" ] && grep -q '"nome"' "$DIR_ESTADO/operadores.json" 2>/dev/null; then
  echo ""
  echo "Já existe operador cadastrado; nenhum segredo novo foi gerado."
else
  SEGREDO="$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 32)"
  printf '%s\n' "$SEGREDO" > "$DIR_ESTADO/bootstrap-token"
  chown "$USUARIO" "$DIR_ESTADO/bootstrap-token"
  chmod 600 "$DIR_ESTADO/bootstrap-token"
  echo ""
  echo "================================================================"
  echo " Segredo de instalação (uso único, exibido apenas agora):"
  echo ""
  echo "     $SEGREDO"
  echo ""
  echo " Use-o na primeira tela do console para criar o operador."
  echo " Ele é apagado assim que o operador for criado."
  echo "================================================================"
fi

cat <<FIM

Console instalado.

  Acesso local no Pi:      http://127.0.0.1:$PORTA
  De outra máquina:        ssh -L $PORTA:127.0.0.1:$PORTA $USUARIO@$(hostname)
                           e então abra http://127.0.0.1:$PORTA no seu navegador.
                           (o localhost do seu computador não é o do Pi)

  Estado do socket:        systemctl status remoteifes-console.socket
  Logs do console:         journalctl -u remoteifes-console.service -e
  Desinstalar:             sudo bash $DESTINO/install-console.sh --remover

A operação do prédio (salas, agendamentos, usuários, ESP32) continua no aplicativo RemoteIFES.
FIM

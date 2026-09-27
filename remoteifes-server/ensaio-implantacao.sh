#!/usr/bin/env bash
# Deployment rehearsal on a DISPOSABLE Linux host with systemd (a CI runner): the production
# installation path end to end, with simulated boards and no ESP32 hardware.
#
#   sudo ENSAIO_HOST_DESCARTAVEL=1 env PATH="$PATH" bash remoteifes-server/ensaio-implantacao.sh
#
# It installs systemd units, nginx and the Console package, and edits /etc: never run it on a host
# that serves anything. Steps:
#   1. clean install from a clone (setup.sh), production .env, install-service.sh
#   2. start, frontend, /health with the commit, persisted data, simulated boards (commands confirmed)
#   3. restart, stop and start: the data and the boards come back
#   4. deploy a new version; a deploy whose version crashes at start (systemd's start limit is hit)
#      reverts and the service comes back; rollback.sh returns to the first version
#   5. backup with the service running; restore with it stopped; start and verify
#   6. reverse proxy (lan-setup.sh): nginx -t, WebSocket headers, the server bound to loopback, boards
#      through the proxy
#   7. HTTPS configuration (https-setup.sh) with a .env saved with CRLF, up to certificate issuance,
#      which needs a public domain and is NOT exercised: certbot is replaced by a stub that refuses
#   8. Operations Console .deb against this installation: socket activation, loopback-only listener,
#      service restart, the launcher's status, removal keeping state, purge
#   9. removal of the server's units
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "rode como root (sudo) num host descartável."; exit 1; }
[ "${ENSAIO_HOST_DESCARTAVEL:-}" = "1" ] || { echo "defina ENSAIO_HOST_DESCARTAVEL=1: este ensaio instala serviços, nginx e altera /etc."; exit 1; }
command -v systemctl >/dev/null 2>&1 || { echo "systemd é necessário."; exit 1; }
USUARIO="${SUDO_USER:?rode com sudo a partir do usuário que executará o serviço}"
ORIGEM="$(cd "$(dirname "$0")/.." && pwd)"
DESTINO=/opt/remoteifes-ensaio
PORTA=8095
SENHA="ensaio-implantacao-senha-forte"
SERVIDOR="$DESTINO/remoteifes-server"

passo() { printf '\n== %s\n' "$*"; }
como_usuario() { sudo -u "$USUARIO" env PATH="$PATH" HOME="$(getent passwd "$USUARIO" | cut -d: -f6)" "$@"; }
verificar() { como_usuario node "$SERVIDOR/test/support/verificar-implantacao.js" --senha "$SENHA" --base "$@"; }
# Git refuses, as root, a repository owned by another user: every git call runs as the owner.
commit_atual() { como_usuario git -C "$DESTINO" rev-parse HEAD; }
diagnostico() {
  echo "--- diagnóstico ---"
  systemctl status remoteifes.service --no-pager 2>&1 | tail -20 || true
  journalctl -u remoteifes.service --no-pager 2>&1 | tail -40 || true
}
trap 'status=$?; [ $status -ne 0 ] && diagnostico; exit $status' EXIT

passo "1. instalação limpa a partir de um clone"
rm -rf "$DESTINO"
install -d -o "$USUARIO" "$DESTINO"
como_usuario git clone -q "$ORIGEM" "$DESTINO"
cd "$SERVIDOR"
como_usuario bash setup.sh
[ -z "$(como_usuario git status --porcelain --untracked-files=no)" ] || { echo "setup.sh deixou alterações rastreadas; deploy.sh as recusaria."; como_usuario git status --short; exit 1; }
sed -i "s/^PORTA=.*/PORTA=$PORTA/" .env
echo "SENHA_ADMIN_INICIAL=$SENHA" >> .env
bash install-service.sh
grep -q '^NODE_ENV=production' .env
systemctl is-enabled remoteifes.service remoteifes-health.timer
PRIMEIRA=$(commit_atual)

passo "2. serviço no ar: frontend, /health com o commit, dados e placas simuladas"
verificar "http://127.0.0.1:$PORTA" --commit "$PRIMEIRA" --frontend --marcar --dispositivos 2
# The unit's containment is in force (every later step runs under it), and the database the
# service created holds its secrets away from other local accounts.
for p in PrivateDevices ProtectKernelTunables ProtectKernelModules ProtectKernelLogs ProtectControlGroups ProtectClock ProtectHostname RestrictSUIDSGID RestrictRealtime LockPersonality; do
  systemctl show -p "$p" remoteifes.service | grep -qx "$p=yes" || { echo "remoteifes.service sem $p=yes"; exit 1; }
done
systemctl show -p UMask remoteifes.service | grep -qx "UMask=0077"
[ "$(stat -c %a "$SERVIDOR/data/remoteifes.db")" = 600 ] || { echo "banco com modo $(stat -c %a "$SERVIDOR/data/remoteifes.db")"; exit 1; }
systemd-analyze security remoteifes.service --no-pager 2>/dev/null | tail -n 1 || true

passo "3. reinício, parada e partida: dados e placas voltam"
systemctl restart remoteifes.service
verificar "http://127.0.0.1:$PORTA" --commit "$PRIMEIRA" --exigir-marca --dispositivos 2
systemctl stop remoteifes.service
! curl -s --max-time 2 "http://127.0.0.1:$PORTA/health" >/dev/null || { echo "o serviço parado ainda responde"; exit 1; }
systemctl start remoteifes.service
verificar "http://127.0.0.1:$PORTA" --commit "$PRIMEIRA" --exigir-marca --dispositivos 1

passo "4. atualização, atualização que falha ao iniciar, e reversão"
cd "$DESTINO"
autor=(-c user.name="Ensaio" -c user.email="ensaio@invalid")
como_usuario git "${autor[@]}" commit -q --allow-empty -m "ensaio: nova versão"
NOVA=$(commit_atual)
printf '\nprocess.exit(3);\n' >> remoteifes-server/server.js
como_usuario git "${autor[@]}" commit -q -am "ensaio: versão que não sobe"
QUEBRADA=$(commit_atual)
como_usuario git reset -q --hard "$PRIMEIRA"
cd "$SERVIDOR"
como_usuario bash deploy.sh "$NOVA" --offline
verificar "http://127.0.0.1:$PORTA" --commit "$NOVA" --exigir-marca --dispositivos 1
INICIO_FALHA=$(date +%s)
set +e
como_usuario bash deploy.sh "$QUEBRADA" --offline
codigo=$?
set -e
[ "$codigo" -ne 0 ] || { echo "a atualização quebrada foi dada como concluída"; exit 1; }
# The crashing version must have exhausted systemd's start limit, or this step would not show that
# the revert brings the service back over it.
LIMITE=$(journalctl -u remoteifes.service --since "@$INICIO_FALHA" --no-pager 2>/dev/null | grep -cE "Start request repeated too quickly|start-limit-hit" || true)
echo "registros de limite de partidas do systemd durante a atualização que falhou: $LIMITE"
[ "$LIMITE" -ge 1 ] || { echo "a versão que cai ao iniciar não chegou ao limite de partidas do systemd"; exit 1; }
verificar "http://127.0.0.1:$PORTA" --commit "$NOVA" --exigir-marca --dispositivos 1
[ "$(commit_atual)" = "$NOVA" ] || { echo "o código não voltou para a versão anterior"; exit 1; }
como_usuario bash rollback.sh --offline
verificar "http://127.0.0.1:$PORTA" --commit "$PRIMEIRA" --exigir-marca --dispositivos 1

passo "5. backup com o serviço no ar; restauração com ele parado"
como_usuario npm run backup --silent -- ensaio-implantacao
BACKUP=$(ls -t "$SERVIDOR"/data/backups/*-ensaio-implantacao.db | head -n1)
systemctl stop remoteifes.service
como_usuario npm run restore --silent -- "$BACKUP" --sim
systemctl start remoteifes.service
verificar "http://127.0.0.1:$PORTA" --commit "$PRIMEIRA" --exigir-marca --dispositivos 1

passo "6. proxy reverso (lan-setup.sh)"
bash lan-setup.sh
systemctl restart remoteifes.service
nginx -t
SITE=/etc/nginx/sites-available/remoteifes
for linha in "proxy_pass http://127.0.0.1:$PORTA;" 'proxy_set_header Upgrade $http_upgrade;' 'proxy_set_header Connection $connection_upgrade;' 'proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;'; do
  grep -qF "$linha" "$SITE" || { echo "falta no site do nginx: $linha"; exit 1; }
done
grep -q '^TRUST_PROXY=1' .env && grep -q '^BIND_ADDR=127.0.0.1' .env
# Behind the proxy the server listens on loopback only.
sleep 1
ESCUTAS=$(ss -ltnH "sport = :$PORTA" | awk '{print $4}')
echo "escutas na porta $PORTA: $ESCUTAS"
[ -n "$ESCUTAS" ] && ! echo "$ESCUTAS" | grep -qvE "^127\.0\.0\.1:$PORTA$" || { echo "o servidor escuta fora do loopback atrás do proxy"; exit 1; }
verificar "http://127.0.0.1" --commit "$PRIMEIRA" --exigir-marca --frontend --dispositivos 2

passo "7. configuração HTTPS sem domínio público (a emissão do certificado não é exercida)"
sed -i 's/$/\r/' .env
STUB=$(mktemp -d)
printf '#!/usr/bin/env bash\necho "certbot: emissão não exercida no ensaio (exige domínio público)" >&2\nexit 1\n' > "$STUB/certbot"
chmod +x "$STUB/certbot"
set +e
PATH="$STUB:$PATH" bash https-setup.sh ensaio.invalid operador@example.invalid
codigo=$?
set -e
[ "$codigo" -ne 0 ] || { echo "https-setup.sh não parou na emissão do certificado"; exit 1; }
grep -qF "server_name ensaio.invalid;" "$SITE"
grep -qF "proxy_pass http://127.0.0.1:$PORTA;" "$SITE" || { echo "a porta do .env com CRLF não chegou limpa ao nginx"; exit 1; }
nginx -t
sed -i 's/\r$//' .env
rm -rf "$STUB"

passo "8. Console de Operações: pacote .deb contra esta instalação"
CONSOLE="$DESTINO/remoteifes-console"
VERSAO=$(node -p "require('$CONSOLE/package.json').version")
# The payload carries the release verifier, the Console's only production dependency.
(cd "$CONSOLE" && como_usuario npm ci --omit=dev --no-audit --no-fund >/dev/null)
como_usuario node "$CONSOLE/empacotar/construir.js" --saida "$DESTINO/dist" --alvo linux-x64 --formato deb >/dev/null
env PATH="$PATH" CONSOLE_CHECKOUT_DIR="$DESTINO" dpkg --force-depends -i "$DESTINO/dist/remoteifes-console_${VERSAO}_all.deb" > /dev/null
node "$CONSOLE/empacotar/conferir-instalacao.js" /opt/remoteifes-console
systemctl is-enabled remoteifes-console.socket
systemctl show -p Listen remoteifes-console.socket | grep -q "Listen=127.0.0.1:8099 (Stream)"
esperar_console() {
  for _ in $(seq 1 30); do
    [ "$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:8099/ || true)" = "200" ] && return 0
    sleep 1
  done
  journalctl -u remoteifes-console.service --no-pager | tail -30
  return 1
}
esperar_console
ESCUTAS=$(ss -ltnH "sport = :8099" | awk '{print $4}')
echo "escutas do console: $ESCUTAS"
! echo "$ESCUTAS" | grep -qvE '^127\.0\.0\.1:8099$' || { echo "o console escuta fora do loopback"; exit 1; }
systemctl restart remoteifes-console.service
esperar_console
STATUS=$(node /opt/remoteifes-console/launcher-bootstrap.js --status)
echo "$STATUS"
echo "$STATUS" | grep -q "RemoteIFES      : saudável" || { echo "o console não vê a aplicação saudável"; exit 1; }
dpkg -r remoteifes-console > /dev/null
test ! -e /opt/remoteifes-console
test -s /var/lib/remoteifes-console/bootstrap-token
! curl -s --max-time 2 http://127.0.0.1:8099/ >/dev/null || { echo "o console removido ainda responde"; exit 1; }
dpkg -P remoteifes-console > /dev/null
test ! -e /var/lib/remoteifes-console

passo "9. remoção das unidades do servidor"
systemctl disable --now remoteifes.service remoteifes-health.timer
rm -f /etc/systemd/system/remoteifes.service /etc/systemd/system/remoteifes-health.service /etc/systemd/system/remoteifes-health.timer /etc/systemd/system/remoteifes-recover.service
systemctl daemon-reload
! systemctl cat remoteifes.service >/dev/null 2>&1 || { echo "a unidade continua registrada"; exit 1; }

printf '\nEnsaio de implantação concluído: instalação, serviço, atualização, reversão, backup, restauração, proxy, configuração HTTPS e console.\n'

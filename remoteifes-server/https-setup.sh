#!/usr/bin/env bash
set -e

if [ "$EUID" -ne 0 ]; then
  echo "Rode este script como root (sudo bash https-setup.sh <dominio> <email>)."
  exit 1
fi

DOMINIO="$1"
EMAIL="$2"

if [ -z "$DOMINIO" ] || [ -z "$EMAIL" ]; then
  echo "Uso: sudo bash https-setup.sh <dominio> <email>"
  exit 1
fi

cd "$(dirname "$0")"

if [ -f .env ]; then
  PORTA=$(grep -E '^PORTA=' .env | cut -d '=' -f2)
fi
PORTA=${PORTA:-8080}

if ! command -v nginx >/dev/null 2>&1; then
  apt-get update
  apt-get install -y nginx
fi

if ! command -v certbot >/dev/null 2>&1; then
  apt-get update
  apt-get install -y certbot python3-certbot-nginx
fi

SITE_PATH="/etc/nginx/sites-available/remoteifes"

cat > "$SITE_PATH" <<EOF
map \$http_upgrade \$connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    server_name $DOMINIO;

    location / {
        proxy_pass http://127.0.0.1:$PORTA;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_read_timeout 1h;
    }
}
EOF

ln -sf "$SITE_PATH" /etc/nginx/sites-enabled/remoteifes
rm -f /etc/nginx/sites-enabled/default

nginx -t
systemctl reload nginx

certbot --nginx -d "$DOMINIO" -m "$EMAIL" --agree-tos --non-interactive --redirect

systemctl enable certbot.timer
systemctl start certbot.timer

if [ -f .env ]; then
  for par in "TRUST_PROXY=1" "BIND_ADDR=127.0.0.1"; do
    chave="${par%%=*}"
    if grep -q "^${chave}=" .env; then
      sed -i "s|^${chave}=.*|${par}|" .env
    else
      echo "$par" >> .env
    fi
  done
else
  echo "Aviso: .env não encontrado; defina TRUST_PROXY=1 e BIND_ADDR=127.0.0.1 manualmente antes de iniciar o servidor."
fi

echo "HTTPS configurado para https://$DOMINIO (proxy para 127.0.0.1:$PORTA)."
echo "TRUST_PROXY=1 e BIND_ADDR=127.0.0.1 gravados no .env. Reinicie: sudo systemctl restart remoteifes.service"

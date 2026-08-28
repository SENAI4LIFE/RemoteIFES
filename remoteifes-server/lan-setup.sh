#!/usr/bin/env bash
set -e

if [ "$EUID" -ne 0 ]; then
  echo "Rode este script como root (sudo bash lan-setup.sh)."
  exit 1
fi

cd "$(dirname "$0")"

if [ -f .env ]; then
  PORTA=$(grep -E '^PORTA=' .env | head -n1 | cut -d '=' -f2 | tr -d '[:space:]')
fi
PORTA=${PORTA:-8080}

if ! command -v nginx >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update && apt-get install -y nginx
  else
    echo "nginx não encontrado e não foi possível instalar automaticamente."
    echo "Instale o nginx (com o gerenciador de pacotes da distribuição) e rode este script de novo."
    exit 1
  fi
fi

SITE_PATH="/etc/nginx/sites-available/remoteifes"

cat > "$SITE_PATH" <<EOF
map \$http_upgrade \$connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    client_max_body_size 1m;

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
        proxy_send_timeout 1h;
    }
}
EOF

if [ -d /etc/nginx/sites-enabled ]; then
  ln -sf "$SITE_PATH" /etc/nginx/sites-enabled/remoteifes
  rm -f /etc/nginx/sites-enabled/default
fi

nginx -t
systemctl enable nginx
systemctl restart nginx

if [ -f .env ]; then
  for par in "TRUST_PROXY=1" "BIND_ADDR=127.0.0.1"; do
    chave="${par%%=*}"
    if grep -qE "^${chave}=" .env; then
      sed -i "s|^${chave}=.*|${par}|" .env
    else
      echo "$par" >> .env
    fi
  done
fi

echo "Proxy reverso HTTP na porta 80 configurado, apontando para 127.0.0.1:$PORTA."
echo "TRUST_PROXY=1 e BIND_ADDR=127.0.0.1 gravados no .env (o Node passa a escutar só em localhost, atrás do proxy)."
echo "Reinicie o servidor: sudo systemctl restart remoteifes.service"
echo "Acesse pela rede local em: http://<ip-do-servidor>/"
echo "Este script assume um host dedicado ao RemoteIFES (assume o site padrão do Nginx na porta 80)."

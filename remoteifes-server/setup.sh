#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

REQUIRED_MAJOR=22
REQUIRED_MINOR=13

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js não encontrado. Instale o Node.js $REQUIRED_MAJOR.$REQUIRED_MINOR ou superior: https://nodejs.org"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/^v//')
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
NODE_MINOR=$(echo "$NODE_VERSION" | cut -d. -f2)

if [ "$NODE_MAJOR" -lt "$REQUIRED_MAJOR" ] || { [ "$NODE_MAJOR" -eq "$REQUIRED_MAJOR" ] && [ "$NODE_MINOR" -lt "$REQUIRED_MINOR" ]; }; then
  echo "Node.js $NODE_VERSION encontrado, mas este projeto requer $REQUIRED_MAJOR.$REQUIRED_MINOR ou superior (usa o módulo nativo node:sqlite)."
  exit 1
fi

echo "Instalando dependências..."
npm install

if [ ! -f .env ]; then
  echo "Criando .env a partir de .env.example..."
  cp .env.example .env
  DEVICE_TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  if [ "$(uname)" = "Darwin" ]; then
    sed -i '' "s#^DEVICE_TOKEN=.*#DEVICE_TOKEN=$DEVICE_TOKEN#" .env
  else
    sed -i "s#^DEVICE_TOKEN=.*#DEVICE_TOKEN=$DEVICE_TOKEN#" .env
  fi
  echo "DEVICE_TOKEN gerado automaticamente em .env. Use o mesmo valor no firmware de cada ESP32."
else
  echo ".env já existe, mantido sem alterações."
fi

if [ -f data/remoteifes.db ]; then
  echo
  echo "Aviso: já existe um banco em data/remoteifes.db neste clone (provavelmente veio commitado no repositório)."
  echo "Isso significa que o usuário admin já foi criado antes e a senha inicial NÃO será impressa novamente."
  echo "Para definir uma nova senha para o admin sem apagar salas/MACs/presets já cadastrados, rode: npm run reset-admin"
fi

echo
echo "Setup concluído."
echo "O banco de dados SQLite é criado e populado automaticamente (usuário admin, salas e preset padrão) na primeira vez que o servidor iniciar."
echo "Para iniciar o servidor: npm start"
echo "Esqueceu ou perdeu a senha do admin? npm run reset-admin"

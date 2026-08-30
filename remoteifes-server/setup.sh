#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

REQUIRED_MAJOR=22
REQUIRED_MINOR=13
NODE_FALLBACK_VERSION="22.20.0"
NODE_DIST_BASE="https://nodejs.org/dist"

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local version major minor
  version=$(node -v | sed 's/^v//')
  major=$(echo "$version" | cut -d. -f1)
  minor=$(echo "$version" | cut -d. -f2)
  [ "$major" -gt "$REQUIRED_MAJOR" ] && return 0
  [ "$major" -eq "$REQUIRED_MAJOR" ] && [ "$minor" -ge "$REQUIRED_MINOR" ] && return 0
  return 1
}

resolve_node_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo "x64" ;;
    aarch64|arm64) echo "arm64" ;;
    armv7l|armv6l) echo "armv7l" ;;
    *) echo "" ;;
  esac
}

resolve_latest_node_version() {
  curl -fsSL "$NODE_DIST_BASE/latest-v22.x/SHASUMS256.txt" 2>/dev/null \
    | grep -m1 "linux-x64.tar.xz" \
    | awk '{print $2}' \
    | sed -E 's/node-v([0-9.]+)-linux-x64\.tar\.xz/\1/'
}

install_node_linux() {
  local node_arch version tmp_dir dest_dir sudo_cmd bin

  node_arch=$(resolve_node_arch)
  if [ -z "$node_arch" ]; then
    echo "Arquitetura $(uname -m) não suportada pela instalação automática. Instale o Node.js $REQUIRED_MAJOR.$REQUIRED_MINOR+ manualmente: https://nodejs.org/en/download"
    exit 1
  fi

  version=$(resolve_latest_node_version)
  [ -z "$version" ] && version="$NODE_FALLBACK_VERSION"

  echo "Instalando Node.js v$version ($node_arch) para hospedar o RemoteIFES..."

  sudo_cmd=""
  [ "$EUID" -ne 0 ] && [ ! -w /usr/local/lib ] && sudo_cmd="sudo"

  tmp_dir=$(mktemp -d)
  curl -fsSL "$NODE_DIST_BASE/v$version/node-v$version-linux-$node_arch.tar.xz" -o "$tmp_dir/node.tar.xz"

  dest_dir="/usr/local/lib/nodejs/node-v$version"
  $sudo_cmd mkdir -p "$dest_dir"
  $sudo_cmd tar -xJf "$tmp_dir/node.tar.xz" -C "$dest_dir" --strip-components=1
  rm -rf "$tmp_dir"

  for bin in node npm npx corepack; do
    [ -e "$dest_dir/bin/$bin" ] && $sudo_cmd ln -sf "$dest_dir/bin/$bin" "/usr/local/bin/$bin"
  done
}

install_node_macos() {
  if command -v brew >/dev/null 2>&1; then
    echo "Instalando Node.js via Homebrew..."
    brew install node
  else
    echo "Homebrew não encontrado. Instale o Node.js $REQUIRED_MAJOR.$REQUIRED_MINOR+ manualmente: https://nodejs.org/en/download"
    exit 1
  fi
}

if ! node_ok; then
  case "$(uname)" in
    Linux) install_node_linux ;;
    Darwin) install_node_macos ;;
    *)
      echo "Instale manualmente o Node.js $REQUIRED_MAJOR.$REQUIRED_MINOR ou superior: https://nodejs.org/en/download"
      exit 1
      ;;
  esac

  hash -r
  if ! node_ok; then
    echo "A instalação automática do Node.js falhou. Instale manualmente: https://nodejs.org/en/download"
    exit 1
  fi
fi

echo "Node.js $(node -v) pronto."

echo "Instalando dependências..."
npm install

if [ ! -f .env ]; then
  echo "Criando .env a partir de .env.example..."
  cp .env.example .env
else
  echo ".env já existe, mantido sem alterações."
fi

if [ -f data/remoteifes.db ]; then
  echo
  echo "Aviso: já existe um banco em data/remoteifes.db neste clone (provavelmente veio commitado no repositório)."
  echo "Isso significa que o superadministrador já foi criado antes e sua senha atual será preservada."
  echo "Para definir uma nova senha para o superadministrador sem apagar salas, MACs ou configurações, rode: npm run reset-admin"
fi

echo
echo "Setup concluído."
echo "O banco de dados SQLite é criado e populado automaticamente na primeira vez que o servidor iniciar. Em produção, uma senha aleatória do superadministrador é gerada se SENHA_ADMIN_INICIAL não for definida."
echo "Para iniciar o servidor: npm start"
echo "Para manter o servidor rodando permanentemente (Raspberry Pi ou qualquer Linux com systemd): sudo bash install-service.sh"
echo "Esqueceu ou perdeu a senha do superadministrador? npm run reset-admin"

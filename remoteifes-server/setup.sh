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

# The archive is checked against the SHA-256 the release publishes in SHASUMS256.txt before anything
# is extracted with elevated privileges: a truncated, corrupted or substituted download stops here.
# A checksum that cannot be fetched or computed is a failure too, never a skipped check.
verify_node_archive() {
  local version="$1" file="$2" archive="$3" sums expected actual
  sums=$(curl -fsSL "$NODE_DIST_BASE/v$version/SHASUMS256.txt") || return 1
  expected=$(printf '%s\n' "$sums" | awk -v f="$file" '$2 == f { print $1; exit }')
  [ -n "$expected" ] || return 1
  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$archive" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    actual=$(shasum -a 256 "$archive" | awk '{print $1}')
  else
    return 1
  fi
  [ "$actual" = "$expected" ]
}

install_node_linux() {
  local node_arch version tmp_dir dest_dir sudo_cmd bin file

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
  file="node-v$version-linux-$node_arch.tar.xz"
  curl -fsSL "$NODE_DIST_BASE/v$version/$file" -o "$tmp_dir/node.tar.xz"
  if ! verify_node_archive "$version" "$file" "$tmp_dir/node.tar.xz"; then
    rm -rf "$tmp_dir"
    echo "O Node.js baixado não confere com o SHA-256 publicado em $NODE_DIST_BASE/v$version/SHASUMS256.txt (ou a soma não pôde ser obtida). Nada foi instalado; tente de novo ou instale manualmente: https://nodejs.org/en/download"
    exit 1
  fi

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
echo "O banco de dados SQLite é criado e populado automaticamente na primeira vez que o servidor iniciar. Sem SENHA_ADMIN_INICIAL, use superadmin/admin e altere a senha pelo aviso exibido no sistema."
echo "Para iniciar o servidor: npm start"
echo "Aplicação integrada: http://localhost:8080"
echo "Para manter o servidor rodando permanentemente (Raspberry Pi ou qualquer Linux com systemd): sudo bash install-service.sh"
echo "Esqueceu ou perdeu a senha do superadministrador? npm run reset-admin"

#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

PORT="$1"
PORT_ARGS=()
if [ -n "$PORT" ]; then
  PORT_ARGS=(--upload-port "$PORT")
fi

install_platformio() {
  command -v pio >/dev/null 2>&1 && return
  echo "Instalando PlatformIO Core..."
  if command -v pipx >/dev/null 2>&1; then
    pipx install platformio
  elif python3 -m pip --version >/dev/null 2>&1; then
    python3 -m pip install --user -U platformio
  else
    echo "Instale o pipx (recomendado) ou o pip para Python 3 e rode este script novamente."
    exit 1
  fi
  export PATH="$HOME/.local/bin:$PATH"
}

install_platformio

echo "Compilando firmware..."
pio run

echo "Gravando o sistema de arquivos (data/) no ESP32..."
pio run --target uploadfs "${PORT_ARGS[@]}"

echo "Gravando firmware no ESP32..."
pio run --target upload "${PORT_ARGS[@]}"

echo
echo "Firmware gravado com sucesso."
echo "No primeiro boot, o ESP32 abre a rede Wi-Fi aberta 'RemoteIFES-Setup'."
echo "Conecte-se a ela para informar a rede local e o endereço do servidor central."
echo "Depois, vincule o endereço MAC do dispositivo a uma sala no painel web."

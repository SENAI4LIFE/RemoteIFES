#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

PORT="$1"

install_platformio() {
  command -v pio >/dev/null 2>&1 && return
  echo "Instalando PlatformIO Core..."
  python3 -m pip install --user -U platformio
  export PATH="$HOME/.local/bin:$PATH"
}

detect_port_flag() {
  if [ -n "$PORT" ]; then
    echo "--upload-port $PORT"
  fi
}

install_platformio

echo "Compilando firmware..."
pio run

echo "Gravando o sistema de arquivos (data/) no ESP32..."
pio run --target uploadfs $(detect_port_flag)

echo "Gravando firmware no ESP32..."
pio run --target upload $(detect_port_flag)

echo
echo "Firmware gravado com sucesso."
echo "No primeiro boot, o ESP32 abre a rede Wi-Fi 'RemoteIFES-Setup' (protegida por senha,"
echo "exibida no monitor serial); conecte-se a ela para informar a rede local, a sala, o"
echo "endereço/token do servidor central e a senha de administração do dispositivo."

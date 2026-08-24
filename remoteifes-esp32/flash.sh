#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

FQBN="${2:-esp32:esp32:esp32}"
PORT="$1"
BOARD_URL="https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json"
LIBS=("IRremoteESP8266" "WebSockets" "DHT sensor library" "Adafruit Unified Sensor")

install_arduino_cli() {
  command -v arduino-cli >/dev/null 2>&1 && return
  echo "Instalando arduino-cli..."
  mkdir -p "$HOME/.local/bin"
  curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh | BINDIR="$HOME/.local/bin" sh
  export PATH="$HOME/.local/bin:$PATH"
}

setup_core_and_libs() {
  [ ! -f "$HOME/.arduino15/arduino-cli.yaml" ] && arduino-cli config init
  arduino-cli config set board_manager.additional_urls "$BOARD_URL"
  echo "Atualizando índice de placas..."
  arduino-cli core update-index
  echo "Instalando core ESP32..."
  arduino-cli core install esp32:esp32
  echo "Instalando bibliotecas necessárias..."
  arduino-cli lib install "${LIBS[@]}"
}

detect_port() {
  [ -n "$PORT" ] && return
  PORT=$(arduino-cli board list | awk 'NR==2{print $1}')
  if [ -z "$PORT" ]; then
    echo "Nenhuma porta serial detectada. Conecte o ESP32 via USB e tente novamente,"
    echo "ou informe a porta manualmente: bash flash.sh /dev/ttyUSB0"
    exit 1
  fi
}

install_arduino_cli
setup_core_and_libs
detect_port

echo "Compilando firmware ($FQBN)..."
arduino-cli compile --fqbn "$FQBN" .

echo "Gravando no ESP32 em $PORT..."
arduino-cli upload -p "$PORT" --fqbn "$FQBN" .

echo
echo "Firmware gravado com sucesso."
echo "No primeiro boot, o ESP32 abre a rede Wi-Fi 'RemoteIFES-Setup'; conecte-se a ela"
echo "para informar a rede local, a sala, e o endereço/token do servidor central."

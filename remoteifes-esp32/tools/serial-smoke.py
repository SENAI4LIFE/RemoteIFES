#!/usr/bin/env python3
import sys
import time

try:
    import serial
except ImportError:
    print("pyserial ausente: pip install pyserial", file=sys.stderr)
    sys.exit(2)

PORT = sys.argv[1] if len(sys.argv) > 1 else "/dev/ttyUSB0"
BAUD = int(sys.argv[2]) if len(sys.argv) > 2 else 115200
JANELA_S = 20

MARCADORES_OBRIGATORIOS = ["RemoteIFES IR System Initializing"]
MARCADORES_REDE = ["Conectando a rede salva", "Wi-Fi reconectado", "IP:", "RemoteIFES-Setup"]


def main():
    try:
        s = serial.Serial(PORT, BAUD, timeout=1)
    except serial.SerialException as e:
        print(f"nao foi possivel abrir {PORT}: {e}", file=sys.stderr)
        return 2

    try:
        s.dtr = False
        s.rts = True
        time.sleep(0.1)
        s.rts = False
        time.sleep(0.1)
        s.reset_input_buffer()

        capturado = b""
        fim = time.time() + JANELA_S
        while time.time() < fim:
            chunk = s.read(4096)
            if chunk:
                capturado += chunk
    finally:
        s.close()

    texto = capturado.decode("utf-8", "replace")
    sys.stdout.write(texto)
    if not texto.endswith("\n"):
        sys.stdout.write("\n")

    faltando = [m for m in MARCADORES_OBRIGATORIOS if m not in texto]
    if faltando:
        print(f"FALHA: marcadores de boot ausentes: {faltando}", file=sys.stderr)
        return 1
    if not any(m in texto for m in MARCADORES_REDE):
        print("FALHA: nenhum sinal de atividade de rede/portal apos o boot", file=sys.stderr)
        return 1

    print("OK: firmware inicializou e entrou na rotina de rede", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())

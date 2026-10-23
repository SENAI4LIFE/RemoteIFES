#include <math.h>
#include <stdint.h>
#include <stdio.h>

#include "../src/aht10.h"

static int falhas = 0;

static void conferir(bool condicao, const char* o_que) {
  if (!condicao) {
    fprintf(stderr, "FALHOU: %s\n", o_que);
    falhas++;
  }
}

static bool perto(float valor, double esperado) {
  return fabs((double)valor - esperado) < 0.0005;
}

int main() {
  float t = 0;
  float h = 0;

  const uint8_t meio[6] = {0x08, 0x80, 0x00, 0x08, 0x00, 0x00};
  conferir(aht10Converter(meio, &t, &h), "amostra com o bit de ocupado limpo e aceita");
  conferir(perto(h, 50.0) && perto(t, 50.0), "2^19 vale 50 % de umidade e 50 C");

  const uint8_t misto[6] = {0x1C, 0x12, 0x34, 0x56, 0x78, 0x9A};
  conferir(aht10Converter(misto, &t, &h), "o byte de estado so descarta pelo bit de ocupado");
  conferir(perto(h, 0x12345 / 1048576.0 * 100.0), "a umidade usa os 20 bits que comecam no byte 1");
  conferir(perto(t, 0x6789A / 1048576.0 * 200.0 - 50.0), "a temperatura usa o nibble baixo do byte 3 e os bytes 4 e 5");

  const uint8_t zero[6] = {0x00, 0x00, 0x00, 0x00, 0x00, 0x00};
  conferir(aht10Converter(zero, &t, &h), "zero e uma amostra valida");
  conferir(perto(h, 0.0) && perto(t, -50.0), "o bruto zero vale 0 % e -50 C");

  const uint8_t maximo[6] = {0x08, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};
  conferir(aht10Converter(maximo, &t, &h), "o bruto maximo e uma amostra valida");
  conferir(perto(h, 0xFFFFF / 1048576.0 * 100.0) && perto(t, 0xFFFFF / 1048576.0 * 200.0 - 50.0), "o bruto maximo fica abaixo de 100 % e 150 C");

  const uint8_t ocupado[6] = {0x88, 0x80, 0x00, 0x08, 0x00, 0x00};
  t = 25.0f;
  h = 40.0f;
  conferir(!aht10Converter(ocupado, &t, &h), "amostra com o bit de ocupado e descartada");
  conferir(isnan(t) && isnan(h), "a amostra descartada vira NAN, como uma leitura falha do DHT");

  conferir(!aht10MedicaoPronta(1079, 1000, 80), "antes de 80 ms a medicao nao e lida");
  conferir(aht10MedicaoPronta(1080, 1000, 80), "a partir de 80 ms a medicao e lida");
  conferir(!aht10MedicaoPronta(1000, 1000, 80), "no instante do disparo a medicao nao esta pronta");
  conferir(aht10MedicaoPronta(40, UINT32_MAX - 39, 80), "o prazo atravessa o estouro do millis");
  conferir(!aht10MedicaoPronta(30, UINT32_MAX - 39, 80), "antes do prazo mesmo depois do estouro do millis");

  conferir(AHT10_ENDERECO == 0x38, "endereco I2C do AHT10");
  conferir(AHT10_COMANDO_INICIAR[0] == 0xE1 && AHT10_COMANDO_INICIAR[1] == 0x08 && AHT10_COMANDO_INICIAR[2] == 0x00, "comando de inicializacao do datasheet");
  conferir(AHT10_COMANDO_MEDIR[0] == 0xAC && AHT10_COMANDO_MEDIR[1] == 0x33 && AHT10_COMANDO_MEDIR[2] == 0x00, "comando de medicao do datasheet");

  if (falhas) return 1;
  printf("ok\n");
  return 0;
}

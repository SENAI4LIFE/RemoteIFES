#pragma once

#include <math.h>
#include <stdint.h>

const uint8_t AHT10_ENDERECO = 0x38;
const uint8_t AHT10_COMANDO_INICIAR[3] = {0xE1, 0x08, 0x00};
const uint8_t AHT10_COMANDO_MEDIR[3] = {0xAC, 0x33, 0x00};
const uint8_t AHT10_BIT_OCUPADO = 0x80;

inline bool aht10MedicaoPronta(uint32_t agora, uint32_t disparadaEm, uint32_t esperaMs) {
  return (uint32_t)(agora - disparadaEm) >= esperaMs;
}

inline bool aht10Converter(const uint8_t dados[6], float* temperatura, float* umidade) {
  if (dados[0] & AHT10_BIT_OCUPADO) {
    *temperatura = NAN;
    *umidade = NAN;
    return false;
  }
  const uint32_t umidadeBruta = ((uint32_t)dados[1] << 12) | ((uint32_t)dados[2] << 4) | (dados[3] >> 4);
  const uint32_t temperaturaBruta = (((uint32_t)dados[3] & 0x0F) << 16) | ((uint32_t)dados[4] << 8) | dados[5];
  *umidade = (float)umidadeBruta / 1048576.0f * 100.0f;
  *temperatura = (float)temperaturaBruta / 1048576.0f * 200.0f - 50.0f;
  return true;
}

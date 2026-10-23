#pragma once

#include <stdint.h>

inline bool deveReemitirConexaoWifi(uint32_t agora, uint32_t desconectadoDesde, uint32_t prazoMs, bool modoDireto) {
  return modoDireto && desconectadoDesde != 0 && (uint32_t)(agora - desconectadoDesde) >= prazoMs;
}

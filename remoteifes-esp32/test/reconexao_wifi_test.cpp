#include <stdint.h>
#include <stdio.h>

#include "../src/reconexao_wifi.h"

static int falhas = 0;

static void conferir(bool condicao, const char* o_que) {
  if (!condicao) {
    fprintf(stderr, "FALHOU: %s\n", o_que);
    falhas++;
  }
}

int main() {
  const uint32_t prazo = 30000;
  conferir(!deveReemitirConexaoWifi(5000, 0, prazo, true), "sem desconexao registrada nada e reemitido");
  conferir(!deveReemitirConexaoWifi(1000, 1000, prazo, true), "a primeira tentativa de um episodio usa reconnect");
  conferir(!deveReemitirConexaoWifi(1000 + prazo - 1, 1000, prazo, true), "antes do prazo nada e reemitido");
  conferir(deveReemitirConexaoWifi(1000 + prazo, 1000, prazo, true), "no prazo a conexao e reemitida");
  conferir(deveReemitirConexaoWifi(1000 + 10 * prazo, 1000, prazo, true), "depois do prazo a conexao continua sendo reemitida");
  conferir(!deveReemitirConexaoWifi(1000 + 10 * prazo, 1000, prazo, false), "fora do modo direto a malha cuida da conexao");
  conferir(deveReemitirConexaoWifi(20000, UINT32_MAX - 9999, prazo, true), "o prazo atravessa o estouro do millis");
  conferir(!deveReemitirConexaoWifi(10000, UINT32_MAX - 9999, prazo, true), "antes do prazo mesmo depois do estouro do millis");
  if (falhas) return 1;
  printf("ok\n");
  return 0;
}

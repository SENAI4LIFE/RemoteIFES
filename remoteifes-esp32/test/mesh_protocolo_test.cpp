// Host test for the firmware's mesh protocol implementation (src/mesh_protocolo.cpp).
//
// The expected values are the vectors in mesh-vetores.json, which the server's own implementation
// produced; mesh-protocol.test.js compiles this file and passes them as arguments. Running the same
// firmware code on the host is what catches a wrong separator, a wrong nonce byte order or a wrong
// base64 alphabet before a board is flashed, because on the wire those mistakes look exactly like an
// invalid credential.

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <string>

#include "../src/mesh_protocolo.h"

static int falhas = 0;

static void conferir(bool condicao, const char* o_que) {
  if (!condicao) {
    fprintf(stderr, "FALHOU: %s\n", o_que);
    falhas++;
  }
}

static void conferirTexto(const std::string& obtido, const std::string& esperado, const char* o_que) {
  if (obtido != esperado) {
    fprintf(stderr, "FALHOU: %s\n  esperado: %s\n  obtido:   %s\n", o_que, esperado.c_str(), obtido.c_str());
    falhas++;
  }
}

static std::string hex(const uint8_t* dados, size_t n) {
  static const char* digitos = "0123456789abcdef";
  std::string saida;
  for (size_t i = 0; i < n; i++) {
    saida += digitos[(dados[i] >> 4) & 0xF];
    saida += digitos[dados[i] & 0xF];
  }
  return saida;
}

int main(int argc, char** argv) {
  if (argc != 18) {
    fprintf(stderr, "uso: %s <segredo> <no> <gateway> <ns> <nn> <chave> <chaveSessao> <provaOla> <provaAceito>"
                    " <seqNo> <dadosNo> <tagNo> <textoNo> <seqServidor> <dadosServidor> <tagServidor> <textoServidor>\n",
            argv[0]);
    return 2;
  }
  const std::string segredo = argv[1];
  const std::string no = argv[2];
  const std::string gateway = argv[3];
  const std::string ns = argv[4];
  const std::string nn = argv[5];
  const std::string chaveEsperada = argv[6];
  const std::string sessaoEsperada = argv[7];
  const std::string provaOlaEsperada = argv[8];
  const std::string provaAceitoEsperada = argv[9];
  const uint64_t seqNo = strtoull(argv[10], nullptr, 10);
  const std::string dadosNo = argv[11];
  const std::string tagNo = argv[12];
  const std::string textoNo = argv[13];
  const uint64_t seqServidor = strtoull(argv[14], nullptr, 10);
  const std::string dadosServidor = argv[15];
  const std::string tagServidor = argv[16];
  const std::string textoServidor = argv[17];

  uint8_t chave[meshp::CHAVE_BYTES];
  meshp::chaveDoSegredo(segredo, chave);
  conferirTexto(hex(chave, sizeof(chave)), chaveEsperada, "K = HMAC(segredo, \"remoteifes-mesh-v1\")");

  uint8_t sessao[meshp::CHAVE_BYTES];
  meshp::chaveDeSessao(chave, ns, nn, sessao);
  conferirTexto(hex(sessao, sizeof(sessao)), sessaoEsperada, "Ks = HMAC(K, \"sessao|ns|nn\")");

  conferirTexto(meshp::provaOla(chave, no, gateway, ns, nn), provaOlaEsperada, "prova do \"ola\"");
  conferirTexto(meshp::provaAceito(sessao, no), provaAceitoEsperada, "prova do \"aceito\"");

  // The node seals exactly the bytes the server opens.
  std::string dados;
  std::string tag;
  conferir(meshp::selar(sessao, no, meshp::DIRECAO_NO, seqNo, textoNo, &dados, &tag), "selar (nó → servidor)");
  conferirTexto(dados, dadosNo, "ciphertext do nó");
  conferirTexto(tag, tagNo, "tag do nó");

  // And opens exactly what the server sealed.
  std::string aberto;
  conferir(meshp::abrir(sessao, no, meshp::DIRECAO_SERVIDOR, seqServidor, dadosServidor, tagServidor, &aberto),
           "abrir (servidor → nó)");
  conferirTexto(aberto, textoServidor, "plaintext do servidor");

  // A tampered tag is refused: the frame is authenticated, not just encrypted.
  std::string tagRuim = tagServidor;
  tagRuim[0] = tagRuim[0] == 'A' ? 'B' : 'A';
  conferir(!meshp::abrir(sessao, no, meshp::DIRECAO_SERVIDOR, seqServidor, dadosServidor, tagRuim, &aberto),
           "tag alterada deve ser recusada");

  // A frame replayed under a different sequence number does not open: the nonce carries the seq.
  conferir(!meshp::abrir(sessao, no, meshp::DIRECAO_SERVIDOR, seqServidor + 1, dadosServidor, tagServidor, &aberto),
           "quadro reapresentado com outro seq deve ser recusado");

  // And it does not open in the other direction either: the nonce carries the direction.
  conferir(!meshp::abrir(sessao, no, meshp::DIRECAO_NO, seqServidor, dadosServidor, tagServidor, &aberto),
           "quadro do servidor não deve abrir como quadro do nó");

  // The AAD binds the frame to the board: another deviceId cannot open it.
  conferir(!meshp::abrir(sessao, "esp_0000000000000000", meshp::DIRECAO_SERVIDOR, seqServidor, dadosServidor,
                         tagServidor, &aberto),
           "quadro não deve abrir com outro deviceId no AAD");

  // Another secret derives another key, so its session cannot read the frame.
  uint8_t outraChave[meshp::CHAVE_BYTES];
  uint8_t outraSessao[meshp::CHAVE_BYTES];
  meshp::chaveDoSegredo(segredo + "x", outraChave);
  meshp::chaveDeSessao(outraChave, ns, nn, outraSessao);
  conferir(!meshp::abrir(outraSessao, no, meshp::DIRECAO_SERVIDOR, seqServidor, dadosServidor, tagServidor, &aberto),
           "outro segredo não deve abrir o quadro");

  // base64url round trip, including the lengths that need one and two leftover bytes.
  for (size_t n = 0; n <= 34; n++) {
    std::string bruto;
    for (size_t i = 0; i < n; i++) bruto += static_cast<char>((i * 37 + 11) & 0xFF);
    const std::string texto = meshp::base64url(reinterpret_cast<const uint8_t*>(bruto.data()), bruto.size());
    conferir(texto.find('=') == std::string::npos, "base64url não usa preenchimento");
    std::string volta;
    conferir(meshp::deBase64url(texto, &volta), "deBase64url aceita o que base64url produz");
    conferir(volta == bruto, "base64url ida e volta");
  }
  std::string lixo;
  conferir(!meshp::deBase64url("abc+", &lixo), "caractere fora do alfabeto base64url deve ser recusado");
  conferir(!meshp::deBase64url("A", &lixo), "comprimento impossível deve ser recusado");

  conferir(meshp::iguais(provaOlaEsperada, provaOlaEsperada), "iguais reconhece provas idênticas");
  conferir(!meshp::iguais(provaOlaEsperada, provaAceitoEsperada), "iguais separa provas diferentes");

  if (falhas) {
    fprintf(stderr, "%d verificação(ões) falharam\n", falhas);
    return 1;
  }
  printf("mesh protocolo: todas as verificações passaram\n");
  return 0;
}

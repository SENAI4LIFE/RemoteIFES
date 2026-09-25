#pragma once

#include <stddef.h>
#include <stdint.h>

#include <string>

// Board side of the mesh protocol, version 1 (remoteifes-esp32/MESH.md).
//
// Nothing here touches the radio or the Arduino core, so the same code that runs on the ESP32 is
// compiled and exercised on a host by remoteifes-esp32/test/mesh_protocolo_test.cpp. That matters
// because the bytes below have to match the server's implementation exactly: a wrong separator in a
// proof string or a wrong nonce byte order fails as "credencial inválida" on the server, which is
// indistinguishable from a real credential problem.
//
// The crypto primitives come from mbedTLS on the ESP32 and from OpenSSL on the host
// (-DMESH_CRYPTO_OPENSSL). Only those two wrappers differ; the protocol is one implementation.

namespace meshp {

const size_t CHAVE_BYTES = 32;
const size_t TAG_BYTES = 16;
const size_t NONCE_BYTES = 12;

// Direction byte of the nonce. Server->node and node->server frames can never be replayed into the
// other direction, because the key is the same but the nonce is not.
const uint8_t DIRECAO_SERVIDOR = 0x01;
const uint8_t DIRECAO_NO = 0x02;

std::string base64url(const uint8_t* dados, size_t n);
bool deBase64url(const std::string& texto, std::string* saida);

/** K = HMAC-SHA256(board secret, "remoteifes-mesh-v1"). The gateway never holds it. */
void chaveDoSegredo(const std::string& segredo, uint8_t chave[CHAVE_BYTES]);

/** Ks = HMAC-SHA256(K, "sessao|<ns>|<nn>"). */
void chaveDeSessao(const uint8_t chave[CHAVE_BYTES], const std::string& ns, const std::string& nn,
                   uint8_t sessao[CHAVE_BYTES]);

/** Proof the node sends in "ola": HMAC(K, "ola|<no>|<gateway>|<ns>|<nn>"), base64url. */
std::string provaOla(const uint8_t chave[CHAVE_BYTES], const std::string& no, const std::string& gateway,
                     const std::string& ns, const std::string& nn);

/** Proof the server sends in "aceito": HMAC(Ks, "aceito|<no>"), base64url. Mutual authentication. */
std::string provaAceito(const uint8_t sessao[CHAVE_BYTES], const std::string& no);

/** Seals one frame. AES-256-GCM, AAD = the node's deviceId, nonce = direction + seq. */
bool selar(const uint8_t sessao[CHAVE_BYTES], const std::string& no, uint8_t direcao, uint64_t seq,
           const std::string& texto, std::string* dados, std::string* tag);

/** Opens one frame. Returns false for a wrong tag, wrong key, wrong seq or malformed base64url. */
bool abrir(const uint8_t sessao[CHAVE_BYTES], const std::string& no, uint8_t direcao, uint64_t seq,
           const std::string& dados, const std::string& tag, std::string* texto);

/** Constant-time comparison, for proofs. */
bool iguais(const std::string& a, const std::string& b);

}  // namespace meshp

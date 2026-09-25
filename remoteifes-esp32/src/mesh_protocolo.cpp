#include "mesh_protocolo.h"

#include <string.h>

#ifdef MESH_CRYPTO_OPENSSL
#include <openssl/evp.h>
#include <openssl/hmac.h>
#else
#include "mbedtls/gcm.h"
#include "mbedtls/md.h"
#endif

namespace meshp {
namespace {

const char ALFABETO[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

int valorBase64url(char c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '-') return 62;
  if (c == '_') return 63;
  return -1;
}

void hmacSha256(const uint8_t* chave, size_t chaveN, const uint8_t* dados, size_t dadosN,
                uint8_t saida[CHAVE_BYTES]) {
#ifdef MESH_CRYPTO_OPENSSL
  unsigned int n = 0;
  HMAC(EVP_sha256(), chave, static_cast<int>(chaveN), dados, dadosN, saida, &n);
#else
  mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), chave, chaveN, dados, dadosN, saida);
#endif
}

std::string hmacB64(const uint8_t* chave, size_t chaveN, const std::string& texto) {
  uint8_t mac[CHAVE_BYTES];
  hmacSha256(chave, chaveN, reinterpret_cast<const uint8_t*>(texto.data()), texto.size(), mac);
  return base64url(mac, sizeof(mac));
}

#ifdef MESH_CRYPTO_OPENSSL
bool gcm(bool cifrar, const uint8_t chave[CHAVE_BYTES], const uint8_t nonce[NONCE_BYTES],
         const uint8_t* aad, size_t aadN, const uint8_t* entrada, size_t entradaN, uint8_t* saida,
         uint8_t tag[TAG_BYTES]) {
  EVP_CIPHER_CTX* ctx = EVP_CIPHER_CTX_new();
  if (!ctx) return false;
  bool ok = false;
  int n = 0;
  do {
    if (EVP_CipherInit_ex(ctx, EVP_aes_256_gcm(), nullptr, nullptr, nullptr, cifrar ? 1 : 0) != 1) break;
    if (EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_AEAD_SET_IVLEN, NONCE_BYTES, nullptr) != 1) break;
    if (EVP_CipherInit_ex(ctx, nullptr, nullptr, chave, nonce, cifrar ? 1 : 0) != 1) break;
    if (aadN && EVP_CipherUpdate(ctx, nullptr, &n, aad, static_cast<int>(aadN)) != 1) break;
    if (!cifrar && EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_AEAD_SET_TAG, TAG_BYTES, const_cast<uint8_t*>(tag)) != 1) break;
    if (entradaN && EVP_CipherUpdate(ctx, saida, &n, entrada, static_cast<int>(entradaN)) != 1) break;
    int resto = 0;
    if (EVP_CipherFinal_ex(ctx, saida + n, &resto) != 1) break;
    if (cifrar && EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_AEAD_GET_TAG, TAG_BYTES, tag) != 1) break;
    ok = true;
  } while (false);
  EVP_CIPHER_CTX_free(ctx);
  return ok;
}
#else
bool gcm(bool cifrar, const uint8_t chave[CHAVE_BYTES], const uint8_t nonce[NONCE_BYTES],
         const uint8_t* aad, size_t aadN, const uint8_t* entrada, size_t entradaN, uint8_t* saida,
         uint8_t tag[TAG_BYTES]) {
  mbedtls_gcm_context ctx;
  mbedtls_gcm_init(&ctx);
  bool ok = false;
  if (mbedtls_gcm_setkey(&ctx, MBEDTLS_CIPHER_ID_AES, chave, CHAVE_BYTES * 8) == 0) {
    if (cifrar) {
      ok = mbedtls_gcm_crypt_and_tag(&ctx, MBEDTLS_GCM_ENCRYPT, entradaN, nonce, NONCE_BYTES, aad, aadN,
                                     entrada, saida, TAG_BYTES, tag) == 0;
    } else {
      ok = mbedtls_gcm_auth_decrypt(&ctx, entradaN, nonce, NONCE_BYTES, aad, aadN, tag, TAG_BYTES, entrada,
                                    saida) == 0;
    }
  }
  mbedtls_gcm_free(&ctx);
  return ok;
}
#endif

void montarNonce(uint8_t direcao, uint64_t seq, uint8_t nonce[NONCE_BYTES]) {
  memset(nonce, 0, NONCE_BYTES);
  nonce[0] = direcao;
  for (int i = 0; i < 8; i++) nonce[4 + i] = static_cast<uint8_t>((seq >> (56 - 8 * i)) & 0xFF);
}

}  // namespace

std::string base64url(const uint8_t* dados, size_t n) {
  std::string saida;
  saida.reserve((n + 2) / 3 * 4);
  for (size_t i = 0; i < n; i += 3) {
    const size_t restantes = n - i;
    const uint32_t bloco = (static_cast<uint32_t>(dados[i]) << 16) |
                           (restantes > 1 ? static_cast<uint32_t>(dados[i + 1]) << 8 : 0) |
                           (restantes > 2 ? static_cast<uint32_t>(dados[i + 2]) : 0);
    saida += ALFABETO[(bloco >> 18) & 0x3F];
    saida += ALFABETO[(bloco >> 12) & 0x3F];
    // No padding: base64url without "=" is what the server produces and accepts.
    if (restantes > 1) saida += ALFABETO[(bloco >> 6) & 0x3F];
    if (restantes > 2) saida += ALFABETO[bloco & 0x3F];
  }
  return saida;
}

bool deBase64url(const std::string& texto, std::string* saida) {
  if (!saida) return false;
  saida->clear();
  if (texto.size() % 4 == 1) return false;
  uint32_t acumulado = 0;
  int bits = 0;
  for (const char c : texto) {
    const int v = valorBase64url(c);
    if (v < 0) return false;
    acumulado = (acumulado << 6) | static_cast<uint32_t>(v);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      *saida += static_cast<char>((acumulado >> bits) & 0xFF);
    }
  }
  return true;
}

void chaveDoSegredo(const std::string& segredo, uint8_t chave[CHAVE_BYTES]) {
  static const char ROTULO[] = "remoteifes-mesh-v1";
  hmacSha256(reinterpret_cast<const uint8_t*>(segredo.data()), segredo.size(),
             reinterpret_cast<const uint8_t*>(ROTULO), sizeof(ROTULO) - 1, chave);
}

void chaveDeSessao(const uint8_t chave[CHAVE_BYTES], const std::string& ns, const std::string& nn,
                   uint8_t sessao[CHAVE_BYTES]) {
  const std::string texto = "sessao|" + ns + "|" + nn;
  hmacSha256(chave, CHAVE_BYTES, reinterpret_cast<const uint8_t*>(texto.data()), texto.size(), sessao);
}

std::string provaOla(const uint8_t chave[CHAVE_BYTES], const std::string& no, const std::string& gateway,
                     const std::string& ns, const std::string& nn) {
  return hmacB64(chave, CHAVE_BYTES, "ola|" + no + "|" + gateway + "|" + ns + "|" + nn);
}

std::string provaAceito(const uint8_t sessao[CHAVE_BYTES], const std::string& no) {
  return hmacB64(sessao, CHAVE_BYTES, "aceito|" + no);
}

bool selar(const uint8_t sessao[CHAVE_BYTES], const std::string& no, uint8_t direcao, uint64_t seq,
           const std::string& texto, std::string* dados, std::string* tag) {
  if (!dados || !tag) return false;
  uint8_t nonce[NONCE_BYTES];
  montarNonce(direcao, seq, nonce);
  std::string cifrado(texto.size(), '\0');
  uint8_t marca[TAG_BYTES];
  if (!gcm(true, sessao, nonce, reinterpret_cast<const uint8_t*>(no.data()), no.size(),
           reinterpret_cast<const uint8_t*>(texto.data()), texto.size(),
           texto.empty() ? nullptr : reinterpret_cast<uint8_t*>(&cifrado[0]), marca)) {
    return false;
  }
  *dados = base64url(reinterpret_cast<const uint8_t*>(cifrado.data()), cifrado.size());
  *tag = base64url(marca, sizeof(marca));
  return true;
}

bool abrir(const uint8_t sessao[CHAVE_BYTES], const std::string& no, uint8_t direcao, uint64_t seq,
           const std::string& dados, const std::string& tag, std::string* texto) {
  if (!texto) return false;
  std::string cifrado;
  std::string marca;
  if (!deBase64url(dados, &cifrado) || !deBase64url(tag, &marca)) return false;
  if (marca.size() != TAG_BYTES) return false;
  uint8_t nonce[NONCE_BYTES];
  montarNonce(direcao, seq, nonce);
  std::string claro(cifrado.size(), '\0');
  if (!gcm(false, sessao, nonce, reinterpret_cast<const uint8_t*>(no.data()), no.size(),
           reinterpret_cast<const uint8_t*>(cifrado.data()), cifrado.size(),
           cifrado.empty() ? nullptr : reinterpret_cast<uint8_t*>(&claro[0]),
           reinterpret_cast<uint8_t*>(&marca[0]))) {
    return false;
  }
  *texto = claro;
  return true;
}

bool iguais(const std::string& a, const std::string& b) {
  if (a.size() != b.size()) return false;
  uint8_t diferenca = 0;
  for (size_t i = 0; i < a.size(); i++) diferenca |= static_cast<uint8_t>(a[i]) ^ static_cast<uint8_t>(b[i]);
  return diferenca == 0;
}

}  // namespace meshp

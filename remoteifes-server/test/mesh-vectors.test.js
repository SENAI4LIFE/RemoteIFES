const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const credenciais = require("../src/services/esp32CredenciaisService");
const mesh = require("../src/services/meshService");

// The firmware is written against remoteifes-esp32/test/mesh-vetores.json and its host test asserts
// it reproduces those bytes. This test asserts the SERVER still reproduces the same bytes, so a
// change on either side that would break a real board fails here instead of on the bench.

const VETORES = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "..", "remoteifes-esp32", "test", "mesh-vetores.json"), "utf8")
);

const { DIRECAO, selar, abrir, hmac, b64 } = mesh.protocolo;

test("the server reproduces the mesh vectors the firmware is written against", () => {
  const chave = Buffer.from(VETORES.chave, "hex");
  assert.equal(credenciais.chaveMeshDe(VETORES.segredo), VETORES.chave, "K vem do segredo da placa");

  const chaveSessao = hmac(chave, `sessao|${VETORES.ns}|${VETORES.nn}`);
  assert.equal(chaveSessao.toString("hex"), VETORES.chaveSessao);

  assert.equal(
    b64(hmac(chave, `ola|${VETORES.no}|${VETORES.gateway}|${VETORES.ns}|${VETORES.nn}`)),
    VETORES.provaOla
  );
  assert.equal(b64(hmac(chaveSessao, `aceito|${VETORES.no}`)), VETORES.provaAceito);

  const doServidor = selar(
    chaveSessao,
    VETORES.no,
    DIRECAO.servidor,
    VETORES.quadroDoServidor.seq,
    JSON.parse(VETORES.quadroDoServidor.texto)
  );
  assert.equal(doServidor.dados, VETORES.quadroDoServidor.dados);
  assert.equal(doServidor.tag, VETORES.quadroDoServidor.tag);

  const doNo = abrir(chaveSessao, VETORES.no, DIRECAO.no, {
    seq: VETORES.quadroDoNo.seq,
    dados: VETORES.quadroDoNo.dados,
    tag: VETORES.quadroDoNo.tag,
  });
  assert.deepEqual(doNo, JSON.parse(VETORES.quadroDoNo.texto));
});

test("the vectors use a deviceId the server accepts and a key length the cipher requires", () => {
  assert.match(VETORES.no, /^esp_[0-9a-f]{16}$/);
  assert.match(VETORES.gateway, /^esp_[0-9a-f]{16}$/);
  assert.equal(Buffer.from(VETORES.chaveSessao, "hex").length, 32, "AES-256 needs a 32-byte key");
  assert.equal(Buffer.from(VETORES.quadroDoNo.tag, "base64url").length, 16, "GCM tag is 16 bytes");
  // The nonce is direction + zeros + 64-bit big-endian seq: a reused (key, nonce) pair would be a
  // catastrophic GCM failure, so the sequence number must be part of it.
  const nonce = Buffer.alloc(12);
  nonce[0] = DIRECAO.no;
  nonce.writeBigUInt64BE(BigInt(VETORES.quadroDoNo.seq), 4);
  const decifra = crypto.createDecipheriv("aes-256-gcm", Buffer.from(VETORES.chaveSessao, "hex"), nonce);
  decifra.setAAD(Buffer.from(VETORES.no));
  decifra.setAuthTag(Buffer.from(VETORES.quadroDoNo.tag, "base64url"));
  const claro = Buffer.concat([decifra.update(Buffer.from(VETORES.quadroDoNo.dados, "base64url")), decifra.final()]);
  assert.equal(claro.toString("utf8"), VETORES.quadroDoNo.texto);
});

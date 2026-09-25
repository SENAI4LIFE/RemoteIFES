const crypto = require("crypto");

// Reference implementation of the board side of the mesh protocol (protocol version 1), used by the
// tests to drive the server exactly as a board behind a gateway would. The firmware implementation
// must produce byte-identical proofs and frames; remoteifes-esp32/MESH.md describes the same rules.

const DIRECAO = { servidor: 0x01, no: 0x02 };

const b64 = (buffer) => Buffer.from(buffer).toString("base64url");
const hmac = (chave, texto) => crypto.createHmac("sha256", chave).update(texto).digest();

function nonceDe(direcao, seq) {
  const nonce = Buffer.alloc(12);
  nonce[0] = direcao;
  nonce.writeBigUInt64BE(BigInt(seq), 4);
  return nonce;
}

class NoDeReferencia {
  constructor({ deviceId, segredo, gatewayDeviceId }) {
    this.deviceId = deviceId;
    this.gatewayDeviceId = gatewayDeviceId;
    this.trocarSegredo(segredo);
    this.sessao = null;
    this.recebidos = [];
    this.recusado = null;
  }

  trocarSegredo(segredo) {
    this.segredo = segredo;
    this.chave = hmac(segredo, "remoteifes-mesh-v1");
  }

  /** Handles a frame the gateway relayed from the server; returns the frames to send back. */
  receber(quadro) {
    if (quadro.t === "desafio") {
      const nn = b64(crypto.randomBytes(16));
      this.pendente = { ns: quadro.ns, nn };
      return [{ t: "ola", nn, prova: b64(hmac(this.chave, `ola|${this.deviceId}|${this.gatewayDeviceId}|${quadro.ns}|${nn}`)) }];
    }
    if (quadro.t === "aceito" && this.pendente) {
      const chave = hmac(this.chave, `sessao|${this.pendente.ns}|${this.pendente.nn}`);
      // Mutual authentication: the node accepts only a server that derived the same session key.
      if (b64(hmac(chave, `aceito|${this.deviceId}`)) !== quadro.prova) throw new Error("server proof mismatch");
      this.sessao = { chave, seqEnvio: 0, seqRecebido: 0 };
      this.pendente = null;
      return [];
    }
    if (quadro.t === "dados" && this.sessao) {
      if (quadro.seq <= this.sessao.seqRecebido) return [this.selar({ tipo: "mesh_ack", seq: quadro.seq })];
      const decifra = crypto.createDecipheriv("aes-256-gcm", this.sessao.chave, nonceDe(DIRECAO.servidor, quadro.seq));
      decifra.setAAD(Buffer.from(this.deviceId));
      decifra.setAuthTag(Buffer.from(quadro.tag, "base64url"));
      const payload = JSON.parse(Buffer.concat([decifra.update(Buffer.from(quadro.dados, "base64url")), decifra.final()]).toString("utf8"));
      this.sessao.seqRecebido = quadro.seq;
      this.recebidos.push(payload);
      if (payload.tipo === "credencial_rotacionar" && typeof payload.segredo === "string") this.novoSegredo = payload.segredo;
      return this.semAck ? [] : [this.selar({ tipo: "mesh_ack", seq: quadro.seq })];
    }
    return [];
  }

  selar(payload) {
    this.sessao.seqEnvio += 1;
    const seq = this.sessao.seqEnvio;
    const cifra = crypto.createCipheriv("aes-256-gcm", this.sessao.chave, nonceDe(DIRECAO.no, seq));
    cifra.setAAD(Buffer.from(this.deviceId));
    const dados = Buffer.concat([cifra.update(JSON.stringify(payload), "utf8"), cifra.final()]);
    return { t: "dados", seq, dados: b64(dados), tag: b64(cifra.getAuthTag()) };
  }
}

module.exports = { NoDeReferencia, DIRECAO };

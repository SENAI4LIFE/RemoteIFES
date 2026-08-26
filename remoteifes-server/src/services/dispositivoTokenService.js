const crypto = require("crypto");
const db = require("../config/database");
const logger = require("../utils/logger");

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function tokensIguais(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function gerarOuRotacionar(sala, requisitanteId) {
  const salaRow = db.prepare(`SELECT sala FROM salas WHERE sala = ?`).get(sala);
  if (!salaRow) throw new Error("sala não encontrada");

  const token = crypto.randomBytes(24).toString("hex");
  const tokenHash = hashToken(token);
  const existente = db.prepare(`SELECT sala FROM dispositivo_tokens WHERE sala = ?`).get(sala);

  if (existente) {
    db.prepare(`
      UPDATE dispositivo_tokens SET tokenHash = ?, rotacionadoEm = datetime('now')
      WHERE sala = ?
    `).run(tokenHash, sala);
  } else {
    db.prepare(`
      INSERT INTO dispositivo_tokens (sala, tokenHash, criadoPor) VALUES (?, ?, ?)
    `).run(sala, tokenHash, requisitanteId || null);
  }

  logger.info("dispositivo-token-rotacionado", { sala, por: requisitanteId || null });
  return token;
}

function revogar(sala) {
  db.prepare(`DELETE FROM dispositivo_tokens WHERE sala = ?`).run(sala);
  logger.info("dispositivo-token-revogado", { sala });
}

function possuiTokenProprio(sala) {
  const linha = db.prepare(`SELECT sala FROM dispositivo_tokens WHERE sala = ?`).get(sala);
  return !!linha;
}

function validarTokenDaSala(sala, token) {
  if (!sala || !token) return false;
  const linha = db.prepare(`SELECT tokenHash FROM dispositivo_tokens WHERE sala = ?`).get(sala);
  if (!linha) return false;
  return tokensIguais(hashToken(token), linha.tokenHash);
}

function infoDaSala(sala) {
  const linha = db.prepare(`SELECT sala, criadoEm, rotacionadoEm FROM dispositivo_tokens WHERE sala = ?`).get(sala);
  return linha || null;
}

module.exports = {
  gerarOuRotacionar,
  revogar,
  possuiTokenProprio,
  validarTokenDaSala,
  infoDaSala,
};

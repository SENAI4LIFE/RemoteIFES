const crypto = require("crypto");
const db = require("../config/database");
const logger = require("../utils/logger");
const configuracoesService = require("./configuracoesService");

const RE_DEVICE_ID = /^esp_[0-9a-f]{16}$/;
const GRACE_ROTACAO_MS = 24 * 60 * 60 * 1000;

function gerarDeviceId() {
  return `esp_${crypto.randomBytes(8).toString("hex")}`;
}

function gerarSegredo() {
  return crypto.randomBytes(32).toString("base64url");
}

function hash(segredo) {
  return crypto.createHash("sha256").update(String(segredo)).digest("hex");
}

function iguaisConstante(a, b) {
  const ba = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function buscarLinha(sala) {
  return db.prepare(`SELECT * FROM esp_credenciais WHERE sala = ?`).get(sala);
}

function deviceIdDisponivel(deviceId) {
  return !db.prepare(`SELECT 1 FROM esp_credenciais WHERE deviceId = ?`).get(deviceId);
}

function novoDeviceId() {
  for (let i = 0; i < 5; i += 1) {
    const candidato = gerarDeviceId();
    if (deviceIdDisponivel(candidato)) return candidato;
  }
  throw new Error("não foi possível gerar um deviceId único");
}

function exigirSala(sala) {
  const salaRow = db.prepare(`SELECT sala FROM salas WHERE sala = ?`).get(sala);
  if (!salaRow) throw new Error("sala não encontrada");
  return salaRow;
}

function notificarDispositivo(sala, tipo, deviceId, segredo) {
  try {
    const deviceHub = require("./deviceHub");
    return deviceHub.enviarAtualizacaoCredencial(sala, { tipo, deviceId, segredo });
  } catch (erro) {
    logger.warn("credencial-push-falhou", { sala, mensagem: erro.message });
    return false;
  }
}

function deviceIdAtivoPara(sala, deviceId) {
  if (typeof deviceId !== "string") return false;
  const linha = db.prepare(`
    SELECT 1 FROM esp_credenciais
    WHERE sala = ? AND deviceId = ? AND revogadoEm IS NULL
  `).get(sala, deviceId);
  return !!linha;
}

function provisionar(sala) {
  exigirSala(sala);
  const existente = buscarLinha(sala);
  if (existente && !existente.revogadoEm) {
    throw new Error("esta sala já tem uma credencial ativa — use rotacionar ou substituir");
  }
  const deviceId = novoDeviceId();
  const segredo = gerarSegredo();
  db.prepare(`
    INSERT INTO esp_credenciais (sala, deviceId, segredoHash, criadoEm)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(sala) DO UPDATE SET
      deviceId = excluded.deviceId,
      segredoHash = excluded.segredoHash,
      segredoHashAnterior = NULL,
      anteriorExpiraEm = NULL,
      criadoEm = datetime('now'),
      rotacionadoEm = NULL,
      ultimoUsoEm = NULL,
      revogadoEm = NULL
  `).run(sala, deviceId, hash(segredo));
  logger.info("credencial-provisionada", { sala, deviceId });
  const enviadoAoDispositivo = notificarDispositivo(sala, "credencial_provisionar", deviceId, segredo);
  return { deviceId, segredo, enviadoAoDispositivo };
}

function rotacionar(sala) {
  const linha = buscarLinha(sala);
  if (!linha || linha.revogadoEm) {
    throw new Error("não há credencial ativa para rotacionar — provisione uma primeiro");
  }
  const segredo = gerarSegredo();
  const expira = new Date(Date.now() + GRACE_ROTACAO_MS).toISOString().slice(0, 19).replace("T", " ");
  db.prepare(`
    UPDATE esp_credenciais SET
      segredoHashAnterior = segredoHash,
      anteriorExpiraEm = ?,
      segredoHash = ?,
      rotacionadoEm = datetime('now')
    WHERE sala = ?
  `).run(expira, hash(segredo), sala);
  logger.info("credencial-rotacionada", { sala, deviceId: linha.deviceId });
  const enviadoAoDispositivo = notificarDispositivo(sala, "credencial_rotacionar", linha.deviceId, segredo);
  return { deviceId: linha.deviceId, segredo, enviadoAoDispositivo };
}

function substituir(sala) {
  exigirSala(sala);
  if (!buscarLinha(sala)) {
    throw new Error("esta sala não tem credencial — use provisionar");
  }
  const deviceId = novoDeviceId();
  const segredo = gerarSegredo();
  db.prepare(`
    UPDATE esp_credenciais SET
      deviceId = ?,
      segredoHash = ?,
      segredoHashAnterior = NULL,
      anteriorExpiraEm = NULL,
      criadoEm = datetime('now'),
      rotacionadoEm = NULL,
      ultimoUsoEm = NULL,
      revogadoEm = NULL
    WHERE sala = ?
  `).run(deviceId, hash(segredo), sala);
  logger.info("credencial-substituida", { sala, deviceId });
  try {
    require("./deviceHub").desconectarSala(sala);
  } catch (erro) {
    logger.warn("credencial-substituir-desconectar-falhou", { sala, mensagem: erro.message });
  }
  return { deviceId, segredo, enviadoAoDispositivo: false };
}

function revogar(sala) {
  const linha = buscarLinha(sala);
  if (!linha) throw new Error("esta sala não tem credencial");
  db.prepare(`
    UPDATE esp_credenciais SET revogadoEm = datetime('now'), segredoHashAnterior = NULL, anteriorExpiraEm = NULL
    WHERE sala = ?
  `).run(sala);
  logger.info("credencial-revogada", { sala, deviceId: linha.deviceId });
  try {
    require("./deviceHub").desconectarSala(sala);
  } catch (erro) {
    logger.warn("credencial-revogar-desconectar-falhou", { sala, mensagem: erro.message });
  }
  return { deviceId: linha.deviceId };
}

function verificar(deviceId, segredo) {
  if (typeof deviceId !== "string" || !RE_DEVICE_ID.test(deviceId)) return null;
  if (typeof segredo !== "string" || segredo.length < 20 || segredo.length > 200) return null;
  const linha = db.prepare(`SELECT * FROM esp_credenciais WHERE deviceId = ? AND revogadoEm IS NULL`).get(deviceId);
  if (!linha) return null;

  const alvo = hash(segredo);
  let grace = false;
  let ok = iguaisConstante(alvo, linha.segredoHash);
  if (!ok && linha.segredoHashAnterior && linha.anteriorExpiraEm) {
    const expiraMs = new Date(linha.anteriorExpiraEm.replace(" ", "T") + "Z").getTime();
    if (Number.isFinite(expiraMs) && expiraMs > Date.now() && iguaisConstante(alvo, linha.segredoHashAnterior)) {
      ok = true;
      grace = true;
    }
  }
  if (!ok) return null;
  db.prepare(`UPDATE esp_credenciais SET ultimoUsoEm = datetime('now') WHERE deviceId = ?`).run(deviceId);
  return { sala: linha.sala, grace };
}

function estado(sala) {
  const linha = buscarLinha(sala);
  if (!linha) return { provisionado: false };
  const graceAtivo = !!(linha.segredoHashAnterior && linha.anteriorExpiraEm
    && new Date(linha.anteriorExpiraEm.replace(" ", "T") + "Z").getTime() > Date.now());
  return {
    provisionado: true,
    deviceId: linha.deviceId,
    criadoEm: linha.criadoEm,
    rotacionadoEm: linha.rotacionadoEm,
    ultimoUsoEm: linha.ultimoUsoEm,
    revogado: !!linha.revogadoEm,
    revogadoEm: linha.revogadoEm || null,
    graceRotacaoAtivo: graceAtivo,
  };
}

function exigidoPara(salaRow) {
  if (!salaRow) return false;
  if (configuracoesService.obter().espCredenciaisObrigatorias) return true;
  const linha = db.prepare(`SELECT 1 FROM esp_credenciais WHERE sala = ? AND revogadoEm IS NULL`).get(salaRow.sala);
  return !!linha;
}

function resumoMigracao() {
  const total = db.prepare(`SELECT COUNT(*) n FROM salas WHERE mac IS NOT NULL`).get().n;
  const comCredencial = db.prepare(`
    SELECT COUNT(*) n FROM esp_credenciais c JOIN salas s ON s.sala = c.sala
    WHERE c.revogadoEm IS NULL AND s.mac IS NOT NULL
  `).get().n;
  const revogadas = db.prepare(`SELECT COUNT(*) n FROM esp_credenciais WHERE revogadoEm IS NOT NULL`).get().n;
  return {
    controladoresComMac: total,
    comCredencial,
    somenteMac: Math.max(0, total - comCredencial),
    revogadas,
    obrigatorio: !!configuracoesService.obter().espCredenciaisObrigatorias,
  };
}

module.exports = {
  provisionar,
  rotacionar,
  substituir,
  revogar,
  verificar,
  estado,
  exigidoPara,
  resumoMigracao,
  deviceIdAtivoPara,
  RE_DEVICE_ID,
};

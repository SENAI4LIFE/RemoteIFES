const crypto = require("crypto");
const db = require("../config/database");
const logger = require("../utils/logger");
const configuracoesService = require("./configuracoesService");

const RE_DEVICE_ID = /^esp_[0-9a-f]{16}$/;
const GRACE_ROTACAO_MS = 24 * 60 * 60 * 1000;
const segredosPendentesEmMemoria = new Map();
// Secret already activated by rotation, kept in memory only while the previous generation is within
// its grace period: a board that reconnects with the previous one (the NVS write did not survive a
// reboot) receives the current secret again instead of becoming unreachable when the grace period
// ends.
const segredosAtivadosEmMemoria = new Map();

function gerarDeviceId() {
  return `esp_${crypto.randomBytes(8).toString("hex")}`;
}

function gerarSegredo() {
  return crypto.randomBytes(32).toString("base64url");
}

function hash(segredo) {
  return crypto.createHash("sha256").update(String(segredo)).digest("hex");
}

// Key a board uses to authenticate itself through a mesh gateway (src/services/meshService.js). It
// is derived from the board's own secret, so the gateway that relays the traffic never holds it; the
// server keeps it because a challenge-response needs the key, not just a hash of the secret. A
// credential created before mesh support gets its key the next time the board connects directly
// with its current secret.
const ROTULO_CHAVE_MESH = "remoteifes-mesh-v1";

function chaveMeshDe(segredo) {
  return crypto.createHmac("sha256", String(segredo)).update(ROTULO_CHAVE_MESH).digest("hex");
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

function marcarPendenteEntregue(sala) {
  db.prepare(`UPDATE esp_credenciais SET pendenteEntregueEm = datetime('now') WHERE sala = ? AND segredoHashPendente IS NOT NULL`).run(sala);
}

function entregarPendente(sala) {
  const guardado = segredosPendentesEmMemoria.get(sala);
  const linha = buscarLinha(sala);
  if (!guardado || !linha || linha.revogadoEm || !linha.segredoHashPendente || linha.deviceId !== guardado.deviceId
      || !iguaisConstante(hash(guardado.segredo), linha.segredoHashPendente)) {
    segredosPendentesEmMemoria.delete(sala);
    return false;
  }
  const entregue = notificarDispositivo(sala, "credencial_rotacionar", linha.deviceId, guardado.segredo);
  if (entregue) marcarPendenteEntregue(sala);
  return entregue;
}

function limparPendente(sala) {
  segredosPendentesEmMemoria.delete(sala);
}

function limparAtivado(sala) {
  segredosAtivadosEmMemoria.delete(sala);
}

function ativadoReentregavel(sala, linha = buscarLinha(sala)) {
  const guardado = segredosAtivadosEmMemoria.get(sala);
  if (!guardado || !linha || linha.revogadoEm || linha.deviceId !== guardado.deviceId
      || !linha.segredoHashAnterior || !linha.anteriorExpiraEm
      || new Date(linha.anteriorExpiraEm.replace(" ", "T") + "Z").getTime() <= Date.now()
      || !iguaisConstante(hash(guardado.segredo), linha.segredoHash)) {
    segredosAtivadosEmMemoria.delete(sala);
    return null;
  }
  return guardado;
}

function reentregarAtual(sala) {
  const guardado = ativadoReentregavel(sala);
  if (!guardado) return false;
  logger.info("credencial-reentrega-apos-reconexao-com-anterior", { sala, deviceId: guardado.deviceId });
  return notificarDispositivo(sala, "credencial_rotacionar", guardado.deviceId, guardado.segredo);
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
    INSERT INTO esp_credenciais (sala, deviceId, segredoHash, chaveMesh, criadoEm)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(sala) DO UPDATE SET
      deviceId = excluded.deviceId,
      segredoHash = excluded.segredoHash,
      chaveMesh = excluded.chaveMesh,
      chaveMeshAnterior = NULL,
      chaveMeshPendente = NULL,
      segredoHashAnterior = NULL,
      anteriorExpiraEm = NULL,
      segredoHashPendente = NULL,
      pendenteCriadoEm = NULL,
      pendenteEntregueEm = NULL,
      criadoEm = datetime('now'),
      rotacionadoEm = NULL,
      ultimoUsoEm = NULL,
      revogadoEm = NULL
  `).run(sala, deviceId, hash(segredo), chaveMeshDe(segredo));
  limparPendente(sala);
  limparAtivado(sala);
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
  db.prepare(`
    UPDATE esp_credenciais SET
      segredoHashPendente = ?,
      chaveMeshPendente = ?,
      pendenteCriadoEm = datetime('now'),
      pendenteEntregueEm = NULL
    WHERE sala = ?
  `).run(hash(segredo), chaveMeshDe(segredo), sala);
  segredosPendentesEmMemoria.set(sala, { deviceId: linha.deviceId, segredo });
  logger.info("credencial-rotacao-pendente", { sala, deviceId: linha.deviceId });
  const enviadoAoDispositivo = entregarPendente(sala);
  return { deviceId: linha.deviceId, segredo, enviadoAoDispositivo, pendente: true };
}

function ativarPendente(linha) {
  const expira = new Date(Date.now() + GRACE_ROTACAO_MS).toISOString().slice(0, 19).replace("T", " ");
  db.prepare(`
    UPDATE esp_credenciais SET
      segredoHashAnterior = segredoHash,
      chaveMeshAnterior = chaveMesh,
      anteriorExpiraEm = ?,
      segredoHash = segredoHashPendente,
      chaveMesh = chaveMeshPendente,
      chaveMeshPendente = NULL,
      segredoHashPendente = NULL,
      pendenteCriadoEm = NULL,
      pendenteEntregueEm = NULL,
      rotacionadoEm = datetime('now')
    WHERE deviceId = ? AND segredoHashPendente IS NOT NULL
  `).run(expira, linha.deviceId);
  const guardado = segredosPendentesEmMemoria.get(linha.sala);
  limparPendente(linha.sala);
  if (guardado && guardado.deviceId === linha.deviceId) segredosAtivadosEmMemoria.set(linha.sala, guardado);
  else limparAtivado(linha.sala);
  logger.info("credencial-rotacionada", { sala: linha.sala, deviceId: linha.deviceId });
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
      chaveMesh = ?,
      chaveMeshAnterior = NULL,
      chaveMeshPendente = NULL,
      segredoHashAnterior = NULL,
      anteriorExpiraEm = NULL,
      segredoHashPendente = NULL,
      pendenteCriadoEm = NULL,
      pendenteEntregueEm = NULL,
      criadoEm = datetime('now'),
      rotacionadoEm = NULL,
      ultimoUsoEm = NULL,
      revogadoEm = NULL
    WHERE sala = ?
  `).run(deviceId, hash(segredo), chaveMeshDe(segredo), sala);
  limparPendente(sala);
  limparAtivado(sala);
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
    UPDATE esp_credenciais SET revogadoEm = datetime('now'), segredoHashAnterior = NULL, anteriorExpiraEm = NULL,
      segredoHashPendente = NULL, pendenteCriadoEm = NULL, pendenteEntregueEm = NULL,
      chaveMesh = NULL, chaveMeshPendente = NULL, chaveMeshAnterior = NULL
    WHERE sala = ?
  `).run(sala);
  limparPendente(sala);
  limparAtivado(sala);
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
  let expiraEm = null;
  let ok = iguaisConstante(alvo, linha.segredoHash);
  if (!ok && linha.segredoHashPendente && iguaisConstante(alvo, linha.segredoHashPendente)) {
    ativarPendente(linha);
    ok = true;
  }
  // The current secret was presented: its mesh key is derived here when missing (credentials
  // created before mesh support), so the board can later join through a gateway.
  if (ok) {
    const chave = chaveMeshDe(segredo);
    db.prepare(`UPDATE esp_credenciais SET chaveMesh = ? WHERE deviceId = ? AND segredoHash = ? AND (chaveMesh IS NULL OR chaveMesh <> ?)`)
      .run(chave, deviceId, alvo, chave);
  }
  if (!ok && linha.segredoHashAnterior && linha.anteriorExpiraEm) {
    const expiraMs = new Date(linha.anteriorExpiraEm.replace(" ", "T") + "Z").getTime();
    if (Number.isFinite(expiraMs) && expiraMs > Date.now() && iguaisConstante(alvo, linha.segredoHashAnterior)) {
      ok = true;
      grace = true;
      expiraEm = new Date(expiraMs).toISOString();
    }
  }
  if (!ok) return null;
  db.prepare(`UPDATE esp_credenciais SET ultimoUsoEm = datetime('now') WHERE deviceId = ?`).run(deviceId);
  return { sala: linha.sala, grace, expiraEm };
}

/**
 * Mesh keys a board may prove, newest generation first: current, pending (a rotation the board may
 * already have stored) and previous during its grace period. Null when revoked or unknown.
 */
function chavesMeshPara(deviceId) {
  if (typeof deviceId !== "string" || !RE_DEVICE_ID.test(deviceId)) return null;
  const linha = db.prepare(`SELECT * FROM esp_credenciais WHERE deviceId = ? AND revogadoEm IS NULL`).get(deviceId);
  if (!linha) return null;
  const chaves = [];
  if (linha.chaveMesh) chaves.push({ geracao: "atual", chave: Buffer.from(linha.chaveMesh, "hex") });
  if (linha.chaveMeshPendente) chaves.push({ geracao: "pendente", chave: Buffer.from(linha.chaveMeshPendente, "hex") });
  if (linha.chaveMeshAnterior && linha.anteriorExpiraEm) {
    const expiraMs = new Date(linha.anteriorExpiraEm.replace(" ", "T") + "Z").getTime();
    if (Number.isFinite(expiraMs) && expiraMs > Date.now()) chaves.push({ geracao: "anterior", chave: Buffer.from(linha.chaveMeshAnterior, "hex") });
  }
  return { sala: linha.sala, deviceId, chaves };
}

/** A board proved the pending generation through a gateway: same effect as presenting it directly. */
function ativarPendentePorMesh(deviceId) {
  const linha = db.prepare(`SELECT * FROM esp_credenciais WHERE deviceId = ? AND revogadoEm IS NULL`).get(deviceId);
  if (linha && linha.segredoHashPendente) ativarPendente(linha);
}

function registrarUsoMesh(deviceId) {
  db.prepare(`UPDATE esp_credenciais SET ultimoUsoEm = datetime('now') WHERE deviceId = ?`).run(deviceId);
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
    atualReentregavel: graceAtivo && !!ativadoReentregavel(sala, linha),
    rotacaoPendente: !!linha.segredoHashPendente,
    pendenteDesde: linha.segredoHashPendente ? linha.pendenteCriadoEm : null,
    pendenteEntregueEm: linha.segredoHashPendente ? linha.pendenteEntregueEm || null : null,
    pendenteReentregavel: !!linha.segredoHashPendente && segredosPendentesEmMemoria.has(sala),
  };
}

function exigidoPara(salaRow) {
  if (!salaRow) return false;
  if (configuracoesService.obter().espCredenciaisObrigatorias) return true;
  const linha = db.prepare(`SELECT 1 FROM esp_credenciais WHERE sala = ?`).get(salaRow.sala);
  return !!linha;
}

function resumoMigracao() {
  const total = db.prepare(`SELECT COUNT(*) n FROM salas WHERE mac IS NOT NULL`).get().n;
  const comCredencial = db.prepare(`
    SELECT COUNT(*) n FROM esp_credenciais c JOIN salas s ON s.sala = c.sala
    WHERE c.revogadoEm IS NULL AND s.mac IS NOT NULL
  `).get().n;
  const revogadas = db.prepare(`SELECT COUNT(*) n FROM esp_credenciais WHERE revogadoEm IS NOT NULL`).get().n;
  const somenteMac = db.prepare(`
    SELECT COUNT(*) n FROM salas s WHERE s.mac IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM esp_credenciais c WHERE c.sala = s.sala)
  `).get().n;
  return {
    controladoresComMac: total,
    comCredencial,
    somenteMac,
    revogadas,
    obrigatorio: !!configuracoesService.obter().espCredenciaisObrigatorias,
  };
}

module.exports = {
  chaveMeshDe,
  chavesMeshPara,
  ativarPendentePorMesh,
  registrarUsoMesh,
  provisionar,
  rotacionar,
  entregarPendente,
  reentregarAtual,
  substituir,
  revogar,
  verificar,
  estado,
  exigidoPara,
  resumoMigracao,
  deviceIdAtivoPara,
  RE_DEVICE_ID,
};

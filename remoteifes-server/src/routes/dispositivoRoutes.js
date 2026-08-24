const express = require("express");
const crypto = require("crypto");
const salasService = require("../services/salasService");
const presetsService = require("../services/presetsService");
const { criarLimitador } = require("../utils/rateLimiter");

const router = express.Router();

const limitarDispositivo = criarLimitador({ janelaMs: 60 * 1000, maxTentativas: 120 });
router.use(limitarDispositivo);

const DEVICE_TOKEN = process.env.DEVICE_TOKEN || "";

function tokensIguais(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function exigirDispositivo(req, res, next) {
  if (!DEVICE_TOKEN) {
    return res.status(503).json({ ok: false, erro: "autenticação de dispositivo não configurada no servidor" });
  }
  const token = req.headers["x-device-token"];
  if (!token || typeof token !== "string" || !tokensIguais(token, DEVICE_TOKEN)) {
    return res.status(401).json({ ok: false, erro: "token de dispositivo inválido" });
  }
  next();
}

// O DEVICE_TOKEN é compartilhado por todos os ESP32 do sistema (não há um
// token por sala). Sem esta checagem, qualquer dispositivo de posse do
// token global poderia agir em nome de qualquer outra sala informando um
// valor arbitrário de "sala" no corpo da requisição. Quando a sala alvo já
// tem um MAC cadastrado, exigimos que o cabeçalho x-device-mac (enviado
// pelo firmware) corresponda a esse MAC. Dispositivos ainda não cadastrados
// (sala sem MAC vinculado) ou firmwares antigos que não enviam o header
// continuam funcionando normalmente — a checagem só bloqueia quando há um
// MAC cadastrado E o header não bate com ele.
function exigirMacDaSalaSeCadastrado(req, res, next) {
  const sala = typeof req.body?.sala === "string" ? req.body.sala : req.query?.sala;
  if (!sala || typeof sala !== "string") return next();

  const salaRow = salasService.buscar(sala);
  if (!salaRow) return next();

  const macInformado = req.headers["x-device-mac"];
  if (!salasService.macCorrespondeASala(salaRow, macInformado)) {
    return res.status(403).json({ ok: false, erro: "MAC do dispositivo não corresponde ao ESP32 cadastrado para esta sala" });
  }
  next();
}

router.post("/dispositivo/heartbeat", exigirDispositivo, (req, res) => {
  const { sala, ligado, temperatura, mac, ip } = req.body;
  if (!sala || typeof sala !== "string") {
    return res.status(400).json({ ok: false, erro: "sala é obrigatória" });
  }
  if (ligado !== undefined && typeof ligado !== "boolean") {
    return res.status(400).json({ ok: false, erro: "ligado deve ser booleano" });
  }
  if (temperatura !== undefined && (typeof temperatura !== "number" || !Number.isFinite(temperatura))) {
    return res.status(400).json({ ok: false, erro: "temperatura deve ser numérica" });
  }

  try {
    const estadoReportado = {};
    if (ligado !== undefined) estadoReportado.ligado = ligado;
    if (temperatura !== undefined) estadoReportado.temperatura = temperatura;

    const ipReportado = typeof ip === "string" && ip ? ip : req.ip;
    const resultado = salasService.heartbeatDispositivo(sala, estadoReportado, mac, ipReportado);
    if (resultado.pendente) {
      return res.status(202).json({ ok: true, pendente: true, mensagem: "sala não cadastrada; dispositivo detectado e aguardando vinculação pelo administrador" });
    }
    res.json({ ok: true, sala: resultado });
  } catch (err) {
    res.status(400).json({ ok: false, erro: err.message });
  }
});

router.post("/dispositivo/acesso", exigirDispositivo, exigirMacDaSalaSeCadastrado, (req, res) => {
  const { sala, userAgent } = req.body;
  if (!sala || typeof sala !== "string") {
    return res.status(400).json({ ok: false, erro: "sala é obrigatória" });
  }
  if (userAgent !== undefined && typeof userAgent !== "string") {
    return res.status(400).json({ ok: false, erro: "userAgent deve ser texto" });
  }

  try {
    const ip = req.body.ip && typeof req.body.ip === "string" ? req.body.ip : req.ip;
    salasService.registrarAcessoEsp(sala, { ip, userAgent });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, erro: err.message });
  }
});

router.post("/dispositivo/comando", exigirDispositivo, exigirMacDaSalaSeCadastrado, (req, res) => {
  const { sala, cmd, valor } = req.body;
  if (!sala || typeof sala !== "string") {
    return res.status(400).json({ ok: false, erro: "sala é obrigatória" });
  }
  if (!cmd || typeof cmd !== "string") {
    return res.status(400).json({ ok: false, erro: "cmd é obrigatório" });
  }

  try {
    salasService.registrarComandoDispositivo(sala, cmd, valor);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, erro: err.message });
  }
});

router.get("/dispositivo/preset", exigirDispositivo, exigirMacDaSalaSeCadastrado, (req, res) => {
  const { sala } = req.query;
  if (!sala || typeof sala !== "string") {
    return res.status(400).json({ ok: false, erro: "sala é obrigatória" });
  }
  const salaRow = salasService.buscar(sala);
  if (!salaRow) return res.status(404).json({ ok: false, erro: "sala não encontrada" });

  const preset = salaRow.presetId
    ? presetsService.buscarPorId(salaRow.presetId)
    : presetsService.presetPadrao();

  res.json({ ok: true, preset });
});

router.post("/dispositivo/preset", exigirDispositivo, exigirMacDaSalaSeCadastrado, (req, res) => {
  const { nome, funcoes, sala } = req.body || {};
  if (!sala || typeof sala !== "string") {
    return res.status(400).json({ ok: false, erro: "sala é obrigatória" });
  }
  const salaRow = salasService.buscar(sala);
  if (!salaRow) return res.status(404).json({ ok: false, erro: "sala não encontrada" });

  try {
    // O preset a ser alterado é sempre resolvido a partir do presetId já
    // vinculado a esta sala (nunca por nome vindo do corpo da requisição),
    // para que um dispositivo não possa sobrescrever o preset padrão
    // compartilhado nem o preset de outra sala. Ver nota em
    // presetsService.sincronizarPresetDaSala.
    const preset = presetsService.sincronizarPresetDaSala({
      presetIdAtual: salaRow.presetId || null,
      nome,
      funcoes,
    });
    salasService.definirPreset(sala, preset.id);
    res.json({ ok: true, preset });
  } catch (err) {
    res.status(400).json({ ok: false, erro: err.message });
  }
});

module.exports = router;

const express = require("express");
const salasService = require("../services/salasService");
const presetsService = require("../services/presetsService");
const { criarLimitador } = require("../utils/rateLimiter");

const router = express.Router();

const limitarDispositivo = criarLimitador({ janelaMs: 60 * 1000, maxTentativas: 120 });
router.use(limitarDispositivo);

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

router.post("/dispositivo/heartbeat", (req, res) => {
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

router.post("/dispositivo/acesso", exigirMacDaSalaSeCadastrado, (req, res) => {
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

router.post("/dispositivo/comando", exigirMacDaSalaSeCadastrado, (req, res) => {
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

router.get("/dispositivo/preset", exigirMacDaSalaSeCadastrado, (req, res) => {
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

router.post("/dispositivo/preset", exigirMacDaSalaSeCadastrado, (req, res) => {
  const { nome, funcoes, sala } = req.body || {};
  if (!sala || typeof sala !== "string") {
    return res.status(400).json({ ok: false, erro: "sala é obrigatória" });
  }
  const salaRow = salasService.buscar(sala);
  if (!salaRow) return res.status(404).json({ ok: false, erro: "sala não encontrada" });

  try {
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

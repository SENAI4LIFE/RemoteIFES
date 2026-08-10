const express = require("express");
const crypto = require("crypto");
const salasService = require("../services/salasService");

const router = express.Router();

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

router.post("/dispositivo/heartbeat", exigirDispositivo, (req, res) => {
  const { sala, ligado, temperatura } = req.body;
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

    const resultado = salasService.marcarOnline(sala, estadoReportado);
    res.json({ ok: true, sala: resultado });
  } catch (err) {
    res.status(400).json({ ok: false, erro: err.message });
  }
});

module.exports = router;

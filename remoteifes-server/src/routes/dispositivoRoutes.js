const fs = require("fs");
const express = require("express");
const salasService = require("../services/salasService");
const otaService = require("../services/otaService");
const credenciaisService = require("../services/esp32CredenciaisService");
const { criarLimitador } = require("../utils/rateLimiter");

const router = express.Router();

const limitarDispositivo = criarLimitador({ janelaMs: 60 * 1000, maxTentativas: 120 });
router.use("/dispositivo", limitarDispositivo);

function autenticarDispositivo(req, res, next) {
  const deviceId = req.headers["x-device-id"];
  const segredo = req.headers["x-device-secret"];
  const salaInformada = typeof req.body?.sala === "string" ? req.body.sala : req.query?.sala;

  if (typeof deviceId === "string" && typeof segredo === "string") {
    const resultado = credenciaisService.verificar(deviceId, segredo);
    if (!resultado) {
      return res.status(401).json({ ok: false, erro: "credencial do dispositivo inválida ou revogada" });
    }
    if (salaInformada && typeof salaInformada === "string" && salaInformada !== resultado.sala) {
      return res.status(403).json({ ok: false, erro: "a credencial não corresponde à sala informada" });
    }
    req.deviceAuth = { sala: resultado.sala, viaCredencial: true };
    return next();
  }

  if (!salaInformada || typeof salaInformada !== "string") return next();

  const salaRow = salasService.buscar(salaInformada);
  if (!salaRow) return res.status(404).json({ ok: false, erro: "sala não encontrada" });

  if (credenciaisService.exigidoPara(salaRow)) {
    return res.status(401).json({ ok: false, erro: "esta sala exige credencial de dispositivo (X-Device-Id / X-Device-Secret)" });
  }

  const macInformado = req.headers["x-device-mac"] || req.body?.mac;
  if (!salasService.macCorrespondeASala(salaRow, macInformado)) {
    return res.status(403).json({ ok: false, erro: "MAC do dispositivo não corresponde ao ESP32 cadastrado para esta sala" });
  }
  req.deviceAuth = { sala: salaInformada, viaCredencial: false };
  next();
}

router.post("/dispositivo/identificar", (req, res) => {
  try {
    const ip = typeof req.body?.ip === "string" && req.body.ip ? req.body.ip : req.ip;
    const deviceId = req.headers["x-device-id"];
    const segredo = req.headers["x-device-secret"];

    if (typeof deviceId === "string" && typeof segredo === "string") {
      const cred = credenciaisService.verificar(deviceId, segredo);
      if (!cred) {
        return res.status(401).json({ ok: false, erro: "credencial do dispositivo inválida ou revogada" });
      }
      const salaRow = salasService.buscar(cred.sala);
      salasService.registrarDeteccaoEsp(req.body?.mac, ip, cred.sala);
      if (typeof req.body?.fw === "string") salasService.registrarVersaoFirmware(cred.sala, req.body.fw);
      return res.json({ ok: true, sala: cred.sala, nome: salaRow ? salaRow.nome : cred.sala });
    }

    const sala = salasService.identificarDispositivo(req.body?.mac, ip);
    if (!sala) {
      return res.status(202).json({ ok: true, pendente: true, mensagem: "dispositivo aguardando vinculação por MAC" });
    }
    if (credenciaisService.exigidoPara(sala)) {
      return res.status(401).json({ ok: false, erro: "esta sala exige credencial de dispositivo" });
    }
    if (typeof req.body?.fw === "string") salasService.registrarVersaoFirmware(sala.sala, req.body.fw);
    res.json({ ok: true, sala: sala.sala, nome: sala.nome });
  } catch (err) {
    res.status(400).json({ ok: false, erro: err.message });
  }
});

router.get("/dispositivo/firmware", (req, res, next) => {
  if (!req.query?.sala || typeof req.query.sala !== "string") {
    return res.status(400).json({ ok: false, erro: "sala é obrigatória" });
  }
  next();
}, autenticarDispositivo, (req, res) => {
  const manifesto = otaService.lerManifesto();
  const caminho = otaService.caminhoBinPublicado();
  if (!manifesto || !caminho) {
    return res.status(404).json({ ok: false, erro: "nenhum firmware publicado" });
  }
  res.set("Content-Type", "application/octet-stream");
  res.set("Content-Length", String(manifesto.tamanho));
  res.set("X-Firmware-Versao", manifesto.versao);
  res.set("X-Firmware-Sha256", manifesto.sha256);
  fs.createReadStream(caminho).pipe(res);
});

router.post("/dispositivo/heartbeat", autenticarDispositivo, (req, res) => {
  const { sala, ligado, temperatura, mac, ip } = req.body;
  if (!sala || typeof sala !== "string") {
    return res.status(400).json({ ok: false, erro: "sala é obrigatória" });
  }
  if (ligado !== undefined && typeof ligado !== "boolean") {
    return res.status(400).json({ ok: false, erro: "ligado deve ser booleano" });
  }
  if (
    temperatura !== undefined &&
    (typeof temperatura !== "number" || !Number.isFinite(temperatura) || temperatura < -40 || temperatura > 85)
  ) {
    return res.status(400).json({ ok: false, erro: "temperatura fora da faixa esperada (-40 a 85 °C)" });
  }

  try {
    const estadoReportado = {};
    if (ligado !== undefined) estadoReportado.ligado = ligado;
    if (temperatura !== undefined) estadoReportado.temperatura = temperatura;

    const ipReportado = typeof ip === "string" && ip ? ip : req.ip;
    const resultado = salasService.heartbeatDispositivo(sala, estadoReportado, mac, ipReportado, {
      viaCredencial: !!req.deviceAuth?.viaCredencial,
    });
    if (typeof req.body?.fw === "string") salasService.registrarVersaoFirmware(sala, req.body.fw);
    res.json({ ok: true, sala: resultado });
  } catch (err) {
    res.status(400).json({ ok: false, erro: err.message });
  }
});

router.post("/dispositivo/acesso", autenticarDispositivo, (req, res) => {
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

router.post("/dispositivo/comando", autenticarDispositivo, (req, res) => {
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

module.exports = router;

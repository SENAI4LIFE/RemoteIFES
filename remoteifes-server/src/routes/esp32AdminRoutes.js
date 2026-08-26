const express = require("express");
const { exigirLogin, exigirAdmin, exigirSuperAdmin } = require("../middlewares/auth");
const salasService = require("../services/salasService");
const deviceHub = require("../services/deviceHub");

const router = express.Router();
router.use("/admin/esp32", exigirLogin, exigirAdmin, exigirSuperAdmin);

const MODOS_VALIDOS = ["idle", "clone"];
const FAN_VALIDOS = ["low", "medio", "alto", "max"];

function montarLinhaDispositivo(salaRow) {
  return {
    sala: salaRow.sala,
    nome: salaRow.nome,
    bloco: salaRow.bloco,
    andar: salaRow.andar,
    mac: salaRow.mac,
    ipEsp32: salaRow.ipEsp32,
    online: !!salaRow.online,
    irProtocolo: Number.isInteger(salaRow.irProtocolo) ? salaRow.irProtocolo : null,
    dispositivo: deviceHub.estadoPublico(salaRow.sala),
  };
}

function exigirSalaCadastrada(req, res, next) {
  const salaRow = salasService.buscar(req.params.sala);
  if (!salaRow) return res.status(404).json({ ok: false, erro: "sala não encontrada" });
  req.salaRow = salaRow;
  next();
}

function exigirDispositivoConectado(req, res, next) {
  if (!deviceHub.dispositivoConectado(req.params.sala)) {
    return res.status(409).json({ ok: false, erro: "dispositivo não está conectado no momento" });
  }
  next();
}

function enviarOuFalhar(res, sala, payload) {
  const enviado = deviceHub.enviarComando(sala, payload);
  if (!enviado) {
    return res.status(409).json({ ok: false, erro: "dispositivo não está conectado no momento" });
  }
  res.json({ ok: true });
}

router.get("/admin/esp32/dispositivos", (req, res) => {
  const salas = salasService.listar();
  res.json(salas.filter((s) => s.mac).map(montarLinhaDispositivo));
});

router.get("/admin/esp32/:sala/estado", exigirSalaCadastrada, (req, res) => {
  res.json({ ok: true, dispositivo: montarLinhaDispositivo(req.salaRow) });
});

router.post("/admin/esp32/:sala/entrar-config", exigirSalaCadastrada, exigirDispositivoConectado, (req, res) => {
  enviarOuFalhar(res, req.params.sala, { tipo: "enter_config" });
});

router.post("/admin/esp32/:sala/sair-operacao", exigirSalaCadastrada, exigirDispositivoConectado, (req, res) => {
  enviarOuFalhar(res, req.params.sala, { tipo: "exit_operation" });
});

router.post("/admin/esp32/:sala/modo", exigirSalaCadastrada, exigirDispositivoConectado, (req, res) => {
  const { modo } = req.body || {};
  if (!MODOS_VALIDOS.includes(modo)) {
    return res.status(400).json({ ok: false, erro: `modo deve ser um de: ${MODOS_VALIDOS.join(", ")}` });
  }
  enviarOuFalhar(res, req.params.sala, { tipo: "set_mode", modo });
});

router.post("/admin/esp32/:sala/captura/iniciar", exigirSalaCadastrada, exigirDispositivoConectado, (req, res) => {
  enviarOuFalhar(res, req.params.sala, { tipo: "start_capture" });
});

router.post("/admin/esp32/:sala/captura/parar", exigirSalaCadastrada, exigirDispositivoConectado, (req, res) => {
  enviarOuFalhar(res, req.params.sala, { tipo: "stop_capture" });
});

router.post("/admin/esp32/:sala/teste/raw", exigirSalaCadastrada, exigirDispositivoConectado, (req, res) => {
  const { raw, carrierHz } = req.body || {};
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 1024) {
    return res.status(400).json({ ok: false, erro: "raw deve ser um array de 1 a 1024 números" });
  }
  if (!raw.every((n) => Number.isInteger(n) && n >= 0 && n <= 65535)) {
    return res.status(400).json({ ok: false, erro: "raw deve conter apenas inteiros entre 0 e 65535" });
  }
  const hz = carrierHz === undefined ? 38000 : Number(carrierHz);
  if (!Number.isFinite(hz) || hz < 20000 || hz > 60000) {
    return res.status(400).json({ ok: false, erro: "carrierHz inválido" });
  }
  enviarOuFalhar(res, req.params.sala, { tipo: "send_raw", raw, carrierHz: hz });
});

router.post("/admin/esp32/:sala/teste/estado", exigirSalaCadastrada, exigirDispositivoConectado, (req, res) => {
  const { protocol, temp, power, turbo, fan, swing } = req.body || {};
  if (!Number.isInteger(protocol)) {
    return res.status(400).json({ ok: false, erro: "protocol inválido" });
  }
  const limites = require("../services/configuracoesService").limitesEfetivosDaSala(req.salaRow);
  if (typeof temp !== "number" || !Number.isFinite(temp) || temp < limites.minima || temp > limites.maxima) {
    return res.status(400).json({ ok: false, erro: `temp deve estar entre ${limites.minima} e ${limites.maxima}` });
  }
  if (fan !== undefined && !FAN_VALIDOS.includes(fan)) {
    return res.status(400).json({ ok: false, erro: `fan deve ser um de: ${FAN_VALIDOS.join(", ")}` });
  }
  enviarOuFalhar(res, req.params.sala, {
    tipo: "send_known_state",
    protocol,
    temp,
    power: !!power,
    turbo: !!turbo,
    fan: fan || "",
    swing: !!swing,
  });
});

router.post("/admin/esp32/:sala/protocolo-ir", exigirSalaCadastrada, (req, res) => {
  try {
    const sala = salasService.definirProtocoloIR(req.params.sala, req.body?.protocolo);
    res.json({ ok: true, sala });
  } catch (err) {
    res.status(400).json({ ok: false, erro: err.message });
  }
});

router.post("/admin/esp32/:sala/reset-wifi", exigirSalaCadastrada, exigirDispositivoConectado, (req, res) => {
  enviarOuFalhar(res, req.params.sala, { tipo: "reset_wifi" });
});

module.exports = router;

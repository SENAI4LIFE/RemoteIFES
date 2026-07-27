const express = require("express");
const salasService = require("../services/salasService");

const router = express.Router();

router.post("/dispositivo/heartbeat", (req, res) => {
  const { sala, ligado, temperatura } = req.body;
  if (!sala) return res.status(400).json({ ok: false, erro: "sala é obrigatória" });

  try {
    const estadoReportado = {};
    if (ligado !== undefined) estadoReportado.ligado = !!ligado;
    if (temperatura !== undefined) estadoReportado.temperatura = temperatura;

    const resultado = salasService.marcarOnline(sala, estadoReportado);
    res.json({ ok: true, sala: resultado });
  } catch (err) {
    res.status(400).json({ ok: false, erro: err.message });
  }
});

module.exports = router;

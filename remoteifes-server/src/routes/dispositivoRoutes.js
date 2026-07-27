const express = require("express");
const salasService = require("../services/salasService");

const router = express.Router();

router.post("/dispositivo/heartbeat", (req, res) => {
  const { sala } = req.body;
  if (!sala) return res.status(400).json({ ok: false, erro: "sala é obrigatória" });

  try {
    const resultado = salasService.marcarOnline(sala);
    res.json({ ok: true, sala: resultado });
  } catch (err) {
    res.status(400).json({ ok: false, erro: err.message });
  }
});

module.exports = router;

const express = require("express");
const { exigirLogin, exigirPermissao } = require("../middlewares/auth");
const salasService = require("../services/salasService");
const { criarLimitador } = require("../utils/rateLimiter");

const router = express.Router();

const limitarComando = criarLimitador({ janelaMs: 60 * 1000, maxTentativas: 60 });

router.post("/comando", exigirLogin, exigirPermissao("podeControlar"), limitarComando, (req, res) => {
  const { sala, cmd, valor } = req.body || {};
  if (typeof sala !== "string" || !sala || typeof cmd !== "string" || !cmd) {
    return res.status(400).json({ ok: false, erro: "sala e cmd são obrigatórios" });
  }

  try {
    const resultado = salasService.aplicarComando(sala, cmd, valor, {
      usuario: req.usuario,
      origem: "manual",
    });
    res.json({ ok: true, sala: resultado });
  } catch (err) {
    res.status(400).json({ ok: false, erro: err.message });
  }
});

module.exports = router;

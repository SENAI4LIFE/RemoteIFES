const express = require("express");
const { exigirLogin, exigirPermissao } = require("../middlewares/auth");
const salasService = require("../services/salasService");
const { criarLimitador } = require("../utils/rateLimiter");

const router = express.Router();
const NIVEL_SUPERADMIN = 3;

const limitarComando = criarLimitador({ janelaMs: 60 * 1000, maxTentativas: 60, chave: (req) => (req.usuario ? req.usuario.id : null) });

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
    if (req.usuario.nivel === NIVEL_SUPERADMIN) return res.json({ ok: true, sala: resultado });
    const { mac, ipEsp32, ...semCadastro } = resultado;
    res.json({ ok: true, sala: semCadastro });
  } catch (err) {
    res.status(400).json({ ok: false, erro: err.message });
  }
});

module.exports = router;

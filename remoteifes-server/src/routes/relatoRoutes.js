const express = require("express");
const { exigirLogin, exigirSuperAdmin } = require("../middlewares/auth");
const { criarLimitador } = require("../utils/rateLimiter");
const relatosService = require("../services/relatosService");

const router = express.Router();

const limitarCriacao = criarLimitador({ janelaMs: 10 * 60 * 1000, maxTentativas: 15 });

function parseId(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ ok: false, erro: "id inválido" });
    return null;
  }
  return id;
}

router.get("/relatos/opcoes", exigirLogin, (req, res) => {
  res.json({
    ok: true,
    categorias: relatosService.CATEGORIAS,
    limites: relatosService.LIMITES,
  });
});

router.post("/relatos", exigirLogin, limitarCriacao, (req, res) => {
  try {
    const { relato, duplicado } = relatosService.criar(req.body, req.usuario, req);
    res.json({ ok: true, relato, duplicado });
  } catch (err) {
    res.status(400).json({ ok: false, erro: err.message });
  }
});

router.get("/relatos/meus", exigirLogin, (req, res) => {
  res.json(relatosService.listarDoUsuario(req.usuario.id));
});

router.get("/superadmin/relatos", exigirLogin, exigirSuperAdmin, (req, res) => {
  try {
    const { status } = req.query;
    if (status !== undefined && typeof status !== "string") {
      return res.status(400).json({ ok: false, erro: "status inválido" });
    }
    res.json(relatosService.listar({ status }));
  } catch (err) {
    res.status(400).json({ ok: false, erro: err.message });
  }
});

router.get("/superadmin/relatos/contagem", exigirLogin, exigirSuperAdmin, (req, res) => {
  res.json(relatosService.contarPorStatus());
});

router.get("/superadmin/relatos/:id", exigirLogin, exigirSuperAdmin, (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;
  relatosService.marcarAbertoSeNovo(id, req.usuario.id);
  const relato = relatosService.buscarPorId(id);
  if (!relato) return res.status(404).json({ ok: false, erro: "relato não encontrado" });
  res.json({ ok: true, relato });
});

router.patch("/superadmin/relatos/:id", exigirLogin, exigirSuperAdmin, (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;
  try {
    const relato = relatosService.atualizar(id, req.body, req.usuario);
    res.json({ ok: true, relato });
  } catch (err) {
    const status = err.message === "relato não encontrado" ? 404 : 400;
    res.status(status).json({ ok: false, erro: err.message });
  }
});

module.exports = router;

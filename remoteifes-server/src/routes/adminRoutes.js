const express = require("express");
const { exigirLogin, exigirAdmin } = require("../middlewares/auth");
const usuariosService = require("../services/usuariosService");
const salasService = require("../services/salasService");
const tokenService = require("../services/tokenService");

const router = express.Router();
router.use(exigirLogin, exigirAdmin);

router.get("/admin/usuarios", (req, res) => {
  res.json(usuariosService.listar());
});

router.post("/admin/usuarios", (req, res) => {
  try {
    const { usuario, senha, nome, podeControlar, podeAgendar } = req.body;
    if (!usuario || !senha || !nome) {
      return res.status(400).json({ ok: false, erro: "usuário, senha e nome são obrigatórios" });
    }
    const novo = usuariosService.criar({ usuario, senha, nome, podeControlar, podeAgendar });
    res.json({ ok: true, usuario: novo });
  } catch (err) {
    res.status(400).json({ ok: false, erro: err.message });
  }
});

router.patch("/admin/usuarios/:id", (req, res) => {
  try {
    const atualizado = usuariosService.atualizarPermissoes(Number(req.params.id), req.body);
    res.json({ ok: true, usuario: atualizado });
  } catch (err) {
    res.status(400).json({ ok: false, erro: err.message });
  }
});

router.delete("/admin/usuarios/:id", (req, res) => {
  try {
    usuariosService.remover(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, erro: err.message });
  }
});

router.get("/admin/logs", (req, res) => {
  res.json(salasService.listarLogs());
});

router.get("/admin/sessoes", (req, res) => {
  res.json(tokenService.listarSessoesAtivas());
});

module.exports = router;

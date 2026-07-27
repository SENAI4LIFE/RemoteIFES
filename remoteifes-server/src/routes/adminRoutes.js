const express = require("express");
const { exigirLogin, exigirAdmin } = require("../middlewares/auth");
const usuariosService = require("../services/usuariosService");
const salasService = require("../services/salasService");
const tokenService = require("../services/tokenService");

const router = express.Router();
router.use("/admin", exigirLogin, exigirAdmin);

router.get("/admin/usuarios", (req, res) => {
  res.json(usuariosService.listar());
});

router.post("/admin/usuarios", (req, res) => {
  try {
    const { usuario, senha, nome, podeControlar, podeAgendar, isAdmin } = req.body;
    if (!usuario || !senha || !nome) {
      return res.status(400).json({ ok: false, erro: "usuário, senha e nome são obrigatórios" });
    }
    const novo = usuariosService.criar({ usuario, senha, nome, podeControlar, podeAgendar, isAdmin });
    res.json({ ok: true, usuario: novo });
  } catch (err) {
    res.status(400).json({ ok: false, erro: err.message });
  }
});

router.patch("/admin/usuarios/:id", (req, res) => {
  try {
    const atualizado = usuariosService.atualizarPermissoes(Number(req.params.id), req.body, req.usuario);
    res.json({ ok: true, usuario: atualizado });
  } catch (err) {
    res.status(400).json({ ok: false, erro: err.message });
  }
});

router.patch("/admin/usuarios/:id/login", (req, res) => {
  try {
    const atualizado = usuariosService.trocarLogin(Number(req.params.id), req.body.novoLogin);
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

router.get("/admin/usuarios/:id/senha", (req, res) => {
  try {
    res.json({ ok: true, ...usuariosService.obterSenha(Number(req.params.id)) });
  } catch (err) {
    res.status(400).json({ ok: false, erro: err.message });
  }
});

router.patch("/admin/usuarios/:id/senha", (req, res) => {
  try {
    usuariosService.trocarSenha(Number(req.params.id), req.body.novaSenha);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, erro: err.message });
  }
});

router.get("/admin/logs", (req, res) => {
  res.json(salasService.listarLogs({ data: req.query.data }));
});

router.delete("/admin/logs", (req, res) => {
  salasService.apagarLogs({ data: req.query.data });
  res.json({ ok: true });
});

router.get("/admin/sessoes", (req, res) => {
  res.json(tokenService.listarUsuariosAtivos());
});

router.get("/admin/sessoes/historico", (req, res) => {
  res.json(tokenService.listarHistoricoSessoes({ data: req.query.data }));
});

router.delete("/admin/sessoes/historico", (req, res) => {
  tokenService.apagarHistoricoSessoes({ data: req.query.data });
  res.json({ ok: true });
});

router.get("/admin/dispositivos", (req, res) => {
  res.json(salasService.listarEventosEsp({ sala: req.query.sala, data: req.query.data }));
});

module.exports = router;

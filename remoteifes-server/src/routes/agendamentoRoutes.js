const express = require("express");
const { exigirLogin, exigirPermissao } = require("../middlewares/auth");
const agendamentosService = require("../services/agendamentosService");

const router = express.Router();

router.get("/agendamentos", exigirLogin, (req, res) => {
  const { sala } = req.query;
  res.json(agendamentosService.listar({ sala }));
});

router.post("/agendamentos", exigirLogin, exigirPermissao("podeAgendar"), (req, res) => {
  try {
    const ag = agendamentosService.criar({ ...req.body, usuarioId: req.usuario.id });
    res.json({ ok: true, agendamento: ag });
  } catch (err) {
    res.status(400).json({ ok: false, erro: err.message });
  }
});

router.patch("/agendamentos/:id", exigirLogin, (req, res) => {
  try {
    const ag = agendamentosService.alternar(Number(req.params.id), !!req.body.ativo, req.usuario);
    res.json({ ok: true, agendamento: ag });
  } catch (err) {
    res.status(403).json({ ok: false, erro: err.message });
  }
});

router.delete("/agendamentos/:id", exigirLogin, (req, res) => {
  try {
    agendamentosService.remover(Number(req.params.id), req.usuario);
    res.json({ ok: true });
  } catch (err) {
    res.status(403).json({ ok: false, erro: err.message });
  }
});

module.exports = router;

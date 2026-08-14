const express = require("express");
const { exigirLogin, exigirAdmin } = require("../middlewares/auth");
const agendamentosService = require("../services/agendamentosService");

const router = express.Router();
router.use("/agendamentos", exigirLogin, exigirAdmin);

router.get("/agendamentos", (req, res) => {
  const { sala } = req.query;
  res.json(agendamentosService.listar({ sala }));
});

router.post("/agendamentos", (req, res) => {
  try {
    const ag = agendamentosService.criar({ ...req.body, usuarioId: req.usuario.id });
    res.json({ ok: true, agendamento: ag });
  } catch (err) {
    res.status(400).json({ ok: false, erro: err.message });
  }
});

function parseId(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ ok: false, erro: "id inválido" });
    return null;
  }
  return id;
}

router.patch("/agendamentos/:id", (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;
  try {
    const ag = agendamentosService.alternar(id, !!req.body.ativo, req.usuario);
    res.json({ ok: true, agendamento: ag });
  } catch (err) {
    res.status(403).json({ ok: false, erro: err.message });
  }
});

router.delete("/agendamentos/:id", (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;
  try {
    agendamentosService.remover(id, req.usuario);
    res.json({ ok: true });
  } catch (err) {
    res.status(403).json({ ok: false, erro: err.message });
  }
});

module.exports = router;

const express = require("express");
const { exigirLogin, exigirAdmin } = require("../middlewares/auth");
const agendamentosService = require("../services/agendamentosService");
const auditoriaService = require("../services/auditoriaService");
const logger = require("../utils/logger");

const router = express.Router();
router.use("/agendamentos", exigirLogin, exigirAdmin);

function auditar(dados) {
  try { auditoriaService.registrar(dados); } catch (erro) { logger.warn("auditoria-registro-falhou", { tipo: dados.tipo, mensagem: erro.message }); }
}

function rotuloAgendamento(ag) {
  return `${ag.sala} ${ag.data} ${ag.horaInicio}-${ag.horaFim}`;
}

router.get("/agendamentos", (req, res) => {
  const { sala } = req.query;
  if (sala !== undefined && typeof sala !== "string") {
    return res.status(400).json({ ok: false, erro: "sala inválida" });
  }
  res.json(agendamentosService.listar({ sala }));
});

router.post("/agendamentos", (req, res) => {
  try {
    const ag = agendamentosService.criar({ ...req.body, usuarioId: req.usuario.id });
    auditar({ tipo: "agendamento_criado", ator: req.usuario, alvoTipo: "agendamento", alvoId: ag.id, alvoRotulo: ag.sala, descricao: `Agendamento criado: ${rotuloAgendamento(ag)} (${ag.modo})`, camposAlterados: ["sala", "data", "horaInicio", "horaFim", "temperatura", "modo"] });
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
  const ativo = req.body ? req.body.ativo : undefined;
  if (typeof ativo !== "boolean") {
    return res.status(400).json({ ok: false, erro: "ativo deve ser verdadeiro ou falso" });
  }
  try {
    const ag = agendamentosService.alternar(id, ativo, req.usuario);
    auditar({ tipo: ag.ativo ? "agendamento_ativado" : "agendamento_desativado", ator: req.usuario, alvoTipo: "agendamento", alvoId: ag.id, alvoRotulo: ag.sala, descricao: `Agendamento ${ag.ativo ? "ativado" : "desativado"}: ${rotuloAgendamento(ag)}`, camposAlterados: ["ativo"] });
    res.json({ ok: true, agendamento: ag });
  } catch (err) {
    res.status(403).json({ ok: false, erro: err.message });
  }
});

router.delete("/agendamentos/:id", (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;
  try {
    const ag = agendamentosService.buscarPorId(id);
    agendamentosService.remover(id, req.usuario);
    auditar({ tipo: "agendamento_excluido", ator: req.usuario, alvoTipo: "agendamento", alvoId: id, alvoRotulo: ag ? ag.sala : String(id), descricao: `Agendamento excluido: ${ag ? rotuloAgendamento(ag) : id}` });
    res.json({ ok: true });
  } catch (err) {
    res.status(403).json({ ok: false, erro: err.message });
  }
});

module.exports = router;

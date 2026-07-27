const express = require("express");
const { exigirLogin } = require("../middlewares/auth");
const salasService = require("../services/salasService");
const agendamentosService = require("../services/agendamentosService");

const router = express.Router();

router.get("/salas", exigirLogin, (req, res) => {
  const { bloco, andar } = req.query;
  const salas = salasService.listar({ bloco, andar });
  const agendadas = agendamentosService.salasComAgendamentoAtivo();

  res.json(
    salas.map((s) => ({
      sala: s.sala,
      nome: s.nome,
      bloco: s.bloco,
      andar: s.andar,
      online: !!s.online,
      ligado: !!s.ligado,
      agendadaAgora: !!agendadas[s.sala],
    }))
  );
});

router.get("/status", exigirLogin, (req, res) => {
  const { sala } = req.query;
  if (!sala) return res.status(400).json({ ok: false, erro: "informe a sala" });

  const dados = salasService.statusCompleto(sala, req.usuario);
  if (!dados) return res.status(404).json({ ok: false, erro: "sala não encontrada" });

  res.json(dados);
});

module.exports = router;

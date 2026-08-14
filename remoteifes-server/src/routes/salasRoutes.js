const express = require("express");
const { exigirLogin } = require("../middlewares/auth");
const salasService = require("../services/salasService");
const agendamentosService = require("../services/agendamentosService");

const router = express.Router();

router.get("/salas", exigirLogin, (req, res) => {
  const { bloco, andar } = req.query;
  if (bloco !== undefined && typeof bloco !== "string") {
    return res.status(400).json({ ok: false, erro: "bloco inválido" });
  }
  if (andar !== undefined && (typeof andar !== "string" || Number.isNaN(Number(andar)))) {
    return res.status(400).json({ ok: false, erro: "andar inválido" });
  }
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
      latitude: s.latitude,
      longitude: s.longitude,
    }))
  );
});

router.get("/status", exigirLogin, (req, res) => {
  const { sala } = req.query;
  if (!sala || typeof sala !== "string") return res.status(400).json({ ok: false, erro: "informe a sala" });

  const dados = salasService.statusCompleto(sala, req.usuario);
  if (!dados) return res.status(404).json({ ok: false, erro: "sala não encontrada" });

  res.json(dados);
});

module.exports = router;

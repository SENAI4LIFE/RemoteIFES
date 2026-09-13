const express = require("express");
const { exigirLogin } = require("../middlewares/auth");
const salasService = require("../services/salasService");
const agendamentosService = require("../services/agendamentosService");
const usuariosService = require("../services/usuariosService");
const auditoriaService = require("../services/auditoriaService");
const logger = require("../utils/logger");

const router = express.Router();

function auditar(dados) {
  try { auditoriaService.registrar(dados); } catch (erro) { logger.warn("auditoria-registro-falhou", { tipo: dados.tipo, mensagem: erro.message }); }
}

function exigirDonoDaSala(req, res, next) {
  if (req.usuario.isAdmin) return next();
  const sala = req.params.sala;
  if (sala && salasService.usuarioEhDonoDaSala(req.usuario.id, sala)) return next();
  return res.status(403).json({ ok: false, erro: "você não é proprietário desta sala" });
}

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
      acessoRestrito: !!s.acessoRestrito,
      podeControlarEsta: salasService.usuarioPodeControlarSala(req.usuario, s.sala),
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

router.get("/minhas-salas-propriedade", exigirLogin, (req, res) => {
  res.json(salasService.listarSalasDeDono(req.usuario.id));
});

router.get("/salas/:sala/proprietario/candidatos", exigirLogin, exigirDonoDaSala, (req, res) => {
  const candidatos = usuariosService
    .listar()
    .filter((u) => !u.isAdmin && u.ativo && u.id !== req.usuario.id)
    .map((u) => ({ id: u.id, usuario: u.usuario, nome: u.nome }));
  res.json(candidatos);
});

router.get("/salas/:sala/proprietario/acesso", exigirLogin, exigirDonoDaSala, (req, res) => {
  res.json(salasService.listarUsuariosComAcesso(req.params.sala));
});

router.post("/salas/:sala/proprietario/acesso/:usuarioId", exigirLogin, exigirDonoDaSala, (req, res) => {
  const usuarioId = Number(req.params.usuarioId);
  if (!Number.isInteger(usuarioId) || usuarioId <= 0) {
    return res.status(400).json({ ok: false, erro: "id inválido" });
  }
  try {
    if (usuarioId === req.usuario.id) {
      return res.status(400).json({ ok: false, erro: "você já tem acesso a esta sala como proprietário" });
    }
    const alvo = usuariosService.buscarPorId(usuarioId);
    if (!alvo) return res.status(404).json({ ok: false, erro: "usuário não encontrado" });
    if (alvo.nivel >= usuariosService.NIVEL_ADMIN) {
      return res.status(400).json({ ok: false, erro: "não é possível conceder acesso a um administrador" });
    }
    if (!alvo.ativo) {
      return res.status(400).json({ ok: false, erro: "usuário está desativado" });
    }
    const usuarios = salasService.concederAcesso(req.params.sala, usuarioId);
    auditar({ tipo: "sala_usuario_autorizado", ator: req.usuario, alvoTipo: "usuario", alvoId: usuarioId, alvoRotulo: alvo.usuario, descricao: `Acesso a sala ${req.params.sala} concedido a ${alvo.usuario} pelo proprietario` });
    res.json({ ok: true, usuarios });
  } catch (err) {
    res.status(400).json({ ok: false, erro: err.message });
  }
});

router.delete("/salas/:sala/proprietario/acesso/:usuarioId", exigirLogin, exigirDonoDaSala, (req, res) => {
  const usuarioId = Number(req.params.usuarioId);
  if (!Number.isInteger(usuarioId) || usuarioId <= 0) {
    return res.status(400).json({ ok: false, erro: "id inválido" });
  }
  const alvo = usuariosService.buscarPorId(usuarioId);
  const usuarios = salasService.revogarAcesso(req.params.sala, usuarioId);
  auditar({ tipo: "sala_usuario_revogado", ator: req.usuario, alvoTipo: "usuario", alvoId: usuarioId, alvoRotulo: alvo?.usuario || String(usuarioId), descricao: `Acesso a sala ${req.params.sala} revogado de ${alvo?.usuario || usuarioId} pelo proprietario` });
  res.json({ ok: true, usuarios });
});

module.exports = router;

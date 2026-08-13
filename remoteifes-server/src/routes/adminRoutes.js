const express = require("express");
const { exigirLogin, exigirAdmin } = require("../middlewares/auth");
const usuariosService = require("../services/usuariosService");
const salasService = require("../services/salasService");
const tokenService = require("../services/tokenService");
const configuracoesService = require("../services/configuracoesService");

const router = express.Router();
router.use("/admin", exigirLogin, exigirAdmin);

function parseId(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ ok: false, erro: "id inválido" });
    return null;
  }
  return id;
}

router.get("/admin/usuarios", (req, res) => {
  res.json(usuariosService.listar());
});

router.post("/admin/usuarios", (req, res) => {
  try {
    const { usuario, senha, nome, podeControlar, podeAgendar, isAdmin } = req.body;
    if (!usuario || !senha || !nome) {
      return res.status(400).json({ ok: false, erro: "usuário, senha e nome são obrigatórios" });
    }
    const novo = usuariosService.criar({ usuario, senha, nome, podeControlar, podeAgendar, isAdmin }, req.usuario);
    res.json({ ok: true, usuario: novo });
  } catch (err) {
    res.status(400).json({ ok: false, erro: err.message });
  }
});

router.patch("/admin/usuarios/:id", (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;
  try {
    const atualizado = usuariosService.atualizarPermissoes(id, req.body, req.usuario);
    res.json({ ok: true, usuario: atualizado });
  } catch (err) {
    res.status(400).json({ ok: false, erro: err.message });
  }
});

router.patch("/admin/usuarios/:id/login", (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;
  try {
    const atualizado = usuariosService.trocarLogin(id, req.body.novoLogin, req.usuario);
    res.json({ ok: true, usuario: atualizado });
  } catch (err) {
    res.status(400).json({ ok: false, erro: err.message });
  }
});

router.delete("/admin/usuarios/:id", (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;
  try {
    usuariosService.remover(id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, erro: err.message });
  }
});

router.patch("/admin/usuarios/:id/senha", (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;
  try {
    usuariosService.trocarSenha(id, req.body.novaSenha, req.usuario);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, erro: err.message });
  }
});

const DATA_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function parseData(req, res) {
  const { data } = req.query;
  if (data === undefined) return undefined;
  if (typeof data !== "string" || !DATA_REGEX.test(data)) {
    res.status(400).json({ ok: false, erro: "data inválida (use AAAA-MM-DD)" });
    return null;
  }
  return data;
}

router.get("/admin/logs", (req, res) => {
  const data = parseData(req, res);
  if (data === null) return;
  res.json(salasService.listarLogs({ data }));
});

router.delete("/admin/logs", (req, res) => {
  const data = parseData(req, res);
  if (data === null) return;
  salasService.apagarLogs({ data });
  res.json({ ok: true });
});

router.get("/admin/sessoes", (req, res) => {
  res.json(tokenService.listarUsuariosAtivos());
});

router.get("/admin/sessoes/historico", (req, res) => {
  const data = parseData(req, res);
  if (data === null) return;
  res.json(tokenService.listarHistoricoSessoes({ data }));
});

router.delete("/admin/sessoes/historico", (req, res) => {
  const data = parseData(req, res);
  if (data === null) return;
  tokenService.apagarHistoricoSessoes({ data });
  res.json({ ok: true });
});

router.get("/admin/dispositivos", (req, res) => {
  const data = parseData(req, res);
  if (data === null) return;
  const sala = req.query.sala;
  if (sala !== undefined && typeof sala !== "string") {
    return res.status(400).json({ ok: false, erro: "sala inválida" });
  }
  res.json(salasService.listarEventosEsp({ sala, data }));
});

router.get("/admin/acessos", (req, res) => {
  const data = parseData(req, res);
  if (data === null) return;
  const sala = req.query.sala;
  if (sala !== undefined && typeof sala !== "string") {
    return res.status(400).json({ ok: false, erro: "sala inválida" });
  }
  res.json(salasService.listarAcessosEsp({ sala, data }));
});

router.delete("/admin/acessos", (req, res) => {
  const data = parseData(req, res);
  if (data === null) return;
  salasService.apagarAcessosEsp({ data });
  res.json({ ok: true });
});

router.get("/admin/configuracoes", (req, res) => {
  res.json({ ok: true, configuracoes: configuracoesService.obter() });
});

router.patch("/admin/configuracoes", (req, res) => {
  try {
    const configuracoes = configuracoesService.validarEAtualizar(req.body || {});
    res.json({ ok: true, configuracoes });
  } catch (err) {
    res.status(400).json({ ok: false, erro: err.message });
  }
});

module.exports = router;

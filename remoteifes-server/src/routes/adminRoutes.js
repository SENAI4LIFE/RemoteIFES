const express = require("express");
const { exigirLogin, exigirAdmin, exigirSuperAdmin } = require("../middlewares/auth");
const usuariosService = require("../services/usuariosService");
const salasService = require("../services/salasService");
const tokenService = require("../services/tokenService");
const configuracoesService = require("../services/configuracoesService");
const notificacoesService = require("../services/notificacoesService");
const monitoramentoService = require("../services/monitoramentoService");

const router = express.Router();
router.use("/admin", exigirLogin, exigirAdmin);

function parseId(req, res, paramName = "id") {
  const id = Number(req.params[paramName]);
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
    const { usuario, senha, nome, podeControlar, isAdmin } = req.body;
    if (!usuario || !senha || !nome) {
      return res.status(400).json({ ok: false, erro: "usuário, senha e nome são obrigatórios" });
    }
    const novo = usuariosService.criar({ usuario, senha, nome, podeControlar, isAdmin }, req.usuario);
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

router.patch("/admin/usuarios/:id/nome", (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;
  try {
    const atualizado = usuariosService.trocarNome(id, req.body.novoNome, req.usuario);
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
    usuariosService.remover(id, req.usuario);
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
  const { sala, andar } = req.query;
  if (sala !== undefined && typeof sala !== "string") {
    return res.status(400).json({ ok: false, erro: "sala inválida" });
  }
  if (andar !== undefined && (typeof andar !== "string" || Number.isNaN(Number(andar)))) {
    return res.status(400).json({ ok: false, erro: "andar inválido" });
  }
  res.json(salasService.listarLogs({ data, sala, andar }));
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

router.get("/admin/monitoramento", (req, res) => {
  res.json({ ok: true, monitoramento: monitoramentoService.coletar() });
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

router.get("/admin/salas", (req, res) => {
  const salas = salasService.listar();
  res.json(
    salas.map((s) => ({
      sala: s.sala,
      nome: s.nome,
      bloco: s.bloco,
      andar: s.andar,
      online: !!s.online,
      ligado: !!s.ligado,
      ipEsp32: s.ipEsp32,
      mac: s.mac,
      temperaturaMinima: s.temperaturaMinima,
      temperaturaMaxima: s.temperaturaMaxima,
      acessoRestrito: !!s.acessoRestrito,
    }))
  );
});

router.get("/admin/esp32/detectados", exigirSuperAdmin, (req, res) => {
  res.json(salasService.listarDetectados());
});

router.delete("/admin/esp32/detectados/:mac", exigirSuperAdmin, (req, res) => {
  try {
    salasService.removerDetectado(req.params.mac);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, erro: err.message });
  }
});

router.patch("/admin/salas/:sala/acesso-restrito", exigirSuperAdmin, (req, res) => {
  try {
    const sala = salasService.definirAcessoRestrito(req.params.sala, !!req.body.restrito);
    res.json({ ok: true, sala });
  } catch (err) {
    res.status(400).json({ ok: false, erro: err.message });
  }
});

router.get("/admin/salas/:sala/acesso", (req, res) => {
  res.json(salasService.listarUsuariosComAcesso(req.params.sala));
});

router.post("/admin/salas/:sala/acesso/:usuarioId", (req, res) => {
  const usuarioId = parseId(req, res, "usuarioId");
  if (usuarioId === null) return;
  try {
    const usuarios = salasService.concederAcesso(req.params.sala, usuarioId);
    res.json({ ok: true, usuarios });
  } catch (err) {
    res.status(400).json({ ok: false, erro: err.message });
  }
});

router.delete("/admin/salas/:sala/acesso/:usuarioId", (req, res) => {
  const usuarioId = parseId(req, res, "usuarioId");
  if (usuarioId === null) return;
  const usuarios = salasService.revogarAcesso(req.params.sala, usuarioId);
  res.json({ ok: true, usuarios });
});

router.get("/admin/salas/:sala/donos", (req, res) => {
  res.json(salasService.listarDonos(req.params.sala));
});

router.post("/admin/salas/:sala/donos/:usuarioId", (req, res) => {
  const usuarioId = parseId(req, res, "usuarioId");
  if (usuarioId === null) return;
  try {
    const alvo = usuariosService.buscarPorId(usuarioId);
    if (!alvo) throw new Error("usuário não encontrado");
    if (alvo.nivel >= usuariosService.NIVEL_ADMIN) {
      throw new Error("administradores já possuem acesso total; não é necessário torná-los proprietários de sala");
    }
    const donos = salasService.concederDono(req.params.sala, usuarioId);
    res.json({ ok: true, donos });
  } catch (err) {
    res.status(400).json({ ok: false, erro: err.message });
  }
});

router.delete("/admin/salas/:sala/donos/:usuarioId", (req, res) => {
  const usuarioId = parseId(req, res, "usuarioId");
  if (usuarioId === null) return;
  try {
    const donos = salasService.revogarDono(req.params.sala, usuarioId);
    res.json({ ok: true, donos });
  } catch (err) {
    res.status(400).json({ ok: false, erro: err.message });
  }
});

router.get("/admin/configuracoes", exigirSuperAdmin, (req, res) => {
  res.json({ ok: true, configuracoes: configuracoesService.obter() });
});

router.patch("/admin/configuracoes", exigirSuperAdmin, (req, res) => {
  try {
    const configuracoes = configuracoesService.validarEAtualizar(req.body || {}, req.usuario);
    res.json({ ok: true, configuracoes });
  } catch (err) {
    res.status(err.permissao ? 403 : 400).json({ ok: false, erro: err.message });
  }
});

router.patch("/admin/salas/:sala/mac", exigirSuperAdmin, (req, res) => {
  try {
    const sala = salasService.cadastrarMac(req.params.sala, req.body.mac);
    res.json({ ok: true, sala });
  } catch (err) {
    res.status(400).json({ ok: false, erro: err.message });
  }
});

router.patch("/admin/salas/:sala/limites-temperatura", exigirSuperAdmin, (req, res) => {
  try {
    const sala = salasService.definirLimitesTemperatura(req.params.sala, req.body || {});
    res.json({ ok: true, sala });
  } catch (err) {
    res.status(400).json({ ok: false, erro: err.message });
  }
});

router.get("/admin/salas/:sala/acessar-esp32", exigirSuperAdmin, (req, res) => {
  const sala = salasService.buscar(req.params.sala);
  if (!sala) return res.status(404).json({ ok: false, erro: "sala não encontrada" });
  if (!sala.ipEsp32) {
    return res.status(404).json({ ok: false, erro: "esta sala ainda não reportou um IP de ESP32" });
  }
  res.json({ ok: true, sala: sala.sala, ip: sala.ipEsp32, url: `http://${sala.ipEsp32}/` });
});

router.get("/admin/notificacoes", (req, res) => {
  res.json(notificacoesService.listar());
});

router.get("/admin/notificacoes/contagem", (req, res) => {
  res.json({ naoLidas: notificacoesService.contarNaoLidas() });
});

router.post("/admin/notificacoes/:id/lida", (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;
  notificacoesService.marcarLida(id);
  res.json({ ok: true });
});

router.post("/admin/notificacoes/marcar-todas-lidas", (req, res) => {
  notificacoesService.marcarTodasLidas();
  res.json({ ok: true });
});

module.exports = router;

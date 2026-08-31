const express = require("express");
const { exigirLogin, exigirAdmin, exigirSuperAdmin } = require("../middlewares/auth");
const usuariosService = require("../services/usuariosService");
const salasService = require("../services/salasService");
const tokenService = require("../services/tokenService");
const configuracoesService = require("../services/configuracoesService");
const notificacoesService = require("../services/notificacoesService");
const monitoramentoService = require("../services/monitoramentoService");
const auditoriaService = require("../services/auditoriaService");
const energiaService = require("../services/energiaService");
const logger = require("../utils/logger");

const router = express.Router();
router.use("/admin", exigirLogin, exigirAdmin);

function auditar(dados) {
  try { auditoriaService.registrar(dados); } catch (erro) { logger.warn("auditoria-registro-falhou", { tipo: dados.tipo, mensagem: erro.message }); }
}

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
    auditar({ tipo: "conta_criada", ator: req.usuario, alvoTipo: "usuario", alvoId: novo.id, alvoRotulo: novo.usuario, descricao: `Conta ${novo.usuario} criada`, camposAlterados: ["usuario", "nome", "nivel", "podeControlar"] });
    res.json({ ok: true, usuario: novo });
  } catch (err) {
    res.status(400).json({ ok: false, erro: err.message });
  }
});

router.patch("/admin/usuarios/:id", (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;
  try {
    const antes = usuariosService.buscarPorId(id);
    const atualizado = usuariosService.atualizarPermissoes(id, req.body, req.usuario);
    const campos = ["nivel", "podeControlar", "ativo"].filter((campo) => antes && String(antes[campo]) !== String(atualizado[campo]));
    if (campos.length) auditar({ tipo: "conta_permissoes_alteradas", ator: req.usuario, alvoTipo: "usuario", alvoId: id, alvoRotulo: atualizado.usuario, descricao: `Permissoes de ${atualizado.usuario} alteradas`, camposAlterados: campos });
    res.json({ ok: true, usuario: atualizado });
  } catch (err) {
    res.status(400).json({ ok: false, erro: err.message });
  }
});

router.patch("/admin/usuarios/:id/nome", (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;
  try {
    const antes = usuariosService.buscarPorId(id);
    const atualizado = usuariosService.trocarNome(id, req.body.novoNome, req.usuario);
    auditar({ tipo: "conta_nome_alterado", ator: req.usuario, alvoTipo: "usuario", alvoId: id, alvoRotulo: atualizado.usuario, descricao: `Nome da conta ${atualizado.usuario} alterado`, camposAlterados: antes && antes.nome !== atualizado.nome ? ["nome"] : [] });
    res.json({ ok: true, usuario: atualizado });
  } catch (err) {
    res.status(400).json({ ok: false, erro: err.message });
  }
});

router.patch("/admin/usuarios/:id/login", (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;
  try {
    const antes = usuariosService.buscarPorId(id);
    const atualizado = usuariosService.trocarLogin(id, req.body.novoLogin, req.usuario);
    auditar({ tipo: "conta_login_alterado", ator: req.usuario, alvoTipo: "usuario", alvoId: id, alvoRotulo: atualizado.usuario, descricao: `Login ${antes ? antes.usuario : id} alterado para ${atualizado.usuario}`, camposAlterados: ["usuario"] });
    res.json({ ok: true, usuario: atualizado });
  } catch (err) {
    res.status(400).json({ ok: false, erro: err.message });
  }
});

router.delete("/admin/usuarios/:id", (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;
  try {
    const alvo = usuariosService.buscarPorId(id);
    usuariosService.remover(id, req.usuario);
    auditar({ tipo: "conta_excluida", ator: req.usuario, alvoTipo: "usuario", alvoId: id, alvoRotulo: alvo ? alvo.usuario : String(id), descricao: `Conta ${alvo ? alvo.usuario : id} excluida` });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, erro: err.message });
  }
});

router.patch("/admin/usuarios/:id/senha", (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;
  try {
    const alvo = usuariosService.buscarPorId(id);
    usuariosService.trocarSenha(id, req.body.novaSenha, req.usuario);
    auditar({ tipo: "conta_senha_redefinida", ator: req.usuario, alvoTipo: "usuario", alvoId: id, alvoRotulo: alvo ? alvo.usuario : String(id), descricao: `Senha da conta ${alvo ? alvo.usuario : id} redefinida`, camposAlterados: ["senha"] });
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
  auditar({ tipo: "historico_comandos_excluido", ator: req.usuario, alvoTipo: "historico", alvoId: data || "todos", alvoRotulo: "Logs de comandos", descricao: data ? `Logs de comandos de ${data} excluidos` : "Todos os logs de comandos excluidos" });
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
  auditar({ tipo: "historico_sessoes_excluido", ator: req.usuario, alvoTipo: "historico", alvoId: data || "todos", alvoRotulo: "Sessoes", descricao: data ? `Historico de sessoes de ${data} excluido` : "Historico de sessoes excluido" });
  res.json({ ok: true });
});

router.get("/admin/monitoramento", exigirSuperAdmin, (req, res) => {
  res.json({ ok: true, monitoramento: monitoramentoService.coletar() });
});

router.get("/admin/energia", exigirSuperAdmin, (req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    res.json({ ok: true, salas: energiaService.listar(), modelo: energiaService.modelo() });
  } catch (erro) {
    logger.warn("energia-consulta-falhou", { mensagem: erro.message });
    res.status(503).json({ ok: false, erro: "estimativas de energia temporariamente indisponiveis" });
  }
});

router.patch("/admin/energia/:sala", exigirSuperAdmin, (req, res) => {
  try {
    const configuracao = energiaService.configurar(req.params.sala, req.body || {});
    auditar({
      tipo: configuracao ? "energia_configuracao_alterada" : "energia_configuracao_removida",
      ator: req.usuario,
      alvoTipo: "sala",
      alvoId: req.params.sala,
      alvoRotulo: req.params.sala,
      descricao: configuracao ? `Configuracao energetica da sala ${req.params.sala} alterada` : `Configuracao energetica da sala ${req.params.sala} removida`,
      camposAlterados: ["potenciaWatts", "tipo"],
    });
    res.json({ ok: true, configuracao });
  } catch (erro) {
    res.status(400).json({ ok: false, erro: erro.message });
  }
});

router.get("/admin/auditoria", exigirSuperAdmin, (req, res) => {
  try { res.json({ ok: true, ...auditoriaService.listar(req.query) }); }
  catch (erro) { res.status(400).json({ ok: false, erro: erro.message }); }
});

router.get("/admin/auditoria/tipos", exigirSuperAdmin, (req, res) => {
  res.json({ ok: true, tipos: auditoriaService.tipos() });
});

router.get("/admin/auditoria/conectividade", exigirSuperAdmin, (req, res) => {
  try { res.json({ ok: true, ...auditoriaService.listarConectividade(req.query) }); }
  catch (erro) { res.status(400).json({ ok: false, erro: erro.message }); }
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
  auditar({ tipo: "historico_acessos_excluido", ator: req.usuario, alvoTipo: "historico", alvoId: data || "todos", alvoRotulo: "Acessos ESP32", descricao: data ? `Acessos ESP32 de ${data} excluidos` : "Acessos ESP32 excluidos" });
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
    auditar({ tipo: "esp32_detectado_removido", ator: req.usuario, alvoTipo: "esp32", alvoId: req.params.mac, alvoRotulo: req.params.mac, descricao: `Dispositivo detectado ${req.params.mac} removido` });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, erro: err.message });
  }
});

router.patch("/admin/salas/:sala/acesso-restrito", exigirSuperAdmin, (req, res) => {
  try {
    const sala = salasService.definirAcessoRestrito(req.params.sala, !!req.body.restrito);
    auditar({ tipo: "sala_acesso_alterado", ator: req.usuario, alvoTipo: "sala", alvoId: sala.sala, alvoRotulo: sala.sala, descricao: `Restricao de acesso da sala ${sala.sala} alterada`, camposAlterados: ["acessoRestrito"] });
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
    const alvo = usuariosService.buscarPorId(usuarioId);
    auditar({ tipo: "sala_usuario_autorizado", ator: req.usuario, alvoTipo: "usuario", alvoId: usuarioId, alvoRotulo: alvo?.usuario || String(usuarioId), descricao: `Acesso a sala ${req.params.sala} concedido a ${alvo?.usuario || usuarioId}` });
    res.json({ ok: true, usuarios });
  } catch (err) {
    res.status(400).json({ ok: false, erro: err.message });
  }
});

router.delete("/admin/salas/:sala/acesso/:usuarioId", (req, res) => {
  const usuarioId = parseId(req, res, "usuarioId");
  if (usuarioId === null) return;
  const usuarios = salasService.revogarAcesso(req.params.sala, usuarioId);
  const alvo = usuariosService.buscarPorId(usuarioId);
  auditar({ tipo: "sala_usuario_revogado", ator: req.usuario, alvoTipo: "usuario", alvoId: usuarioId, alvoRotulo: alvo?.usuario || String(usuarioId), descricao: `Acesso a sala ${req.params.sala} revogado de ${alvo?.usuario || usuarioId}` });
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
    auditar({ tipo: "sala_proprietario_concedido", ator: req.usuario, alvoTipo: "usuario", alvoId: usuarioId, alvoRotulo: alvo.usuario, descricao: `${alvo.usuario} tornou-se proprietario da sala ${req.params.sala}` });
    res.json({ ok: true, donos });
  } catch (err) {
    res.status(400).json({ ok: false, erro: err.message });
  }
});

router.delete("/admin/salas/:sala/donos/:usuarioId", (req, res) => {
  const usuarioId = parseId(req, res, "usuarioId");
  if (usuarioId === null) return;
  try {
    const alvo = usuariosService.buscarPorId(usuarioId);
    const donos = salasService.revogarDono(req.params.sala, usuarioId);
    auditar({ tipo: "sala_proprietario_revogado", ator: req.usuario, alvoTipo: "usuario", alvoId: usuarioId, alvoRotulo: alvo?.usuario || String(usuarioId), descricao: `Propriedade da sala ${req.params.sala} revogada de ${alvo?.usuario || usuarioId}` });
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
    const anteriores = configuracoesService.obter();
    const configuracoes = configuracoesService.validarEAtualizar(req.body || {}, req.usuario);
    const campos = Object.keys(req.body || {}).filter((chave) =>
      Object.prototype.hasOwnProperty.call(configuracoes, chave) &&
      !/senha|segredo|token/i.test(chave) &&
      JSON.stringify(anteriores[chave]) !== JSON.stringify(configuracoes[chave])
    );
    if (campos.length) auditar({ tipo: "configuracao_alterada", ator: req.usuario, alvoTipo: "configuracao", alvoId: "global", alvoRotulo: "Configuracoes globais", descricao: `Configuracoes alteradas: ${campos.join(", ")}`, camposAlterados: campos });
    if (campos.includes("retencaoAuditoriaDias")) require("../services/retencaoService").executarLimpezaRetencao();
    res.json({ ok: true, configuracoes });
  } catch (err) {
    res.status(err.permissao ? 403 : 400).json({ ok: false, erro: err.message });
  }
});

router.patch("/admin/salas/:sala/mac", exigirSuperAdmin, (req, res) => {
  try {
    const antes = salasService.buscar(req.params.sala);
    const sala = salasService.cadastrarMac(req.params.sala, req.body.mac);
    const tipo = !antes?.mac && sala.mac ? "esp32_registrado" : antes?.mac && !sala.mac ? "esp32_removido" : "esp32_reassociado";
    auditar({ tipo, ator: req.usuario, alvoTipo: "esp32", alvoId: sala.sala, alvoRotulo: sala.sala, descricao: `Vinculo do ESP32 da sala ${sala.sala} alterado`, camposAlterados: ["mac"] });
    res.json({ ok: true, sala });
  } catch (err) {
    res.status(400).json({ ok: false, erro: err.message });
  }
});

router.patch("/admin/salas/:sala/limites-temperatura", exigirSuperAdmin, (req, res) => {
  try {
    const sala = salasService.definirLimitesTemperatura(req.params.sala, req.body || {});
    auditar({ tipo: "sala_limites_alterados", ator: req.usuario, alvoTipo: "sala", alvoId: sala.sala, alvoRotulo: sala.sala, descricao: `Limites de temperatura da sala ${sala.sala} alterados`, camposAlterados: ["temperaturaMinima", "temperaturaMaxima"] });
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

const express = require("express");
const bcrypt = require("bcryptjs");
const usuariosService = require("../services/usuariosService");
const salasService = require("../services/salasService");
const configuracoesService = require("../services/configuracoesService");
const { gerarToken, validarToken, removerToken } = require("../services/tokenService");
const { exigirLogin } = require("../middlewares/auth");
const { criarLimitador } = require("../utils/rateLimiter");
const logger = require("../utils/logger");

const router = express.Router();

const limitarLogin = criarLimitador({ janelaMs: 15 * 60 * 1000, maxTentativas: 20 });
const HASH_COMPARACAO_INVALIDA = bcrypt.hashSync("credencial-invalida-para-comparacao", 10);

router.post("/login", limitarLogin, (req, res) => {
  const { usuario, senha } = req.body || {};

  if (typeof usuario !== "string" || typeof senha !== "string" || !usuario.trim() || !senha) {
    return res.status(400).json({ ok: false, erro: "usuário e senha são obrigatórios" });
  }
  if (usuario.length > usuariosService.LOGIN_MAX || senha.length > usuariosService.SENHA_MAX) {
    bcrypt.compareSync("credencial-invalida", HASH_COMPARACAO_INVALIDA);
    return res.status(401).json({ ok: false, erro: "usuario ou senha invalidos" });
  }

  const registro = usuariosService.buscarPorUsuario(usuario);
  const senhaValida = bcrypt.compareSync(senha, registro ? registro.senhaHash : HASH_COMPARACAO_INVALIDA);
  if (!registro || !registro.ativo || !senhaValida) {
    logger.warn("login-falhou", { usuario, ip: req.ip });
    return res.status(401).json({ ok: false, erro: "usuário ou senha inválidos" });
  }

  const isAdmin = registro.nivel >= usuariosService.NIVEL_ADMIN;
  if (!isAdmin && configuracoesService.modoManutencaoAtivo()) {
    return res.status(503).json({ ok: false, erro: "sistema em manutenção: apenas administradores podem entrar no momento", manutencao: true });
  }

  const token = gerarToken(registro.id);
  const sessao = validarToken(token, { atualizarUso: false });
  const config = configuracoesService.obter();

  res.set("Cache-Control", "no-store");
  res.json({
    ok: true,
    token,
    nome: registro.nome,
    usuario: registro.usuario,
    nivel: registro.nivel,
    isAdmin,
    isSuperAdmin: registro.nivel === usuariosService.NIVEL_SUPERADMIN,
    senhaPadraoAtiva: usuariosService.senhaPadraoAtiva(registro),
    podeControlar: !!registro.podeControlar,
    temSalaComoProprietario: salasService.usuarioEhDonoDeAlgumaSala(registro.id),

    timeoutInatividadeMinutos: configuracoesService.timeoutEfetivoParaUsuario(isAdmin),
    popupAvisoSegundos: config.popupAvisoSegundos,
    sessaoExpiraEm: sessao.sessaoExpiraEm,
    servidorAgora: sessao.servidorAgora,
  });
});

router.get("/me", exigirLogin, (req, res) => {
  const usuario = req.usuario;
  const isAdmin = usuario.nivel >= usuariosService.NIVEL_ADMIN;
  const config = configuracoesService.obter();

  res.json({
    ok: true,
    nome: usuario.nome,
    usuario: usuario.usuario,
    nivel: usuario.nivel,
    isAdmin,
    isSuperAdmin: usuario.nivel === usuariosService.NIVEL_SUPERADMIN,
    senhaPadraoAtiva: usuariosService.senhaPadraoAtiva(usuario),
    podeControlar: !!usuario.podeControlar,
    temSalaComoProprietario: salasService.usuarioEhDonoDeAlgumaSala(usuario.id),
    timeoutInatividadeMinutos: configuracoesService.timeoutEfetivoParaUsuario(isAdmin),
    popupAvisoSegundos: config.popupAvisoSegundos,
    sessaoExpiraEm: usuario.sessaoExpiraEm,
    servidorAgora: usuario.servidorAgora,
  });
});

router.patch("/me/senha", exigirLogin, (req, res) => {
  if (!usuariosService.senhaPadraoAtiva(req.usuario)) {
    return res.status(403).json({ ok: false, erro: "a credencial padrao nao esta ativa" });
  }
  try {
    usuariosService.trocarSenha(req.usuario.id, req.body && req.body.novaSenha, req.usuario);
    res.set("Cache-Control", "no-store");
    return res.json({ ok: true });
  } catch (erro) {
    return res.status(400).json({ ok: false, erro: erro.message });
  }
});

router.post("/logout", exigirLogin, (req, res) => {
  removerToken(req.token);
  res.json({ ok: true });
});

router.post("/ping", exigirLogin, (req, res) => {
  res.json({ ok: true, sessaoExpiraEm: req.usuario.sessaoExpiraEm, servidorAgora: req.usuario.servidorAgora });
});

module.exports = router;

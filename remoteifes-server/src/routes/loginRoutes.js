const express = require("express");
const bcrypt = require("bcryptjs");
const usuariosService = require("../services/usuariosService");
const salasService = require("../services/salasService");
const configuracoesService = require("../services/configuracoesService");
const { gerarToken, removerToken } = require("../services/tokenService");
const { exigirLogin } = require("../middlewares/auth");
const { criarLimitador } = require("../utils/rateLimiter");

const router = express.Router();

const limitarLogin = criarLimitador({ janelaMs: 15 * 60 * 1000, maxTentativas: 100 });

router.post("/login", limitarLogin, (req, res) => {
  const { usuario, senha } = req.body || {};

  if (typeof usuario !== "string" || typeof senha !== "string" || !usuario.trim() || !senha) {
    return res.status(400).json({ ok: false, erro: "usuário e senha são obrigatórios" });
  }

  const registro = usuariosService.buscarPorUsuario(usuario);
  if (!registro || !registro.ativo || !bcrypt.compareSync(senha, registro.senhaHash)) {
    return res.status(401).json({ ok: false, erro: "usuário ou senha inválidos" });
  }

  const token = gerarToken(registro.id);
  const isAdmin = registro.nivel >= usuariosService.NIVEL_ADMIN;
  const config = configuracoesService.obter();

  res.json({
    ok: true,
    token,
    nome: registro.nome,
    usuario: registro.usuario,
    nivel: registro.nivel,
    isAdmin,
    isSuperAdmin: registro.nivel === usuariosService.NIVEL_SUPERADMIN,
    podeControlar: !!registro.podeControlar,
    temSalaComoProprietario: salasService.usuarioEhDonoDeAlgumaSala(registro.id),

    timeoutInatividadeMinutos: configuracoesService.timeoutEfetivoParaUsuario(isAdmin),
    popupAvisoSegundos: config.popupAvisoSegundos,
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
    podeControlar: !!usuario.podeControlar,
    temSalaComoProprietario: salasService.usuarioEhDonoDeAlgumaSala(usuario.id),
    timeoutInatividadeMinutos: configuracoesService.timeoutEfetivoParaUsuario(isAdmin),
    popupAvisoSegundos: config.popupAvisoSegundos,
  });
});

router.post("/logout", exigirLogin, (req, res) => {
  removerToken(req.token);
  res.json({ ok: true });
});

router.post("/ping", exigirLogin, (req, res) => {
  res.json({ ok: true });
});

module.exports = router;

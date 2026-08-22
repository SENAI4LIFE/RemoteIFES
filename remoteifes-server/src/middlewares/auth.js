const { validarToken } = require("../services/tokenService");
const configuracoesService = require("../services/configuracoesService");

const NIVEL_ADMIN = 2;

function extrairToken(req) {
  const header = req.headers.authorization || "";
  const [tipo, token] = header.split(" ");
  return tipo === "Bearer" ? token : null;
}

function exigirLogin(req, res, next) {
  const token = extrairToken(req);
  const usuario = token ? validarToken(token) : null;

  if (!usuario) {
    return res.status(401).json({ ok: false, erro: "não autenticado" });
  }

  if (usuario.nivel < NIVEL_ADMIN && configuracoesService.modoManutencaoAtivo()) {
    return res.status(503).json({ ok: false, erro: "sistema em manutenção", manutencao: true });
  }

  req.usuario = usuario;
  req.token = token;
  next();
}

function exigirAdmin(req, res, next) {
  if (!req.usuario || !req.usuario.isAdmin) {
    return res.status(403).json({ ok: false, erro: "apenas administradores" });
  }
  next();
}

const NIVEL_SUPERADMIN = 3;

function exigirSuperAdmin(req, res, next) {
  if (!req.usuario || req.usuario.nivel !== NIVEL_SUPERADMIN) {
    return res.status(403).json({ ok: false, erro: "apenas o administrador principal" });
  }
  next();
}

function exigirPermissao(campo) {
  return (req, res, next) => {
    if (req.usuario.isAdmin || req.usuario[campo]) return next();
    return res.status(403).json({ ok: false, erro: "sem permissão para esta ação" });
  };
}

module.exports = { exigirLogin, exigirAdmin, exigirSuperAdmin, exigirPermissao };

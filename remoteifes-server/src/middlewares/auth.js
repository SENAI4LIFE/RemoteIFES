const { validarToken } = require("../services/tokenService");

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

function exigirPermissao(campo) {
  return (req, res, next) => {
    if (req.usuario.isAdmin || req.usuario[campo]) return next();
    return res.status(403).json({ ok: false, erro: "sem permissão para esta ação" });
  };
}

module.exports = { exigirLogin, exigirAdmin, exigirPermissao };

const configuracoesService = require("../services/configuracoesService");
const { ipAutorizado, proxyLocalNaoDeclarado } = require("../utils/rede");
const { saltosDeProxy } = require("../config/proxy");

function restringirRedeIFES(req, res, next) {
  if ((process.env.NODE_ENV || "development") !== "production") return next();

  const { modoTeste, redesAutorizadas } = configuracoesService.acessoRestritoAtivo();
  if (modoTeste) return next();

  const loopback = !proxyLocalNaoDeclarado(req.headers, req.socket && req.socket.remoteAddress, saltosDeProxy());
  if (ipAutorizado(req.ip, redesAutorizadas, { loopback })) {
    return next();
  }

  return res.status(403).json({ ok: false, erro: "acesso permitido apenas a partir da rede do IFES" });
}

module.exports = { restringirRedeIFES };

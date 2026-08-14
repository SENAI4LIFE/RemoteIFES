const configuracoesService = require("../services/configuracoesService");
const { ipAutorizado } = require("../utils/rede");

function restringirRedeIFES(req, res, next) {
  if ((process.env.NODE_ENV || "development") !== "production") return next();

  const { modoTeste, redesAutorizadas } = configuracoesService.acessoRestritoAtivo();
  if (modoTeste) return next();

  if (ipAutorizado(req.ip, redesAutorizadas)) {
    return next();
  }

  return res.status(403).json({ ok: false, erro: "acesso permitido apenas a partir da rede do IFES" });
}

module.exports = { restringirRedeIFES };

function criarLimitador({ janelaMs, maxTentativas }) {
  const tentativasPorChave = new Map();

  setInterval(() => {
    const agora = Date.now();
    for (const [chave, registro] of tentativasPorChave) {
      if (agora - registro.inicioJanela > janelaMs) tentativasPorChave.delete(chave);
    }
  }, janelaMs).unref();

  return function limitar(req, res, next) {
    const chave = req.ip || req.connection.remoteAddress || "desconhecido";
    const agora = Date.now();
    let registro = tentativasPorChave.get(chave);

    if (!registro || agora - registro.inicioJanela > janelaMs) {
      registro = { inicioJanela: agora, contagem: 0 };
      tentativasPorChave.set(chave, registro);
    }

    registro.contagem += 1;

    if (registro.contagem > maxTentativas) {
      const restanteMs = janelaMs - (agora - registro.inicioJanela);
      res.set("Retry-After", String(Math.ceil(restanteMs / 1000)));
      return res.status(429).json({ ok: false, erro: "muitas tentativas, tente novamente mais tarde" });
    }

    next();
  };
}

module.exports = { criarLimitador };

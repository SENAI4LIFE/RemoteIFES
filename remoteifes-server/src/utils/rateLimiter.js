const FATOR_TETO_IP_PADRAO = 20;

function criarJanelas(janelaMs) {
  const registros = new Map();
  setInterval(() => {
    const agora = Date.now();
    for (const [chave, registro] of registros) {
      if (agora - registro.inicioJanela > janelaMs) registros.delete(chave);
    }
  }, janelaMs).unref();

  function obter(chave, agora) {
    let registro = registros.get(chave);
    if (!registro || agora - registro.inicioJanela > janelaMs) {
      registro = { inicioJanela: agora, contagem: 0 };
      registros.set(chave, registro);
    }
    return registro;
  }

  return { obter, tamanho: () => registros.size };
}

function ipDe(req) {
  return req.ip || (req.connection && req.connection.remoteAddress) || "desconhecido";
}

function recusar(res, registro, janelaMs, agora) {
  const restanteMs = Math.max(1000, janelaMs - (agora - registro.inicioJanela));
  res.set("Retry-After", String(Math.ceil(restanteMs / 1000)));
  return res.status(429).json({ ok: false, erro: "muitas tentativas, tente novamente mais tarde" });
}

function criarLimitador({ janelaMs, maxTentativas, chave = null, tetoPorIp = null, contarApenasFalhas = false }) {
  const principais = criarJanelas(janelaMs);
  const porIp = criarJanelas(janelaMs);
  const tetoIp = tetoPorIp === null ? maxTentativas * FATOR_TETO_IP_PADRAO : tetoPorIp;

  function limitar(req, res, next) {
    const agora = Date.now();
    const ip = ipDe(req);
    const principal = typeof chave === "function" ? chave(req) : null;

    const temPrincipal = principal !== null && principal !== undefined;
    const registroIp = porIp.obter(ip, agora);
    const limiteIp = temPrincipal ? tetoIp : maxTentativas;

    // The address is admitted before the identity's window exists: the identity comes from the
    // request (a device header), so creating its window first would let refused requests keep
    // allocating one per invented value.
    if (registroIp.contagem >= limiteIp) return recusar(res, registroIp, janelaMs, agora);
    const registroPrincipal = temPrincipal ? principais.obter(`${principal}`, agora) : null;
    if (registroPrincipal && registroPrincipal.contagem >= maxTentativas) return recusar(res, registroPrincipal, janelaMs, agora);

    registroIp.contagem += 1;
    if (registroPrincipal) registroPrincipal.contagem += 1;
    if (contarApenasFalhas) {
      res.on("finish", () => {
        if (res.statusCode !== 200 && res.statusCode !== 503) return;
        registroIp.contagem = Math.max(0, registroIp.contagem - 1);
        if (registroPrincipal) registroPrincipal.contagem = Math.max(0, registroPrincipal.contagem - 1);
      });
    }
    next();
  }

  // Identity windows currently held (tests check that refused requests do not add any).
  limitar.identidadesEmJanela = () => principais.tamanho();
  return limitar;
}

module.exports = { criarLimitador };

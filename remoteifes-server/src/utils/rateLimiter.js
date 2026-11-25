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
      registro = { inicioJanela: agora, contagem: 0, pendentes: 0 };
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

function criarLimitador({ janelaMs, maxTentativas, chave = null, tetoPorIp = null }) {
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
    next();
  }

  // Identity windows currently held (tests check that refused requests do not add any).
  limitar.identidadesEmJanela = () => principais.tamanho();
  return limitar;
}

function limitarLogin({ janelaMs, maxTentativas }, autenticar) {
  const janelas = criarJanelas(janelaMs);
  return async (req, res, next) => {
    const agora = Date.now();
    const registro = janelas.obter(ipDe(req), agora);
    if (registro.contagem >= maxTentativas) return recusar(res, registro, janelaMs, agora);
    if (registro.contagem + registro.pendentes >= maxTentativas) return loginOcupado(res);

    registro.pendentes += 1;
    try {
      await autenticar(req, res);
      if (res.statusCode === 400 || res.statusCode === 401) registro.contagem += 1;
    } catch (erro) {
      next(erro);
    } finally {
      registro.pendentes -= 1;
    }
  };
}

function loginOcupado(res) {
  res.set("Retry-After", "1");
  return res.status(503).json({ ok: false, erro: "login ocupado, tente novamente em instantes" });
}

module.exports = { criarLimitador, limitarLogin, loginOcupado };

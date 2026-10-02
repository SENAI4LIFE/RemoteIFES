const logger = require("../utils/logger");

// TRUST_PROXY is the number of reverse proxies in front of the server (README, Configuração). The
// same number decides the client's address for the HTTP API (Express), for the browser WebSocket and
// for the guard against an undeclared local proxy, so the three cannot disagree. Anything other than
// an integer from 0 to SALTOS_MAX is taken as 0, with a warning: behind a proxy, 0 makes the network
// restriction refuse what the proxy forwards, instead of trusting headers it cannot verify.

// No real chain comes near this; a larger number would make Express trust every forwarded hop.
const SALTOS_MAX = 32;

let avisado = false;

function saltosDeProxy(valor = process.env.TRUST_PROXY) {
  const texto = String(valor ?? "").trim();
  if (texto === "") return 0;
  if (/^\d+$/.test(texto) && Number(texto) <= SALTOS_MAX) return Number(texto);
  if (!avisado) {
    avisado = true;
    logger.warn("trust-proxy-invalido", {
      valor: texto,
      acao: `TRUST_PROXY é o número de proxies reversos na frente do servidor (0 a ${SALTOS_MAX}); usando 0`,
    });
  }
  return 0;
}

module.exports = { saltosDeProxy, SALTOS_MAX };

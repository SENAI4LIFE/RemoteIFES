const net = require("net");

function ipParaInteiro(ip) {
  const partes = ip.split(".").map(Number);
  if (partes.length !== 4 || partes.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return null;
  return ((partes[0] << 24) | (partes[1] << 16) | (partes[2] << 8) | partes[3]) >>> 0;
}

function normalizarIp(ip) {
  if (!ip) return null;
  let limpo = ip.trim();
  if (limpo.startsWith("::ffff:")) limpo = limpo.slice(7);
  if (limpo === "::1") return "127.0.0.1";
  return limpo;
}

function ipNaFaixa(ip, faixaCidr) {
  const ipNormalizado = normalizarIp(ip);
  if (!ipNormalizado) return false;

  const [base, prefixoStr] = faixaCidr.includes("/") ? faixaCidr.split("/") : [faixaCidr, "32"];
  const prefixo = Number(prefixoStr);
  const baseInt = ipParaInteiro(base);
  const ipInt = ipParaInteiro(ipNormalizado);
  if (baseInt === null || ipInt === null || Number.isNaN(prefixo) || prefixo < 0 || prefixo > 32) {
    return false;
  }

  if (prefixo === 0) return true;
  const mascara = (0xffffffff << (32 - prefixo)) >>> 0;
  return (baseInt & mascara) === (ipInt & mascara);
}

// `loopback: false` judges a loopback address by the authorized ranges alone (see
// proxyLocalNaoDeclarado).
function ipAutorizado(ip, faixasAutorizadas, { loopback = true } = {}) {
  const ipNormalizado = normalizarIp(ip);
  if (!ipNormalizado) return false;
  if (loopback && ipNormalizado === "127.0.0.1") return true;
  if (!Array.isArray(faixasAutorizadas) || faixasAutorizadas.length === 0) return false;
  return faixasAutorizadas.some((faixa) => ipNaFaixa(ipNormalizado, faixa));
}

function resolverIpCliente(headerXFF, enderecoSocket, hopsConfiaveis) {
  const remetente = normalizarIp(enderecoSocket) || enderecoSocket;
  const hops = Number(hopsConfiaveis) || 0;
  if (hops <= 0 || !headerXFF) return remetente;

  const cadeia = headerXFF.split(",").map((p) => p.trim()).filter(Boolean);
  if (cadeia.length === 0) return remetente;

  const indice = Math.max(0, cadeia.length - hops);
  return normalizarIp(cadeia[indice]) || cadeia[indice];
}

// An address a device reports about itself (the board's own LAN IP behind NAT or a proxy) is kept
// only when it is an IP literal; anything else, from an empty value to a 90 KB string sent to an
// unauthenticated route, falls back to the socket's address.
const IP_TEXTO_MAX = 45;

function ipDeclarado(valor, alternativa) {
  if (typeof valor === "string") {
    const limpo = valor.trim();
    if (limpo.length <= IP_TEXTO_MAX && net.isIP(limpo)) return limpo;
  }
  return alternativa;
}

const CABECALHOS_DE_PROXY = ["x-forwarded-for", "forwarded", "x-real-ip"];

// With no trusted proxy declared (TRUST_PROXY 0, src/config/proxy.js) the server takes the socket's
// address as the client's. A loopback peer that carries a forwarding header is then a local proxy the
// configuration does not declare: every client behind it would look like 127.0.0.1, which is always
// admitted, and the network restriction would silently stop applying. Such a request is judged by
// the authorized ranges alone. An SSH tunnel, the watchdog and the Operations Console reach loopback
// without those headers and keep the exemption.
function proxyLocalNaoDeclarado(cabecalhos, enderecoSocket, saltosConfiaveis) {
  if ((Number(saltosConfiaveis) || 0) > 0) return false;
  if (normalizarIp(enderecoSocket) !== "127.0.0.1") return false;
  return CABECALHOS_DE_PROXY.some((nome) => cabecalhos && cabecalhos[nome] !== undefined);
}

module.exports = {
  ipAutorizado,
  ipNaFaixa,
  normalizarIp,
  resolverIpCliente,
  ipDeclarado,
  proxyLocalNaoDeclarado,
};

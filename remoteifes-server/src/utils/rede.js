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

function ipAutorizado(ip, faixasAutorizadas) {
  const ipNormalizado = normalizarIp(ip);
  if (!ipNormalizado) return false;
  if (ipNormalizado === "127.0.0.1") return true;
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

module.exports = { ipAutorizado, ipNaFaixa, normalizarIp, resolverIpCliente };

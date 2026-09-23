const fs = require("fs");
const path = require("path");

// Dependências de produção que um console instalado leva: o verificador de releases (veja o
// package.json).
//
// A lista vem do package-lock.json, que nomeia cada pacote instalado, fixa a sua versão e marca os
// que só os testes usam. Um payload leva exatamente os pacotes de produção, cada um conferido
// contra a versão que o lockfile fixou, então uma instalação nunca roda um pacote que ninguém
// revisou e o mock de atestações usado pelos testes nunca é distribuído. O build
// (empacotar/construir.js) e o instalador (instalacao/instalar.js) usam esta mesma lista.

const PREFIXO = "node_modules/";

/**
 * Caminhos relativos (`node_modules/<pacote>`) dos pacotes de produção instalados sob `raiz`.
 * Lança quando um falta ou está em outra versão: construir ou instalar sem o verificador produziria
 * um console que nunca consegue aceitar uma atualização.
 */
function listarDependencias(raiz) {
  const arquivo = path.join(raiz, "package-lock.json");
  let trava;
  try {
    trava = JSON.parse(fs.readFileSync(arquivo, "utf8"));
  } catch {
    throw new Error(`${arquivo} ausente ou ilegível: é dele que vem a lista de dependências de produção`);
  }
  const saida = [];
  for (const [chave, info] of Object.entries(trava.packages || {})) {
    if (!chave.startsWith(PREFIXO) || !info || info.dev || info.devOptional) continue;
    // Um node_modules aninhado viaja dentro do pacote que o contém.
    if (chave.slice(PREFIXO.length).includes(`/${PREFIXO}`)) continue;
    let instalada = null;
    try {
      instalada = JSON.parse(fs.readFileSync(path.join(raiz, ...chave.split("/"), "package.json"), "utf8")).version;
    } catch {}
    if (instalada === null && info.optional) continue;
    if (instalada !== info.version) {
      const nome = chave.slice(PREFIXO.length);
      throw new Error(
        `dependência ${nome} ${instalada ? `na versão ${instalada}` : "ausente"}, e o package-lock.json fixa ${info.version}. ` +
          `Rode "npm ci --omit=dev" em ${raiz}.`
      );
    }
    saida.push(chave);
  }
  return saida.sort();
}

module.exports = { listarDependencias };

const fs = require("fs");
const path = require("path");

// Production dependencies an installed Console carries: the release verifier (see package.json).
//
// The list comes from package-lock.json, which names every installed package, pins its version and
// marks the ones only tests use. A payload carries exactly the production packages, each checked
// against the version the lockfile pinned, so an installation never runs a package nobody reviewed
// and the attestation mock used by the tests never ships. The build (empacotar/construir.js) and
// the installer (instalacao/instalar.js) both use this list.

const PREFIXO = "node_modules/";

/**
 * Relative paths (`node_modules/<pacote>`) of the production packages installed under `raiz`.
 * Throws when one is missing or at another version: building or installing without the verifier
 * would produce a Console that can never accept an update.
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
    // A nested node_modules travels inside the package that holds it.
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

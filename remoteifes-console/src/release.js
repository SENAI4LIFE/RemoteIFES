const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const config = require("./config");
const estado = require("./estado");

// Trust root for Console updates.
//
// Verified, in this order, **before** any write to the active directory:
//   1. Ed25519 signature of the manifest by a trusted key;
//   2. manifest validity (`expiraEm`), against replay and version freezing;
//   3. existence of an artifact for this target (OS + runtime architecture);
//   4. version policy (minimum to update, and no downgrade over the network);
//   5. SHA-256 and size of the file actually written.
//
// A SHA-256 from the same untrusted origin as the artifact proves nothing: it only has value
// **after** the manifest signature checks out. That is why the digest is never checked in
// isolation.
//
// PUBLISHING KEY: the matching private key does not exist in this repository. Until a production
// key is provisioned, `CHAVE_PUBLICA_OFICIAL` stays null and release updates report themselves as
// **not configured** instead of accepting any manifest. Configuring means publishing the public key
// here (or in CONSOLE_CHAVE_RELEASE for test environments) and signing with
// `empacotar/assinar-manifesto.js`.

const ESQUEMA_SUPORTADO = 1;

// Ed25519 public key in base64 (SPKI DER). Null until a production key is published.
const CHAVE_PUBLICA_OFICIAL = null;

const RE_VERSAO = /^\d+\.\d+\.\d+$/;
const RE_SHA256 = /^[0-9a-f]{64}$/;
const RE_ARQUIVO = /^[A-Za-z0-9._-]{1,120}$/;

function chaveDeBase64(base64) {
  return crypto.createPublicKey({ key: Buffer.from(base64, "base64"), format: "der", type: "spki" });
}

/**
 * Accepted keys: the embedded one, the environment one (tests) and already authenticated rotated
 * keys.
 */
function chavesConfiaveis() {
  const chaves = [];
  const adicionar = (base64, origem) => {
    if (!base64) return;
    try {
      chaves.push({ chave: chaveDeBase64(base64), base64, origem });
    } catch {}
  };
  adicionar(CHAVE_PUBLICA_OFICIAL, "embutida");
  adicionar(process.env.CONSOLE_CHAVE_RELEASE, "ambiente");
  const rotacionadas = estado.lerJson(path.join(config.DIR_ESTADO, "chaves-release.json"), { chaves: [] });
  for (const item of rotacionadas.chaves || []) adicionar(item.publica, `rotacionada em ${item.aceitaEm}`);
  return chaves;
}

function confianciaConfigurada() {
  return chavesConfiaveis().length > 0;
}

function compararVersoes(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

/**
 * Verifies the manifest's signature and shape. Receives the file's **exact bytes**, because the
 * signature covers bytes, not a reserialized object.
 */
function verificarManifesto(bytesManifesto, assinatura, { agora = new Date() } = {}) {
  const chaves = chavesConfiaveis();
  if (!chaves.length) {
    return {
      ok: false,
      motivo:
        "a atualização por release não está configurada: nenhuma chave pública de publicação foi provisionada neste console. " +
        "Sem raiz de confiança, nenhum artefato é aceito.",
      naoConfigurado: true,
    };
  }
  if (!Buffer.isBuffer(bytesManifesto) || !bytesManifesto.length) return { ok: false, motivo: "manifesto vazio" };

  let assinaturaBin;
  try {
    assinaturaBin = Buffer.from(String(assinatura).trim(), "base64");
  } catch {
    return { ok: false, motivo: "assinatura ilegível" };
  }
  if (assinaturaBin.length !== 64) return { ok: false, motivo: "assinatura Ed25519 tem tamanho inesperado" };

  const usada = chaves.find((c) => {
    try {
      return crypto.verify(null, bytesManifesto, c.chave, assinaturaBin);
    } catch {
      return false;
    }
  });
  if (!usada) return { ok: false, motivo: "a assinatura do manifesto não confere com nenhuma chave confiável" };

  let manifesto;
  try {
    manifesto = JSON.parse(bytesManifesto.toString("utf8"));
  } catch {
    return { ok: false, motivo: "manifesto não é JSON válido" };
  }

  if (manifesto.esquema !== ESQUEMA_SUPORTADO) {
    return { ok: false, motivo: `esquema de manifesto ${manifesto.esquema} não é suportado por esta versão do console` };
  }
  if (!RE_VERSAO.test(String(manifesto.versao || ""))) return { ok: false, motivo: "versão do manifesto inválida" };
  if (!manifesto.expiraEm || Number.isNaN(Date.parse(manifesto.expiraEm))) {
    return { ok: false, motivo: "manifesto sem validade declarada" };
  }
  // Validity closes replay and freezing: a re-presented old manifest does not pass.
  if (Date.parse(manifesto.expiraEm) < agora.getTime()) {
    return { ok: false, motivo: `manifesto expirado em ${manifesto.expiraEm}; obtenha a publicação atual` };
  }
  if (!Array.isArray(manifesto.artefatos) || !manifesto.artefatos.length) {
    return { ok: false, motivo: "manifesto sem artefatos" };
  }
  for (const artefato of manifesto.artefatos) {
    if (!RE_ARQUIVO.test(String(artefato.arquivo || ""))) return { ok: false, motivo: "nome de artefato inválido no manifesto" };
    if (!RE_SHA256.test(String(artefato.sha256 || ""))) return { ok: false, motivo: `artefato ${artefato.arquivo} sem SHA-256 válido` };
    if (!Number.isSafeInteger(artefato.bytes) || artefato.bytes <= 0) return { ok: false, motivo: `artefato ${artefato.arquivo} sem tamanho válido` };
    if (!/^[a-z0-9]+-[a-z0-9]+$/.test(String(artefato.alvo || ""))) return { ok: false, motivo: `artefato ${artefato.arquivo} sem alvo válido` };
  }

  return { ok: true, manifesto, chaveUsada: usada.origem };
}

/**
 * Accepts the successor key declared inside an already authenticated manifest. Since it comes
 * signed by the current key, rotation opens no new surface.
 */
function registrarRotacao(manifesto) {
  const proxima = manifesto && manifesto.proximaChave;
  if (!proxima || typeof proxima.publica !== "string") return { rotacionada: false };
  try {
    chaveDeBase64(proxima.publica);
  } catch {
    return { rotacionada: false, motivo: "chave sucessora ilegível" };
  }
  const arquivo = path.join(config.DIR_ESTADO, "chaves-release.json");
  const atual = estado.lerJson(arquivo, { chaves: [] });
  if ((atual.chaves || []).some((c) => c.publica === proxima.publica)) return { rotacionada: false, jaConhecida: true };
  atual.chaves = [...(atual.chaves || []), { publica: proxima.publica, aceitaEm: new Date().toISOString(), viaVersao: manifesto.versao }].slice(-5);
  estado.gravarJson(arquivo, atual, 0o600);
  estado.auditar("release-chave-rotacionada", { viaVersao: manifesto.versao });
  return { rotacionada: true };
}

/**
 * This Console's target: OS + runtime architecture, which is what will execute the code.
 */
function alvoAtual() {
  const so = { win32: "windows", darwin: "macos", linux: "linux" }[process.platform] || process.platform;
  return `${so}-${process.arch}`;
}

function escolherArtefato(manifesto, alvo = alvoAtual()) {
  const artefato = manifesto.artefatos.find((a) => a.alvo === alvo);
  if (!artefato) {
    return {
      ok: false,
      motivo:
        `esta publicação não traz artefato para ${alvo}. Alvos disponíveis: ${manifesto.artefatos.map((a) => a.alvo).join(", ")}. ` +
        "Instalar um artefato de outra arquitetura deixaria o console sem subir.",
    };
  }
  return { ok: true, artefato };
}

/**
 * Version policy. Downgrade over the network is refused: going back uses the already verified local
 * copy, through an explicit rollback action.
 */
function politicaDeVersao(manifesto, versaoInstalada) {
  if (compararVersoes(manifesto.versao, versaoInstalada) === 0) {
    return { ok: false, motivo: `a versão ${manifesto.versao} já é a instalada.`, jaInstalada: true };
  }
  if (compararVersoes(manifesto.versao, versaoInstalada) < 0) {
    return {
      ok: false,
      motivo:
        `${manifesto.versao} é anterior à instalada (${versaoInstalada}). Atualização não faz downgrade; ` +
        "para voltar, use a reversão, que usa a cópia local já verificada.",
    };
  }
  const minimo = manifesto.minimoParaAtualizar;
  // A present but malformed minimum is refused rather than ignored: the publisher declared a
  // requirement and it could not be evaluated.
  if (minimo !== null && minimo !== undefined && !RE_VERSAO.test(String(minimo))) {
    return {
      ok: false,
      motivo: `o manifesto declara minimoParaAtualizar inválido (${JSON.stringify(minimo)}); atualização recusada por não ser possível avaliar a compatibilidade.`,
    };
  }
  if (minimo && compararVersoes(versaoInstalada, minimo) < 0) {
    return {
      ok: false,
      motivo:
        `esta publicação exige console ${minimo} ou mais novo, e o instalado é ${versaoInstalada}. ` +
        "Atualize primeiro para uma versão intermediária.",
    };
  }
  return { ok: true };
}

/** Confere o arquivo realmente gravado contra o manifesto autenticado. */
/**
 * Checks an artifact against the signed manifest and **returns the checked bytes**.
 *
 * Returning the content closes the window between verification and installation: verifying and
 * extracting the SAME buffer leaves no second read to attack. This matters on the offline path,
 * where the artifact is a path the operator supplied (a shared /tmp, a mounted USB drive) and a
 * swap is plausible.
 */
function conferirArtefato(caminho, artefato, { limiteBytes = Infinity } = {}) {
  // Size is checked with `stat` BEFORE reading. Reading first and comparing afterwards would load
  // an arbitrarily large file into memory; on a 1 GiB Pi that brings the host down before any check
  // says the artifact was invalid.
  let info;
  try {
    info = fs.statSync(caminho);
  } catch {
    return { ok: false, motivo: "o arquivo baixado não existe" };
  }
  if (info.size !== artefato.bytes) {
    return { ok: false, motivo: `tamanho divergente: ${info.size} bytes no arquivo, ${artefato.bytes} declarados no manifesto` };
  }
  if (info.size > limiteBytes) {
    return { ok: false, motivo: `o artefato tem ${info.size} bytes, acima do teto de ${limiteBytes} deste console` };
  }

  let conteudo;
  try {
    conteudo = fs.readFileSync(caminho);
  } catch (erro) {
    return { ok: false, motivo: `não foi possível ler o artefato: ${erro.code || erro.message}` };
  }
  if (conteudo.length !== artefato.bytes) {
    return { ok: false, motivo: `o arquivo mudou de tamanho durante a leitura (${conteudo.length} bytes)` };
  }
  const digest = crypto.createHash("sha256").update(conteudo).digest("hex");
  if (digest !== artefato.sha256) {
    return { ok: false, motivo: `SHA-256 divergente: ${digest} calculado, ${artefato.sha256} declarado no manifesto` };
  }
  return { ok: true, sha256: digest, bytes: conteudo.length, conteudo };
}

module.exports = {
  ESQUEMA_SUPORTADO,
  CHAVE_PUBLICA_OFICIAL,
  chavesConfiaveis,
  confianciaConfigurada,
  verificarManifesto,
  registrarRotacao,
  alvoAtual,
  escolherArtefato,
  politicaDeVersao,
  conferirArtefato,
  compararVersoes,
};

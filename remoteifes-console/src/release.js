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
// PUBLISHING KEY: only the public half lives here. The private key belongs to the release
// maintainer, outside this repository and outside CI; `empacotar/assinar-manifesto.js` signs with
// it. Installing, bootstrapping and running the Console never need it: installed copies carry this
// key and verify publications by themselves. DISTRIBUICAO.md, section 5, has the signing, rotation
// and key-loss procedures.

const ESQUEMA_SUPORTADO = 1;

// Production publishing key: Ed25519, SPKI DER in base64. Its identifier (idDaChave) is documented
// in DISTRIBUICAO.md so an operator can compare it with what the Programa tab shows.
const CHAVE_PUBLICA_OFICIAL = "MCowBQYDK2VwAyEAVnTqrShYEnetLU2MXd0OFUiMT26m+6xs02MZB0vflTo=";

const RE_VERSAO = /^\d+\.\d+\.\d+$/;
const RE_SHA256 = /^[0-9a-f]{64}$/;
const RE_ARQUIVO = /^[A-Za-z0-9._-]{1,120}$/;
// A 64-byte Ed25519 signature in canonical base64. Node's decoder skips characters it does not
// know, so a lenient parse would accept text that is not the signature that was published.
const RE_ASSINATURA = /^[A-Za-z0-9+/]{86}==$/;

// Successor keys and retired keys kept in the state directory. Both lists are short by nature (a
// key is rotated a few times in a product's life); the caps keep a hostile file from growing them.
const MAX_SUCESSORAS = 5;
const MAX_APOSENTADAS = 20;

/** Loads an SPKI public key and refuses anything that is not Ed25519. */
function chaveDeBase64(base64) {
  if (typeof base64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64.trim())) throw new Error("chave pública ilegível");
  const chave = crypto.createPublicKey({ key: Buffer.from(base64.trim(), "base64"), format: "der", type: "spki" });
  if (chave.asymmetricKeyType !== "ed25519") throw new Error(`chave ${chave.asymmetricKeyType}, não Ed25519`);
  return chave;
}

/** Full SHA-256 fingerprint of the key (over its SPKI DER). */
function impressaoDaChave(base64) {
  return crypto.createHash("sha256").update(Buffer.from(String(base64).trim(), "base64")).digest("hex");
}

/** Short identifier shown to operators and written to the audit log. */
function idDaChave(base64) {
  return `ed25519:${impressaoDaChave(base64).slice(0, 16)}`;
}

function arquivoDeChaves() {
  return path.join(config.DIR_ESTADO, "chaves-release.json");
}

function lerRegistro() {
  const registro = estado.lerJson(arquivoDeChaves(), {});
  return {
    chaves: Array.isArray(registro.chaves) ? registro.chaves.filter((c) => c && typeof c === "object") : [],
    aposentadas: Array.isArray(registro.aposentadas) ? registro.aposentadas.filter((a) => a && typeof a.id === "string") : [],
  };
}

/**
 * Keys that verify publications.
 *
 * Anchors: the key embedded in this code and, for test environments, CONSOLE_CHAVE_RELEASE (only
 * whoever controls the process environment can set it, and the Programa tab names its origin).
 * Successors: keys declared by an authenticated manifest, each bound to the anchor its chain
 * started from. A successor counts only while that anchor is still an anchor, so installing a
 * package that embeds a new key after a compromise also drops the successors the old key vouched
 * for. Retired keys never count again.
 */
function chavesConfiaveis({ registro = lerRegistro() } = {}) {
  const chaves = [];
  const adicionar = (base64, origem, extra = {}) => {
    if (!base64) return;
    try {
      const chave = chaveDeBase64(base64);
      const id = idDaChave(base64);
      if (chaves.some((c) => c.id === id)) return;
      chaves.push({ chave, base64: base64.trim(), id, origem, ...extra });
    } catch {}
  };
  adicionar(CHAVE_PUBLICA_OFICIAL, "embutida");
  adicionar(process.env.CONSOLE_CHAVE_RELEASE, "ambiente");
  const ancoras = new Set(chaves.map((c) => c.id));
  for (const item of registro.chaves) {
    if (typeof item.publica === "string" && ancoras.has(item.ancora)) {
      adicionar(item.publica, `sucessora aceita em ${item.aceitaEm}`, { ancora: item.ancora, anterior: item.anterior });
    }
  }
  const aposentadas = new Set(registro.aposentadas.map((a) => a.id));
  return chaves.filter((c) => !aposentadas.has(c.id));
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
 * Shape and validity of a manifest. Shared by the Console and by the signing tool, so a manifest
 * the publisher signs is one the Console accepts.
 */
function validarEstrutura(manifesto, { agora = new Date(), idAssinante = null, aposentadas = new Set() } = {}) {
  if (!manifesto || typeof manifesto !== "object" || Array.isArray(manifesto)) return { ok: false, motivo: "manifesto não é um objeto JSON" };
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
  const alvos = new Set();
  const arquivos = new Set();
  for (const artefato of manifesto.artefatos) {
    if (!artefato || typeof artefato !== "object") return { ok: false, motivo: "artefato malformado no manifesto" };
    if (!RE_ARQUIVO.test(String(artefato.arquivo || ""))) return { ok: false, motivo: "nome de artefato inválido no manifesto" };
    if (!RE_SHA256.test(String(artefato.sha256 || ""))) return { ok: false, motivo: `artefato ${artefato.arquivo} sem SHA-256 válido` };
    if (!Number.isSafeInteger(artefato.bytes) || artefato.bytes <= 0) return { ok: false, motivo: `artefato ${artefato.arquivo} sem tamanho válido` };
    if (!/^[a-z0-9]+-[a-z0-9]+$/.test(String(artefato.alvo || ""))) return { ok: false, motivo: `artefato ${artefato.arquivo} sem alvo válido` };
    // Two entries for one target would make the choice depend on their order.
    if (alvos.has(artefato.alvo)) return { ok: false, motivo: `o manifesto declara dois artefatos para ${artefato.alvo}` };
    if (arquivos.has(artefato.arquivo)) return { ok: false, motivo: `o manifesto declara ${artefato.arquivo} duas vezes` };
    alvos.add(artefato.alvo);
    arquivos.add(artefato.arquivo);
  }
  // A declared successor that cannot be used is a publishing error: refusing it keeps the rotation
  // from failing silently on some consoles and not on others.
  const proxima = manifesto.proximaChave;
  if (proxima !== null && proxima !== undefined) {
    if (typeof proxima !== "object" || typeof proxima.publica !== "string") return { ok: false, motivo: "proximaChave malformada no manifesto" };
    let id;
    try {
      chaveDeBase64(proxima.publica);
      id = idDaChave(proxima.publica);
    } catch (erro) {
      return { ok: false, motivo: `proximaChave recusada: ${erro.message}` };
    }
    if (idAssinante && id === idAssinante) return { ok: false, motivo: "proximaChave é a própria chave que assinou o manifesto" };
    if (aposentadas.has(id)) return { ok: false, motivo: `proximaChave ${id} já foi aposentada neste console` };
  }
  return { ok: true };
}

// Results issued by verificarManifesto against this console's own trust. Only those can register
// a rotation, so the rule "a successor comes from an authenticated manifest" is held by the code
// and not by each caller's discipline.
const VERIFICADAS = new WeakSet();

/**
 * Verifies the manifest's signature and shape. Receives the file's **exact bytes**, because the
 * signature covers bytes, not a reserialized object.
 *
 * `chaves` replaces this console's trust with an explicit list (the signing tool checks a release
 * against the key it is meant for); such a result cannot register a rotation.
 */
function verificarManifesto(bytesManifesto, assinatura, { agora = new Date(), chaves: chavesExplicitas = null } = {}) {
  const registro = chavesExplicitas ? { chaves: [], aposentadas: [] } : lerRegistro();
  const chaves = chavesExplicitas || chavesConfiaveis({ registro });
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

  const texto = typeof assinatura === "string" ? assinatura.trim() : Buffer.isBuffer(assinatura) ? assinatura.toString("utf8").trim() : "";
  if (!RE_ASSINATURA.test(texto)) return { ok: false, motivo: "assinatura malformada: esperado Ed25519 de 64 bytes em base64" };
  const assinaturaBin = Buffer.from(texto, "base64");

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

  const estrutura = validarEstrutura(manifesto, {
    agora,
    idAssinante: usada.id,
    aposentadas: new Set(registro.aposentadas.map((a) => a.id)),
  });
  if (!estrutura.ok) return estrutura;

  const resultado = { ok: true, manifesto, chaveUsada: usada.origem, idChave: usada.id };
  if (!chavesExplicitas) {
    VERIFICADAS.add(resultado);
    Object.defineProperty(resultado, "assinante", { value: usada, enumerable: false });
  }
  return resultado;
}

/**
 * Records what an authenticated manifest says about keys.
 *
 *   - Transition: a manifest signed by a successor retires the keys it succeeded, so a predecessor
 *     key that later leaks no longer verifies anything here.
 *   - Rotation: a declared `proximaChave` becomes trusted, bound to the anchor of the key that
 *     signed. It came signed by a trusted key, so rotation opens no new surface.
 *
 * Accepts only a result verificarManifesto issued on this console's own trust.
 */
function registrarRotacao(verificacao) {
  if (!verificacao || !VERIFICADAS.has(verificacao)) return { rotacionada: false, motivo: "rotação só a partir de manifesto verificado" };
  const assinante = verificacao.assinante;
  const manifesto = verificacao.manifesto;
  const registro = lerRegistro();
  const agora = new Date().toISOString();
  let mudou = false;
  const aposentadasAgora = [];

  if (assinante.anterior) {
    const aposentadas = new Set(registro.aposentadas.map((a) => a.id));
    let id = assinante.anterior;
    for (let passos = 0; id && passos <= registro.chaves.length; passos += 1) {
      if (id === assinante.id || aposentadas.has(id)) break;
      registro.aposentadas.push({ id, em: agora, substituidaPor: assinante.id });
      aposentadas.add(id);
      aposentadasAgora.push(id);
      const entrada = registro.chaves.find((c) => typeof c.publica === "string" && idDaChave(c.publica) === id);
      id = entrada ? entrada.anterior : null;
    }
    if (aposentadasAgora.length) {
      registro.chaves = registro.chaves.filter((c) => typeof c.publica === "string" && !aposentadasAgora.includes(idDaChave(c.publica)));
      mudou = true;
    }
  }

  let rotacionada = false;
  const proxima = manifesto.proximaChave;
  if (proxima && typeof proxima.publica === "string") {
    const id = idDaChave(proxima.publica);
    if (!registro.chaves.some((c) => typeof c.publica === "string" && idDaChave(c.publica) === id)) {
      registro.chaves.push({
        publica: proxima.publica.trim(),
        aceitaEm: agora,
        viaVersao: manifesto.versao,
        ancora: assinante.ancora || assinante.id,
        anterior: assinante.id,
      });
      rotacionada = true;
      mudou = true;
    }
  }

  if (!mudou) return { rotacionada: false, jaConhecida: !!proxima };
  registro.chaves = registro.chaves.slice(-MAX_SUCESSORAS);
  registro.aposentadas = registro.aposentadas.slice(-MAX_APOSENTADAS);
  estado.gravarJson(arquivoDeChaves(), registro, 0o600);
  if (aposentadasAgora.length) estado.auditar("release-chave-aposentada", { chaves: aposentadasAgora, substituidaPor: assinante.id });
  if (rotacionada) estado.auditar("release-chave-rotacionada", { viaVersao: manifesto.versao, sucessora: idDaChave(proxima.publica), assinante: assinante.id });
  return { rotacionada, aposentadas: aposentadasAgora };
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
  chaveDeBase64,
  idDaChave,
  impressaoDaChave,
  chavesConfiaveis,
  confianciaConfigurada,
  validarEstrutura,
  verificarManifesto,
  registrarRotacao,
  alvoAtual,
  escolherArtefato,
  politicaDeVersao,
  conferirArtefato,
  compararVersoes,
};

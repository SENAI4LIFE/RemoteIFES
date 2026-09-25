const crypto = require("crypto");
const fs = require("fs");

// Release manifest, target and version policy for Console updates.
//
// The manifest is what a release says about itself: version, commit and one payload per target.
// It is trusted only after src/atestacao.js proved it is the exact file GitHub Actions attested for
// that version's tag. Then, in this order and before any write to the active directory:
//   1. existence of an artifact for this target (OS + runtime architecture);
//   2. version policy (minimum to update, and no downgrade over the network);
//   3. SHA-256 and size of the file actually written, against the attested manifest.
//
// A SHA-256 from the same untrusted origin as the artifact proves nothing by itself: it only has
// value because the manifest that declares it is attested, and the attestation lists the same
// digest. That is why the digest is never checked in isolation.

const ESQUEMA_SUPORTADO = 1;

const RE_VERSAO = /^\d+\.\d+\.\d+$/;
const RE_SHA256 = /^[0-9a-f]{64}$/;
const RE_COMMIT = /^[0-9a-f]{40}$/;
const RE_ALVO = /^[a-z0-9]+-[a-z0-9]+$/;

function compararVersoes(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

/** Payload file name of a version for a target. Fixed, so a name cannot point at another target. */
function nomeDoPayload(versao, alvo) {
  return `remoteifes-console-${versao}-${alvo}.tar.gz`;
}

/**
 * Shape of a manifest. Shared by the Console and by the build, so a manifest the release workflow
 * produces is one the Console accepts.
 */
function validarEstrutura(manifesto) {
  if (manifesto.esquema !== ESQUEMA_SUPORTADO) {
    return { ok: false, motivo: `esquema de manifesto ${manifesto.esquema} não é suportado por esta versão do console` };
  }
  if (!RE_VERSAO.test(String(manifesto.versao || ""))) return { ok: false, motivo: "versão do manifesto inválida" };
  // The commit ties the manifest to the certificate: the attestation says which commit was built.
  if (!RE_COMMIT.test(String(manifesto.commit || ""))) return { ok: false, motivo: "manifesto sem o commit construído" };
  if (!Array.isArray(manifesto.artefatos) || !manifesto.artefatos.length) {
    return { ok: false, motivo: "manifesto sem artefatos" };
  }
  for (const artefato of manifesto.artefatos) {
    if (!RE_ALVO.test(String(artefato.alvo || ""))) return { ok: false, motivo: "artefato sem alvo válido no manifesto" };
    if (artefato.arquivo !== nomeDoPayload(manifesto.versao, artefato.alvo)) {
      return { ok: false, motivo: `o artefato de ${artefato.alvo} deveria se chamar ${nomeDoPayload(manifesto.versao, artefato.alvo)}` };
    }
    if (!RE_SHA256.test(String(artefato.sha256 || ""))) return { ok: false, motivo: `artefato ${artefato.arquivo} sem SHA-256 válido` };
    if (!Number.isSafeInteger(artefato.bytes) || artefato.bytes <= 0) return { ok: false, motivo: `artefato ${artefato.arquivo} sem tamanho válido` };
  }
  return { ok: true };
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
 * Checks an artifact against the attested manifest and **returns the checked bytes**.
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
  nomeDoPayload,
  validarEstrutura,
  alvoAtual,
  escolherArtefato,
  politicaDeVersao,
  conferirArtefato,
  compararVersoes,
};

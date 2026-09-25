const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const config = require("./config");
const estado = require("./estado");
const release = require("./release");

// Provenance of Console releases: GitHub artifact attestations, keyless.
//
// A release is trusted because GitHub Actions, running this repository's dedicated release
// workflow for a release tag, attested its exact bytes. No RemoteIFES signing key exists anywhere:
// the workflow's short-lived GitHub OIDC token is exchanged for a Sigstore (Fulcio) certificate
// valid for ten minutes, the signature is recorded in the public transparency log (Rekor), and the
// attestation bundle carries the certificate, the log entry and the signed in-toto statement.
//
// What is checked, in this order, before any artifact is written:
//   1. the bundle is well formed and holds a DSSE envelope with an in-toto statement;
//   2. cryptography, by @sigstore/verify against the Sigstore trusted root: certificate chain to
//      Fulcio at the signing time, certificate transparency, transparency log inclusion and the
//      envelope signature. Nothing of this is implemented here;
//   3. identity, from the CERTIFICATE only: issuer, repository and owner (by name and by numeric
//      id, so a renamed or recreated repository does not inherit the trust), the release workflow
//      at the release tag, the push trigger, a GitHub-hosted runner and the release environment;
//   4. the statement: SLSA provenance, whose subjects include the manifest's exact digest and every
//      artifact the manifest lists, with the digest the manifest declares;
//   5. the manifest: its version is the tag in the certificate and its commit is the commit the
//      certificate says was built.
// The statement's predicate is signed but composed inside the workflow run, so it never decides
// identity; it is only required to agree with the certificate.

const IDENTIDADE_OFICIAL = Object.freeze({
  emissor: "https://token.actions.githubusercontent.com",
  repositorio: "https://github.com/SENAI4LIFE/RemoteIFES",
  repositorioId: "1313157228",
  dono: "https://github.com/SENAI4LIFE",
  donoId: "211847016",
  workflow: ".github/workflows/console-release.yml",
  gatilho: "push",
  executor: "github-hosted",
  ambiente: "console-release",
});

const TIPO_PAYLOAD = "application/vnd.in-toto+json";
const TIPO_DECLARACAO = "https://in-toto.io/Statement/v1";
const TIPO_PREDICADO = "https://slsa.dev/provenance/v1";

// Release file names. The manifest describes the release; the bundle attests the manifest and
// every artifact at once.
const ARQUIVO_MANIFESTO = "manifesto.json";
const ARQUIVO_ATESTACAO = "atestacao.sigstore.json";

const LIMITE_ATESTACAO = 2 * 1024 * 1024;
const MAX_SUJEITOS = 500;

// Fulcio certificate extensions (https://github.com/sigstore/fulcio/blob/main/docs/oid-info.md).
const OID = Object.freeze({
  emissor: "1.3.6.1.4.1.57264.1.8",
  assinante: "1.3.6.1.4.1.57264.1.9",
  executor: "1.3.6.1.4.1.57264.1.11",
  repositorio: "1.3.6.1.4.1.57264.1.12",
  commit: "1.3.6.1.4.1.57264.1.13",
  ref: "1.3.6.1.4.1.57264.1.14",
  repositorioId: "1.3.6.1.4.1.57264.1.15",
  dono: "1.3.6.1.4.1.57264.1.16",
  donoId: "1.3.6.1.4.1.57264.1.17",
  configuracao: "1.3.6.1.4.1.57264.1.18",
  configuracaoCommit: "1.3.6.1.4.1.57264.1.19",
  gatilho: "1.3.6.1.4.1.57264.1.20",
  execucao: "1.3.6.1.4.1.57264.1.21",
  ambiente: "1.3.6.1.4.1.57264.1.23",
});

// Sigstore's public TUF repository, which distributes the trusted root (Fulcio, Rekor, CT and
// timestamp keys). Timeouts are per request and there is no retry: a failed refresh simply means
// "not now", and the next check tries again.
const ESPELHO_TUF = "https://tuf-repo-cdn.sigstore.dev";
const TEMPO_TUF_MS = 10_000;

function dirSigstore() {
  return path.join(config.DIR_ESTADO, "sigstore");
}

// The root the last successful refresh produced, kept apart from the TUF client's own cache so
// the offline path never depends on how that library lays out its files.
function arquivoRaizVerificada() {
  return path.join(dirSigstore(), "trusted_root.json");
}

function refDaVersao(versao) {
  return `refs/tags/console-v${versao}`;
}

function assinanteDaVersao(versao, identidade = IDENTIDADE_OFICIAL) {
  return `${identidade.repositorio}/${identidade.workflow}@${refDaVersao(versao)}`;
}

function recusa(motivo, codigo) {
  return { ok: false, motivo, codigo };
}

// --- Trusted root ------------------------------------------------------------------------------

let atualizacaoEmCurso = null;

/**
 * The Sigstore trusted root.
 *
 * `rede: true` refreshes it through TUF: metadata signed by Sigstore's root keys, checked against
 * the root embedded in @sigstore/tuf and then against every rotation since. It is how a key
 * Sigstore retired stops being trusted here. The TUF cache and the resulting root stay in the
 * state directory (about 60 KB; files are overwritten, versions do not accumulate).
 *
 * `rede: false` never touches the network: the last root a refresh verified, or else the one
 * embedded in @sigstore/tuf. It serves the offline import, where no refresh is possible; what
 * it cannot know is a key Sigstore revoked after that copy was made.
 *
 * Concurrent refreshes in this process share one request.
 */
async function raizDeConfianca({ rede = false } = {}) {
  const { TrustedRoot } = require("@sigstore/protobuf-specs");
  if (rede) {
    if (!atualizacaoEmCurso) {
      const { getTrustedRoot } = require("@sigstore/tuf");
      atualizacaoEmCurso = getTrustedRoot({
        cachePath: path.join(dirSigstore(), "tuf"),
        mirrorURL: modulo.ESPELHO_TUF,
        timeout: modulo.TEMPO_TUF_MS,
        retry: false,
      })
        .then((raiz) => {
          try {
            estado.gravarJson(arquivoRaizVerificada(), TrustedRoot.toJSON(raiz), 0o600);
          } catch {
            // Not keeping a copy costs only the offline import a fresher root.
          }
          return raiz;
        })
        .finally(() => {
          atualizacaoEmCurso = null;
        });
    }
    return { raiz: await atualizacaoEmCurso, origem: "tuf" };
  }

  try {
    return { raiz: TrustedRoot.fromJSON(JSON.parse(fs.readFileSync(arquivoRaizVerificada(), "utf8"))), origem: "cache" };
  } catch {
    // Absent or unreadable: the embedded copy is always there.
  }
  const sementes = require("@sigstore/tuf/seeds.json");
  const semente = sementes[ESPELHO_TUF] && sementes[ESPELHO_TUF].targets && sementes[ESPELHO_TUF].targets["trusted_root.json"];
  if (!semente) throw new Error("a raiz de confiança do Sigstore embutida não foi encontrada");
  return { raiz: TrustedRoot.fromJSON(JSON.parse(Buffer.from(semente, "base64").toString("utf8"))), origem: "embutida" };
}

// --- Certificate identity --------------------------------------------------------------------

/**
 * Value of a Fulcio v2 extension: a DER UTF8String. Anything else (another tag, a length that does
 * not close the value, trailing bytes) is unreadable and counts as absent.
 */
function textoDer(valor) {
  const b = Buffer.from(valor || []);
  if (b.length < 2 || b[0] !== 0x0c) return null;
  let tamanho = b[1];
  let inicio = 2;
  if (tamanho & 0x80) {
    const bytes = tamanho & 0x7f;
    if (bytes < 1 || bytes > 2 || b.length < 2 + bytes) return null;
    tamanho = b.readUIntBE(2, bytes);
    inicio = 2 + bytes;
  }
  if (inicio + tamanho !== b.length) return null;
  return b.subarray(inicio).toString("utf8");
}

/**
 * The identity the certificate states, from the signer @sigstore/verify returned. `certificado` is
 * the leaf DER, read again with Node's own X.509 parser as a second opinion on the SAN.
 */
function identidadeDoCertificado(assinante, certificado) {
  const identidade = assinante && assinante.identity;
  if (!identidade) return null;
  const valores = {};
  const vistas = new Set();
  for (const par of identidade.oids || []) {
    const id = par && par.oid && Array.isArray(par.oid.id) ? par.oid.id.join(".") : null;
    if (!id) continue;
    // X.509 forbids repeating an extension; a certificate that does it is ambiguous.
    if (vistas.has(id)) return { duplicada: id };
    vistas.add(id);
    valores[id] = par.value;
  }
  const campos = {};
  for (const [nome, oid] of Object.entries(OID)) campos[nome] = oid in valores ? textoDer(valores[oid]) : null;

  let sanNode = null;
  try {
    sanNode = new crypto.X509Certificate(certificado).subjectAltName || null;
  } catch {}
  return {
    ...campos,
    san: identidade.subjectAlternativeName || null,
    sanNode,
    emissorDeclarado: identidade.extensions ? identidade.extensions.issuer || null : null,
  };
}

/**
 * The identity policy. Every comparison is exact: no pattern, no prefix.
 */
function conferirIdentidade(id, { versao, commit }, oficial = IDENTIDADE_OFICIAL) {
  if (!id) return recusa("a atestação não traz a identidade de quem a emitiu", "identidade");
  if (id.duplicada) return recusa(`o certificado da atestação repete a extensão ${id.duplicada}`, "identidade");

  const assinante = assinanteDaVersao(versao, oficial);
  const ref = refDaVersao(versao);
  const regras = [
    ["emissor", oficial.emissor, "não foi emitida pelo GitHub Actions"],
    ["emissorDeclarado", oficial.emissor, "não foi emitida pelo GitHub Actions"],
    ["repositorio", oficial.repositorio, "é de outro repositório"],
    ["repositorioId", oficial.repositorioId, "é de outro repositório (identificador diferente)"],
    ["dono", oficial.dono, "é de outro dono"],
    ["donoId", oficial.donoId, "é de outro dono (identificador diferente)"],
    ["san", assinante, "não foi feita pelo workflow de publicação do console para esta versão"],
    ["assinante", assinante, "não foi feita pelo workflow de publicação do console para esta versão"],
    ["configuracao", assinante, "não foi feita pelo workflow de publicação do console para esta versão"],
    ["ref", ref, "é de outra etiqueta"],
    ["gatilho", oficial.gatilho, "não veio da publicação de uma etiqueta"],
    ["executor", oficial.executor, "não foi feita num executor hospedado pelo GitHub"],
    ["ambiente", oficial.ambiente, "não foi feita no ambiente de publicação"],
    ["commit", commit, "é de outro commit"],
    ["configuracaoCommit", commit, "usou um workflow de outro commit"],
  ];
  for (const [campo, esperado, frase] of regras) {
    if (id[campo] !== esperado) {
      const obtido = id[campo] === null || id[campo] === undefined ? "ausente" : id[campo];
      return recusa(`a atestação ${frase} (${obtido}; esperado ${esperado})`, "identidade");
    }
  }
  if (id.sanNode !== `URI:${assinante}`) {
    return recusa("o certificado da atestação declara mais de um nome, ou outro nome", "identidade");
  }
  return { ok: true };
}

// --- Statement ---------------------------------------------------------------------------------

function lerDeclaracao(bundle) {
  const envelope = bundle.content && bundle.content.$case === "dsseEnvelope" ? bundle.content.dsseEnvelope : null;
  if (!envelope) return recusa("a atestação não é um envelope DSSE", "declaracao");
  if (envelope.payloadType !== TIPO_PAYLOAD) return recusa(`a atestação traz ${envelope.payloadType}, não uma declaração in-toto`, "declaracao");
  let declaracao;
  try {
    declaracao = JSON.parse(Buffer.from(envelope.payload).toString("utf8"));
  } catch {
    return recusa("a declaração da atestação não é JSON", "declaracao");
  }
  if (!declaracao || declaracao._type !== TIPO_DECLARACAO) return recusa("a atestação não traz uma declaração in-toto v1", "declaracao");
  if (declaracao.predicateType !== TIPO_PREDICADO) {
    return recusa(`a atestação é do tipo ${declaracao.predicateType}, não proveniência SLSA`, "declaracao");
  }
  if (!Array.isArray(declaracao.subject) || !declaracao.subject.length || declaracao.subject.length > MAX_SUJEITOS) {
    return recusa("a atestação não lista os arquivos que cobre", "declaracao");
  }
  const sujeitos = new Map();
  for (const s of declaracao.subject) {
    const sha = s && s.digest && s.digest.sha256;
    if (!s || typeof s.name !== "string" || !/^[0-9a-f]{64}$/.test(String(sha || ""))) {
      return recusa("a atestação lista um arquivo sem nome ou sem SHA-256", "declaracao");
    }
    // One name with two digests would make the answer depend on the order.
    if (sujeitos.has(s.name) && sujeitos.get(s.name) !== sha) return recusa(`a atestação lista ${s.name} duas vezes`, "declaracao");
    sujeitos.set(s.name, sha);
  }
  return { ok: true, declaracao, sujeitos };
}

/**
 * The predicate is signed, but its values are composed by the workflow run. It must agree with the
 * certificate; it never replaces it.
 */
function conferirPredicado(declaracao, { versao, commit }, oficial = IDENTIDADE_OFICIAL) {
  const definicao = declaracao.predicate && declaracao.predicate.buildDefinition;
  const workflow = definicao && definicao.externalParameters && definicao.externalParameters.workflow;
  const dependencias = definicao && Array.isArray(definicao.resolvedDependencies) ? definicao.resolvedDependencies : [];
  const coincide =
    workflow &&
    workflow.repository === oficial.repositorio &&
    workflow.path === oficial.workflow &&
    workflow.ref === refDaVersao(versao) &&
    dependencias.some((d) => d && d.digest && d.digest.gitCommit === commit);
  return coincide ? { ok: true } : recusa("a descrição do build na atestação não confere com o certificado", "declaracao");
}

// --- Verification ------------------------------------------------------------------------------

/**
 * Parses and cryptographically verifies a bundle. Returns the identity and the statement; the
 * policy is applied by the caller, which knows what the release claims to be.
 */
function verificarAssinatura(bytesAtestacao, raiz) {
  if (!Buffer.isBuffer(bytesAtestacao) || !bytesAtestacao.length) return recusa("a atestação está vazia", "malformada");
  if (bytesAtestacao.length > LIMITE_ATESTACAO) return recusa("a atestação é grande demais", "malformada");
  const { bundleFromJSON } = require("@sigstore/bundle");
  const { Verifier, toSignedEntity, toTrustMaterial } = require("@sigstore/verify");

  let bundle;
  try {
    bundle = bundleFromJSON(JSON.parse(bytesAtestacao.toString("utf8")));
  } catch {
    return recusa("a atestação está malformada", "malformada");
  }
  // Only a Fulcio certificate carries an identity. A bundle signed by a bare public key has none,
  // and the trusted root lists no such key anyway.
  const material = bundle.verificationMaterial && bundle.verificationMaterial.content;
  if (!material || material.$case !== "certificate") return recusa("a atestação não traz um certificado de identidade", "malformada");

  let assinante;
  try {
    const verificador = new Verifier(toTrustMaterial(raiz), { tlogThreshold: 1, ctlogThreshold: 1, timestampThreshold: 1 });
    assinante = verificador.verify(toSignedEntity(bundle));
  } catch (erro) {
    return recusa(`a atestação não confere criptograficamente (${(erro && erro.code) || "erro"})`, "criptografia");
  }
  // Only now is the envelope's content authentic enough to be read.
  const declaracao = lerDeclaracao(bundle);
  if (!declaracao.ok) return declaracao;
  return {
    ok: true,
    identidade: identidadeDoCertificado(assinante, Buffer.from(material.certificate.rawBytes)),
    declaracao: declaracao.declaracao,
    sujeitos: declaracao.sujeitos,
  };
}

/**
 * Verifies a release: manifest bytes plus attestation bundle. Returns the manifest only when the
 * whole chain holds; nothing about the release is trusted before that.
 */
function verificarPublicacao({ manifesto: bytesManifesto, atestacao: bytesAtestacao, raiz }) {
  if (!Buffer.isBuffer(bytesManifesto) || !bytesManifesto.length) return recusa("manifesto vazio", "manifesto");

  const assinatura = verificarAssinatura(bytesAtestacao, raiz);
  if (!assinatura.ok) return assinatura;

  // The manifest is trusted only as the exact bytes the workflow attested.
  const shaManifesto = crypto.createHash("sha256").update(bytesManifesto).digest("hex");
  if (assinatura.sujeitos.get(ARQUIVO_MANIFESTO) !== shaManifesto) {
    return recusa("o manifesto não é o arquivo que a atestação cobre", "sujeito");
  }
  let manifesto;
  try {
    manifesto = JSON.parse(bytesManifesto.toString("utf8"));
  } catch {
    return recusa("manifesto não é JSON válido", "manifesto");
  }
  const estrutura = release.validarEstrutura(manifesto);
  if (!estrutura.ok) return { ...estrutura, codigo: "manifesto" };

  const alegado = { versao: manifesto.versao, commit: manifesto.commit };
  const identidade = conferirIdentidade(assinatura.identidade, alegado);
  if (!identidade.ok) return identidade;
  const predicado = conferirPredicado(assinatura.declaracao, alegado);
  if (!predicado.ok) return predicado;

  // Every artifact the manifest lists is attested with the digest it declares, not only the one
  // this console will download: a manifest that describes bytes nobody attested is refused whole.
  for (const artefato of manifesto.artefatos) {
    if (assinatura.sujeitos.get(artefato.arquivo) !== artefato.sha256) {
      return recusa(`o artefato ${artefato.arquivo} não está coberto pela atestação com o digest do manifesto`, "sujeito");
    }
  }

  return {
    ok: true,
    manifesto,
    identidade: {
      assinante: assinatura.identidade.assinante,
      ref: assinatura.identidade.ref,
      commit: assinatura.identidade.commit,
      execucao: assinatura.identidade.execucao,
    },
  };
}

const modulo = {
  IDENTIDADE_OFICIAL,
  TIPO_PREDICADO,
  ARQUIVO_MANIFESTO,
  ARQUIVO_ATESTACAO,
  ESPELHO_TUF,
  TEMPO_TUF_MS,
  OID,
  refDaVersao,
  assinanteDaVersao,
  raizDeConfianca,
  textoDer,
  conferirIdentidade,
  verificarAssinatura,
  verificarPublicacao,
};
module.exports = modulo;

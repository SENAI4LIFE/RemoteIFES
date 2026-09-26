const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { initializeCA, initializeCTLog, initializeTLog } = require("@sigstore/mock");
const { TrustedRoot } = require("@sigstore/protobuf-specs");
const atestacao = require("../../src/atestacao");

// Test attestations: a private Sigstore made of @sigstore/mock parts (a Fulcio-like CA with its
// certificate transparency log, and a Rekor-like transparency log) plus the trusted root that
// names them. It issues bundles shaped exactly like the ones actions/attest-build-provenance
// produces (bundle v0.3, DSSE envelope, in-toto statement, Rekor dsse 0.0.1 entry with inclusion
// promise and proof), for any identity a test wants to claim. Only a test's trusted root knows these
// keys, so nothing issued here verifies against the real Sigstore root.

const TIPO_PAYLOAD = "application/vnd.in-toto+json";
const OFICIAL = atestacao.IDENTIDADE_OFICIAL;
const MINUTO = 60_000;

const par = () => crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const sha256 = (dados) => crypto.createHash("sha256").update(dados).digest("hex");
const pae = (tipo, corpo) => Buffer.concat([Buffer.from(`DSSEv1 ${Buffer.byteLength(tipo)} ${tipo} ${corpo.length} `), corpo]);

/**
 * The certificate extensions GitHub's OIDC token gives a workflow run, for the official
 * repository unless `identidade` says otherwise. `omitir` drops extensions by name.
 */
function extensoesDe({ versao, commit, identidade = {}, omitir = [] }) {
  const base = { ...OFICIAL, ...identidade };
  const ref = identidade.ref || atestacao.refDaVersao(versao);
  const assinante = identidade.assinante || `${base.repositorio}/${base.workflow}@${ref}`;
  const campos = {
    emissor: base.emissor,
    assinante,
    executor: base.executor,
    repositorio: base.repositorio,
    commit: identidade.commit || commit,
    ref,
    repositorioId: base.repositorioId,
    dono: base.dono,
    donoId: base.donoId,
    configuracao: identidade.configuracao || assinante,
    configuracaoCommit: identidade.configuracaoCommit || identidade.commit || commit,
    gatilho: base.gatilho,
    execucao: `${base.repositorio}/actions/runs/1/attempts/1`,
    ambiente: base.ambiente,
  };
  const extensoes = [{ oid: "1.3.6.1.4.1.57264.1.1", value: base.emissor, legacy: true }];
  for (const [nome, valor] of Object.entries(campos)) {
    if (omitir.includes(nome) || valor === null || valor === undefined) continue;
    extensoes.push({ oid: atestacao.OID[nome], value: String(valor) });
  }
  return { extensoes, san: identidade.san || assinante, ref, repositorio: base.repositorio, workflow: base.workflow };
}

function declaracaoDe({ sujeitos, ref, repositorio, workflow, commit, tipoPredicado = atestacao.TIPO_PREDICADO }) {
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: sujeitos.map((s) => ({ name: s.name, digest: { sha256: s.sha256 } })),
    predicateType: tipoPredicado,
    predicate: {
      buildDefinition: {
        buildType: "https://actions.github.io/buildtypes/workflow/v1",
        externalParameters: { workflow: { ref, repository: repositorio, path: workflow } },
        internalParameters: { github: { event_name: "push", runner_environment: "github-hosted" } },
        resolvedDependencies: [{ uri: `git+${repositorio}@${ref}`, digest: { gitCommit: commit } }],
      },
      runDetails: { builder: { id: `${repositorio}/${workflow}@${ref}` }, metadata: { invocationId: `${repositorio}/actions/runs/1/attempts/1` } },
    },
  };
}

/**
 * A private Sigstore. `relogio` is the signing time; certificates live ten minutes from it.
 */
async function criarAutoridade({ relogio = new Date(Date.now() + 2000) } = {}) {
  const chavesCt = par();
  const chavesLog = par();
  const chavesCa = par();
  const ct = await initializeCTLog(chavesCt, relogio);
  const ca = await initializeCA(chavesCa, ct, relogio);
  const log = await initializeTLog("https://rekor.sigstore.dev", chavesLog, relogio);
  const inicio = new Date(relogio.getTime() - 86_400_000).toISOString();

  const raizJson = {
    mediaType: "application/vnd.dev.sigstore.trustedroot+json;version=0.1",
    tlogs: [
      {
        baseUrl: "https://rekor.sigstore.dev",
        hashAlgorithm: "SHA2_256",
        publicKey: { rawBytes: log.publicKey.toString("base64"), keyDetails: "PKIX_ECDSA_P256_SHA_256", validFor: { start: inicio } },
        logId: { keyId: crypto.createHash("sha256").update(log.publicKey).digest("base64") },
      },
    ],
    certificateAuthorities: [
      {
        subject: { organization: "sigstore.mock", commonName: "sigstore" },
        uri: "https://fulcio.sigstore.dev",
        certChain: { certificates: [{ rawBytes: Buffer.from(ca.rootCertificate).toString("base64") }] },
        validFor: { start: inicio },
      },
    ],
    ctlogs: [
      {
        baseUrl: "https://ctfe.sigstore.dev",
        hashAlgorithm: "SHA2_256",
        publicKey: { rawBytes: ct.publicKey.toString("base64"), keyDetails: "PKIX_ECDSA_P256_SHA_256", validFor: { start: inicio } },
        logId: { keyId: Buffer.from(ct.logID).toString("base64") },
      },
    ],
    timestampAuthorities: [],
  };

  /**
   * An attestation bundle (Buffer) over `sujeitos` ([{ name, sha256 }]).
   *
   *   identidade    certificate fields to claim instead of the official ones (see extensoesDe)
   *   omitir        certificate extensions to leave out
   *   tipoPredicado another predicate type
   *   atrasoDoLogMs log the entry that long after the certificate was issued
   *   adulterar     "assinatura" (a signature over other bytes, logged as is), "promessa" (a
   *                 corrupted inclusion promise) or "payload" (the envelope changed after logging)
   */
  async function atestar({ sujeitos, versao, commit, identidade, omitir, tipoPredicado, atrasoDoLogMs = 0, adulterar = null }) {
    const assinante = par();
    const ext = extensoesDe({ versao, commit, identidade, omitir });
    const certificado = Buffer.from(
      await ca.issueCertificate({
        publicKey: assinante.publicKey.export({ format: "der", type: "spki" }),
        subjectAltName: ext.san,
        extensions: ext.extensoes,
      })
    );
    const declaracao = declaracaoDe({ sujeitos, ref: ext.ref, repositorio: ext.repositorio, workflow: ext.workflow, commit, tipoPredicado });
    const payload = Buffer.from(JSON.stringify(declaracao));
    const assinado = adulterar === "assinatura" ? Buffer.concat([payload, Buffer.from(" ")]) : payload;
    const assinatura = crypto.sign("sha256", pae(TIPO_PAYLOAD, assinado), assinante.privateKey);
    const envelope = { payload: payload.toString("base64"), payloadType: TIPO_PAYLOAD, signatures: [{ sig: assinatura.toString("base64"), keyid: "" }] };

    const pem = `-----BEGIN CERTIFICATE-----\n${certificado.toString("base64").match(/.{1,64}/g).join("\n")}\n-----END CERTIFICATE-----\n`;
    const corpo = {
      apiVersion: "0.0.1",
      kind: "dsse",
      spec: {
        envelopeHash: { algorithm: "sha256", value: sha256(JSON.stringify(envelope)) },
        payloadHash: { algorithm: "sha256", value: sha256(payload) },
        signatures: [{ signature: assinatura.toString("base64"), verifier: Buffer.from(pem).toString("base64") }],
      },
    };
    const registro = atrasoDoLogMs
      ? await initializeTLog("https://rekor.sigstore.dev", chavesLog, new Date(relogio.getTime() + atrasoDoLogMs))
      : log;
    const entrada = Object.values(await registro.log(corpo))[0];
    const prova = entrada.verification.inclusionProof;
    let promessa = entrada.verification.signedEntryTimestamp;
    if (adulterar === "promessa") {
      const bytes = Buffer.from(promessa, "base64");
      bytes[bytes.length - 3] ^= 0xff;
      promessa = bytes.toString("base64");
    }
    if (adulterar === "payload") {
      const outro = Buffer.from(JSON.stringify({ ...declaracao, subject: [...declaracao.subject, { name: "extra", digest: { sha256: "0".repeat(64) } }] }));
      envelope.payload = outro.toString("base64");
    }

    const bundle = {
      mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
      verificationMaterial: {
        certificate: { rawBytes: certificado.toString("base64") },
        tlogEntries: [
          {
            logIndex: String(entrada.logIndex),
            logId: { keyId: Buffer.from(entrada.logID, "hex").toString("base64") },
            kindVersion: { kind: "dsse", version: "0.0.1" },
            integratedTime: String(entrada.integratedTime),
            inclusionPromise: { signedEntryTimestamp: promessa },
            inclusionProof: {
              logIndex: String(prova.logIndex),
              rootHash: Buffer.from(prova.rootHash, "hex").toString("base64"),
              treeSize: String(prova.treeSize),
              hashes: prova.hashes,
              checkpoint: { envelope: prova.checkpoint },
            },
            canonicalizedBody: entrada.body,
          },
        ],
        timestampVerificationData: { rfc3161Timestamps: [] },
      },
      dsseEnvelope: envelope,
    };
    return Buffer.from(JSON.stringify(bundle));
  }

  return { raiz: TrustedRoot.fromJSON(raizJson), raizJson, atestar, relogio };
}

/**
 * What the release workflow does to a build directory: one attestation over every file in it,
 * written next to them as atestacao.sigstore.json. Returns the manifest.
 */
async function atestarDiretorio(autoridade, dir, opcoes = {}) {
  const manifesto = JSON.parse(fs.readFileSync(path.join(dir, atestacao.ARQUIVO_MANIFESTO), "utf8"));
  const sujeitos = fs
    .readdirSync(dir)
    .filter((nome) => nome !== atestacao.ARQUIVO_ATESTACAO && fs.statSync(path.join(dir, nome)).isFile())
    .sort()
    .map((nome) => ({ name: nome, sha256: sha256(fs.readFileSync(path.join(dir, nome))) }));
  const bundle = await autoridade.atestar({ sujeitos, versao: manifesto.versao, commit: manifesto.commit, ...opcoes });
  fs.writeFileSync(path.join(dir, atestacao.ARQUIVO_ATESTACAO), bundle);
  return manifesto;
}

/**
 * Makes the Console modules loaded by `mods` trust `autoridade` instead of Sigstore, in this
 * process only. Returns a function that undoes it.
 */
function confiarEm(mods, autoridade) {
  const modulo = mods.atestacao || require(path.join(__dirname, "..", "..", "src", "atestacao.js"));
  const original = modulo.raizDeConfianca;
  const chamadas = [];
  modulo.raizDeConfianca = async (opcoes = {}) => {
    chamadas.push(opcoes);
    return { raiz: autoridade.raiz, origem: "teste" };
  };
  modulo.raizDeConfianca.chamadas = chamadas;
  const desfazer = () => {
    modulo.raizDeConfianca = original;
  };
  desfazer.chamadas = chamadas;
  return desfazer;
}

module.exports = { criarAutoridade, atestarDiretorio, confiarEm, extensoesDe, sha256, OFICIAL, MINUTO };

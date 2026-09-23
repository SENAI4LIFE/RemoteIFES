const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { initializeCA, initializeCTLog, initializeTLog } = require("@sigstore/mock");
const { TrustedRoot } = require("@sigstore/protobuf-specs");
const atestacao = require("../../src/atestacao");

// Atestações de teste: um Sigstore privado feito de peças do @sigstore/mock (uma CA no estilo do
// Fulcio com o seu log de transparência de certificados, e um log de transparência no estilo do
// Rekor) mais a raiz de confiança que os nomeia. Emite pacotes com exatamente a forma dos que o
// actions/attest-build-provenance produz (bundle v0.3, envelope DSSE, declaração in-toto, entrada
// dsse 0.0.1 do Rekor com promessa e prova de inclusão), para qualquer identidade que um teste
// queira alegar. Só a raiz de confiança de um teste conhece estas chaves, então nada emitido aqui
// confere contra a raiz real do Sigstore.

const TIPO_PAYLOAD = "application/vnd.in-toto+json";
const OFICIAL = atestacao.IDENTIDADE_OFICIAL;
const MINUTO = 60_000;

const par = () => crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const sha256 = (dados) => crypto.createHash("sha256").update(dados).digest("hex");
const pae = (tipo, corpo) => Buffer.concat([Buffer.from(`DSSEv1 ${Buffer.byteLength(tipo)} ${tipo} ${corpo.length} `), corpo]);

/**
 * As extensões de certificado que o token OIDC do GitHub dá a uma execução de workflow, para o
 * repositório oficial, a menos que `identidade` diga outra coisa. `omitir` descarta extensões pelo
 * nome.
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
 * Um Sigstore privado. `relogio` é o momento da assinatura; os certificados valem dez minutos a
 * partir dele.
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
   * Um pacote de atestação (Buffer) sobre `sujeitos` ([{ name, sha256 }]).
   *
   *   identidade    campos do certificado a alegar no lugar dos oficiais (veja extensoesDe)
   *   omitir        extensões do certificado a deixar de fora
   *   tipoPredicado outro tipo de predicado
   *   atrasoDoLogMs registra a entrada esse tempo depois de o certificado ser emitido
   *   adulterar     "assinatura" (uma assinatura sobre outros bytes, registrada assim mesmo),
   *                 "promessa" (uma promessa de inclusão corrompida) ou "payload" (o envelope
   *                 alterado depois do registro)
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
 * O que a publicação de um release faz com um diretório de build: uma atestação sobre todos os
 * arquivos dele, gravada ao lado deles como atestacao.sigstore.json. Devolve o manifesto.
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
 * Faz os módulos do console carregados por `mods` confiarem em `autoridade` no lugar do Sigstore,
 * só neste processo. Devolve uma função que desfaz isso.
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

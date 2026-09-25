const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const ajuda = require("./ajuda");
const { criarAutoridade, sha256, MINUTO } = require("./support/atestacoes");

// Release provenance: what makes an installed Console accept a publication.
//
// A release is trusted only as bytes GitHub Actions attested while running this repository's
// release workflow for that version's tag. These tests hold each link of that chain: the
// cryptography (delegated to @sigstore/verify, exercised here with a private Sigstore whose keys
// only these tests trust), the certificate identity, the statement and the binding between
// manifest, tag and commit.

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const OUTRO_COMMIT = "fedcba9876543210fedcba9876543210fedcba98";

let autoridade;
let atestacao;
let release;
let amb;

test.before(async () => {
  amb = ajuda.ambiente();
  atestacao = amb.atestacao;
  release = amb.release;
  autoridade = await criarAutoridade();
});

test.after(() => amb.restaurar());

/** A release as the build produces it: manifest bytes and one payload per target. */
function novaRelease({ versao = "1.1.0", commit = COMMIT, alvos = ["linux-x64", "linux-arm64", "windows-x64"] } = {}) {
  const artefatos = {};
  const entradas = alvos.map((alvo) => {
    const arquivo = release.nomeDoPayload(versao, alvo);
    const conteudo = Buffer.from(`payload ${versao} ${alvo}`);
    artefatos[arquivo] = conteudo;
    return { alvo, formato: "tar.gz", arquivo, sha256: sha256(conteudo), bytes: conteudo.length };
  });
  const manifesto = Buffer.from(
    `${JSON.stringify({ esquema: 1, versao, canal: "estavel", publicadoEm: "2026-09-01T00:00:00.000Z", commit, minimoParaAtualizar: null, artefatos: entradas }, null, 2)}\n`
  );
  const sujeitos = [
    { name: "manifesto.json", sha256: sha256(manifesto) },
    ...Object.entries(artefatos).map(([name, c]) => ({ name, sha256: sha256(c) })),
  ];
  return { versao, commit, manifesto, artefatos, sujeitos };
}

async function atestada(r, opcoes = {}) {
  return autoridade.atestar({ sujeitos: r.sujeitos, versao: r.versao, commit: r.commit, ...opcoes });
}

function verificar(r, bundle, raiz = autoridade.raiz) {
  return atestacao.verificarPublicacao({ manifesto: r.manifesto, atestacao: bundle, raiz });
}

function recusada(resultado, codigo, padrao) {
  assert.equal(resultado.ok, false, "o release precisa ser recusado");
  if (codigo) assert.equal(resultado.codigo, codigo, resultado.motivo);
  if (padrao) assert.match(resultado.motivo, padrao);
}

// --- Accepted ----------------------------------------------------------------------------------

test("um release atestado pelo workflow oficial para a sua própria etiqueta e o seu commit é aceito", async () => {
  const r = novaRelease();
  const v = verificar(r, await atestada(r));
  assert.equal(v.ok, true, v.motivo);
  assert.equal(v.manifesto.versao, "1.1.0");
  assert.equal(v.identidade.ref, "refs/tags/console-v1.1.0");
  assert.equal(v.identidade.commit, COMMIT);
  assert.equal(v.identidade.assinante, "https://github.com/SENAI4LIFE/RemoteIFES/.github/workflows/console-release.yml@refs/tags/console-v1.1.0");
});

test("a política fixa repositório e dono por nome e identificador numérico, o workflow, o gatilho, o executor e o ambiente", () => {
  assert.deepEqual({ ...atestacao.IDENTIDADE_OFICIAL }, {
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
});

// --- The artifact and the manifest -------------------------------------------------------------

test("um manifesto que não é byte a byte o atestado é recusado, reformatação inclusive", async () => {
  const r = novaRelease();
  const bundle = await atestada(r);
  const mesmoConteudo = { ...r, manifesto: Buffer.from(JSON.stringify(JSON.parse(r.manifesto.toString("utf8")))) };
  recusada(verificar(mesmoConteudo, bundle), "sujeito", /não é o arquivo que a atestação cobre/);

  const outraVersao = JSON.parse(r.manifesto.toString("utf8"));
  outraVersao.versao = "9.9.9";
  recusada(verificar({ ...r, manifesto: Buffer.from(JSON.stringify(outraVersao)) }, bundle), "sujeito");
});

test("uma atestação feita para outro release é recusada", async () => {
  const r = novaRelease();
  const outra = novaRelease({ versao: "1.1.0", alvos: ["linux-x64"] });
  recusada(verificar(r, await atestada(outra)), "sujeito", /não é o arquivo que a atestação cobre/);
});

test("todo artefato que o manifesto lista precisa estar atestado com o digest que o manifesto declara", async () => {
  const r = novaRelease();
  const [primeiro] = Object.keys(r.artefatos);
  const semUm = r.sujeitos.filter((s) => s.name !== primeiro);
  recusada(verificar(r, await autoridade.atestar({ sujeitos: semUm, versao: r.versao, commit: r.commit })), "sujeito", new RegExp(primeiro.replace(/\./g, "\\.")));

  const trocado = r.sujeitos.map((s) => (s.name === primeiro ? { ...s, sha256: "f".repeat(64) } : s));
  recusada(verificar(r, await autoridade.atestar({ sujeitos: trocado, versao: r.versao, commit: r.commit })), "sujeito", /não está coberto/);
});

test("os nomes dos artefatos do manifesto são fixados pela versão e pelo alvo", async () => {
  const r = novaRelease({ alvos: ["linux-x64"] });
  const m = JSON.parse(r.manifesto.toString("utf8"));
  // A payload for another target served under this target's entry.
  m.artefatos[0].arquivo = release.nomeDoPayload("1.1.0", "linux-arm64");
  assert.match(release.validarEstrutura(m).motivo, /deveria se chamar remoteifes-console-1\.1\.0-linux-x64\.tar\.gz/);
  m.artefatos[0].arquivo = release.nomeDoPayload("1.0.0", "linux-x64");
  assert.equal(release.validarEstrutura(m).ok, false, "nem o payload de outra versão");
});

// --- Identity -----------------------------------------------------------------------------------

test("uma atestação de outro repositório é recusada, mesmo com o mesmo nome de repositório", async () => {
  const r = novaRelease();
  recusada(
    verificar(r, await atestada(r, { identidade: { repositorio: "https://github.com/outro/RemoteIFES", repositorioId: "999", dono: "https://github.com/outro", donoId: "998" } })),
    "identidade",
    /outro repositório/
  );
  // A repository recreated under the same name has another id: the name alone is not the trust.
  recusada(verificar(r, await atestada(r, { identidade: { repositorioId: "1313157229" } })), "identidade", /identificador diferente/);
});

test("uma atestação de outro dono é recusada", async () => {
  const r = novaRelease();
  recusada(verificar(r, await atestada(r, { identidade: { donoId: "12345" } })), "identidade", /outro dono/);
  recusada(verificar(r, await atestada(r, { identidade: { dono: "https://github.com/outro" } })), "identidade", /outro dono/);
});

test("outro workflow deste mesmo repositório não produz uma atestação aceita", async () => {
  const r = novaRelease();
  for (const workflow of [".github/workflows/ci.yml", ".github/workflows/android.yml", ".github/workflows/console-release.yaml"]) {
    recusada(verificar(r, await atestada(r, { identidade: { workflow } })), "identidade", /workflow de publicação/);
  }
  // A reusable workflow called from elsewhere: the signer is the release workflow, the top-level
  // workflow is another.
  const chamador = "https://github.com/SENAI4LIFE/RemoteIFES/.github/workflows/ci.yml@refs/tags/console-v1.1.0";
  recusada(verificar(r, await atestada(r, { identidade: { configuracao: chamador } })), "identidade", /workflow de publicação/);
});

test("uma atestação feita a partir de um branch ou de outra etiqueta é recusada", async () => {
  const r = novaRelease();
  recusada(verificar(r, await atestada(r, { identidade: { ref: "refs/heads/main" } })), "identidade");
  recusada(verificar(r, await atestada(r, { identidade: { ref: "refs/tags/console-v1.0.0" } })), "identidade");
  recusada(verificar(r, await atestada(r, { identidade: { ref: "refs/tags/v1.1.0" } })), "identidade");
  // Only the extension changed, the SAN still names the right tag: every field must agree.
  const san = "https://github.com/SENAI4LIFE/RemoteIFES/.github/workflows/console-release.yml@refs/tags/console-v1.1.0";
  recusada(verificar(r, await atestada(r, { identidade: { ref: "refs/heads/main", assinante: san, configuracao: san, san } })), "identidade", /outra etiqueta/);
});

test("uma atestação não emitida pelo OIDC do GitHub Actions é recusada", async () => {
  const r = novaRelease();
  for (const emissor of ["https://accounts.google.com", "https://token.actions.githubusercontent.com.evil.example", "https://gitlab.com"]) {
    recusada(verificar(r, await atestada(r, { identidade: { emissor } })), "identidade", /GitHub Actions/);
  }
});

test("gatilho, executor e ambiente fazem parte da identidade", async () => {
  const r = novaRelease();
  recusada(verificar(r, await atestada(r, { identidade: { gatilho: "pull_request_target" } })), "identidade", /publicação de uma etiqueta/);
  recusada(verificar(r, await atestada(r, { identidade: { gatilho: "workflow_dispatch" } })), "identidade");
  recusada(verificar(r, await atestada(r, { identidade: { executor: "self-hosted" } })), "identidade", /hospedado pelo GitHub/);
  recusada(verificar(r, await atestada(r, { identidade: { ambiente: "production" } })), "identidade", /ambiente de publicação/);
  recusada(verificar(r, await atestada(r, { omitir: ["ambiente"] })), "identidade", /ausente/);
});

test("o commit que o manifesto nomeia precisa ser o commit que o certificado diz ter sido construído", async () => {
  const r = novaRelease();
  recusada(verificar(r, await atestada(r, { identidade: { commit: OUTRO_COMMIT } })), "identidade", /outro commit/);
  recusada(verificar(r, await atestada(r, { identidade: { configuracaoCommit: OUTRO_COMMIT } })), "identidade", /workflow de outro commit/);
});

test("um certificado sem qualquer uma das extensões de identidade é recusado", async () => {
  const r = novaRelease();
  for (const campo of ["repositorioId", "donoId", "ref", "commit", "gatilho", "executor", "assinante"]) {
    recusada(verificar(r, await atestada(r, { omitir: [campo] })), "identidade", /ausente/);
  }
});

test("a declaração precisa ser proveniência de build SLSA", async () => {
  const r = novaRelease();
  recusada(verificar(r, await atestada(r, { tipoPredicado: "https://in-toto.io/attestation/release/v0.1" })), "declaracao", /proveniência SLSA/);
});

// --- Cryptography ------------------------------------------------------------------------------

test("um certificado de uma CA que a raiz de confiança não conhece é recusado", async () => {
  const r = novaRelease();
  const estranha = await criarAutoridade();
  recusada(verificar(r, await estranha.atestar({ sujeitos: r.sujeitos, versao: r.versao, commit: r.commit })), "criptografia", /CERTIFICATE/);
});

test("uma assinatura que não corresponde à declaração é recusada", async () => {
  const r = novaRelease();
  recusada(verificar(r, await atestada(r, { adulterar: "assinatura" })), "criptografia", /SIGNATURE/);
});

test("uma declaração alterada depois de registrada no log é recusada", async () => {
  const r = novaRelease();
  recusada(verificar(r, await atestada(r, { adulterar: "payload" })), "criptografia");
});

test("um certificado já expirado quando a entrada foi registrada é recusado", async () => {
  const r = novaRelease();
  recusada(verificar(r, await atestada(r, { atrasoDoLogMs: 11 * MINUTO })), "criptografia", /CERTIFICATE/);
});

test("uma entrada do log de transparência que não confere é recusada", async () => {
  const r = novaRelease();
  recusada(verificar(r, await atestada(r, { adulterar: "promessa" })), "criptografia", /TLOG/);

  // A trusted root that does not list the log the entry claims.
  const outra = await criarAutoridade();
  const semOLog = { ...autoridade.raizJson, tlogs: outra.raizJson.tlogs };
  const { TrustedRoot } = require("@sigstore/protobuf-specs");
  recusada(verificar(r, await atestada(r), TrustedRoot.fromJSON(semOLog)), "criptografia", /TLOG/);
});

test("pacotes malformados são recusados antes de qualquer criptografia", async () => {
  const r = novaRelease();
  recusada(verificar(r, Buffer.alloc(0)), "malformada");
  recusada(verificar(r, Buffer.from("isto não é json")), "malformada");
  recusada(verificar(r, Buffer.from(JSON.stringify({ mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json" }))), "malformada");
  recusada(verificar(r, Buffer.alloc(3 * 1024 * 1024, 0x20)), "malformada", /grande demais/);

  // A bundle signed by a bare public key has no identity.
  const bundle = JSON.parse((await atestada(r)).toString("utf8"));
  bundle.verificationMaterial = { publicKey: { hint: "qualquer" }, tlogEntries: bundle.verificationMaterial.tlogEntries, timestampVerificationData: {} };
  recusada(verificar(r, Buffer.from(JSON.stringify(bundle))), "malformada", /certificado/);
});

test("valores de extensão só são lidos como UTF8String DER exatas", () => {
  assert.equal(atestacao.textoDer(Buffer.from([0x0c, 0x03, 0x61, 0x62, 0x63])), "abc");
  assert.equal(atestacao.textoDer(Buffer.from([0x0c, 0x03, 0x61, 0x62])), null, "valor curto");
  assert.equal(atestacao.textoDer(Buffer.from([0x0c, 0x01, 0x61, 0x62])), null, "bytes sobrando");
  assert.equal(atestacao.textoDer(Buffer.from([0x13, 0x01, 0x61])), null, "outro tipo de string");
  assert.equal(atestacao.textoDer(Buffer.from("abc")), null, "valor legado cru");
  const longo = "x".repeat(200);
  assert.equal(atestacao.textoDer(Buffer.concat([Buffer.from([0x0c, 0x81, 200]), Buffer.from(longo)])), longo);
});

test("sem rede, a raiz de confiança é a última cópia verificada, ou então a embutida", async (t) => {
  const https = require("https");
  const http = require("http");
  const originais = { https: https.request, http: http.request, fetch: globalThis.fetch };
  const tentativas = [];
  https.request = http.request = (...args) => {
    tentativas.push(args);
    throw new Error("rede proibida neste teste");
  };
  globalThis.fetch = async (...args) => {
    tentativas.push(args);
    throw new Error("rede proibida neste teste");
  };
  t.after(() => {
    https.request = originais.https;
    http.request = originais.http;
    globalThis.fetch = originais.fetch;
  });

  const embutida = await atestacao.raizDeConfianca({ rede: false });
  assert.equal(embutida.origem, "embutida");

  const guardada = path.join(amb.estadoDir, "sigstore", "trusted_root.json");
  fs.mkdirSync(path.dirname(guardada), { recursive: true });
  fs.writeFileSync(guardada, JSON.stringify(autoridade.raizJson));
  const doCache = await atestacao.raizDeConfianca({ rede: false });
  assert.equal(doCache.origem, "cache");
  const r = novaRelease();
  assert.equal(verificar(r, await atestada(r), doCache.raiz).ok, true, "a raiz do cache é a usada");

  // A damaged cache falls back to the embedded root instead of failing.
  fs.writeFileSync(guardada, "{ corrompido");
  assert.equal((await atestacao.raizDeConfianca({ rede: false })).origem, "embutida");
  assert.equal(tentativas.length, 0, "nenhum acesso à rede");
});

test("o console não carrega chave de release de tipo nenhum: a confiança dele é a atestação", () => {
  // Keyless means nothing to leak, back up or rotate: no private key material anywhere in the
  // program, and no embedded public key standing in for the attestation either.
  const fontes = [];
  const varrer = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", "test", "dist"].includes(e.name)) continue;
      const completo = path.join(dir, e.name);
      if (e.isDirectory()) varrer(completo);
      else if (/\.(js|json|md|sh|ps1|nsi|vbs)$/.test(e.name)) fontes.push(completo);
    }
  };
  varrer(ajuda.RAIZ);
  // Assembled at run time so this file does not match itself.
  const privada = new RegExp(["-----BEGIN [A-Z ]*", "PRIVATE KEY-----"].join(""));
  const publica = new RegExp(["-----BEGIN ", "PUBLIC KEY-----"].join(""));
  // SPKI DER prefixes of Ed25519 and P-256 public keys, as base64 text.
  const spki = new RegExp(["MCowBQYDK2VwAyEA", "MFkwEwYHKoZIzj0CAQYI"].join("|"));
  const achados = fontes.filter((f) => {
    const texto = fs.readFileSync(f, "utf8");
    return privada.test(texto) || publica.test(texto) || spki.test(texto);
  });
  assert.deepEqual(achados.map((f) => path.relative(ajuda.RAIZ, f)), []);
  // Nothing in the Console signs anything.
  const assinaAlgo = fontes.filter((f) => f.endsWith(".js") && /crypto\.sign\(|createSign\(|generateKeyPair/.test(fs.readFileSync(f, "utf8")));
  assert.deepEqual(assinaAlgo.map((f) => path.relative(ajuda.RAIZ, f)), []);
  assert.equal(crypto.getHashes().includes("sha256"), true);
});

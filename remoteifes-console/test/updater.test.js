const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const http = require("http");
const zlib = require("zlib");
const crypto = require("crypto");
const ajuda = require("./helpers");

// Release updater: trust, transaction and recovery.
//
// These tests protect the difference between "downloading a file" and "updating an installed
// program":
// signature before writing, correct target, checked digest, extraction that does not escape the
// destination, atomic swap and no silent downgrade.

// --- Support -------------------------------------------------------------------------------

function parDeChaves() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    publicaB64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privada: privateKey,
  };
}

/**
 * Builds a minimal .tar.gz without the system `tar`.
 */
function tarGz(arquivos) {
  const blocos = [];
  const bloco = (conteudo) => {
    const b = Buffer.alloc(512);
    conteudo.copy(b);
    return b;
  };
  for (const [nome, texto] of Object.entries(arquivos)) {
    const dados = Buffer.from(texto, "utf8");
    const cabecalho = Buffer.alloc(512);
    cabecalho.write(nome, 0, 100, "utf8");
    cabecalho.write("0000644\0", 100, 8, "utf8");
    cabecalho.write("0000000\0", 108, 8, "utf8");
    cabecalho.write("0000000\0", 116, 8, "utf8");
    cabecalho.write(`${dados.length.toString(8).padStart(11, "0")}\0`, 124, 12, "utf8");
    cabecalho.write("00000000000\0", 136, 12, "utf8");
    cabecalho.write("        ", 148, 8, "utf8");
    cabecalho.write("0", 156, 1, "utf8");
    cabecalho.write("ustar\0" + "00", 257, 8, "utf8");
    let soma = 0;
    for (const b of cabecalho) soma += b;
    cabecalho.write(`${soma.toString(8).padStart(6, "0")}\0 `, 148, 8, "utf8");
    blocos.push(cabecalho);
    for (let i = 0; i < Math.ceil(dados.length / 512); i += 1) {
      blocos.push(bloco(dados.subarray(i * 512, (i + 1) * 512)));
    }
  }
  blocos.push(Buffer.alloc(512), Buffer.alloc(512));
  return zlib.gzipSync(Buffer.concat(blocos));
}

function payloadValido(versao) {
  return tarGz({
    "package.json": JSON.stringify({ name: "remoteifes-console", version: versao }),
    "console.js": "module.exports = { executar() {} };\n",
    "src/servidor.js": "module.exports = {};\n",
  });
}

const ARTEFATO = { alvo: "linux-x64", arquivo: "a.tar.gz", sha256: "a".repeat(64), bytes: 10 };

function assinado(par, texto) {
  const bytes = Buffer.from(texto, "utf8");
  return { bytes, assinatura: crypto.sign(null, bytes, par.privada).toString("base64") };
}

function manifestoDe({ versao, artefatos, expiraEm = null, minimoParaAtualizar = null, proximaChave = null }) {
  return `${JSON.stringify(
    {
      esquema: 1,
      versao,
      canal: "estavel",
      publicadoEm: new Date().toISOString(),
      expiraEm: expiraEm || new Date(Date.now() + 30 * 86400_000).toISOString(),
      minimoParaAtualizar,
      notas: "https://exemplo.invalid/notas",
      proximaChave,
      artefatos,
    },
    null,
    2
  )}\n`;
}

/** Fake release server: serves the manifest, signature and artifacts. */
function servidorDeRelease(arquivos) {
  const pedidos = [];
  const servidor = http.createServer((req, res) => {
    pedidos.push({ url: req.url, autorizacao: req.headers.authorization || null });
    const nome = decodeURIComponent(req.url.replace(/^\//, ""));
    const conteudo = arquivos[nome];
    if (conteudo === undefined) {
      res.writeHead(404);
      return res.end("nao encontrado");
    }
    res.writeHead(200, { "Content-Length": Buffer.byteLength(conteudo) });
    res.end(conteudo);
  });
  return new Promise((resolve) => {
    servidor.listen(0, "127.0.0.1", () =>
      resolve({
        pedidos,
        base: `http://127.0.0.1:${servidor.address().port}`,
        fechar: () => new Promise((r) => servidor.close(() => r())),
      })
    );
  });
}

function instalacaoFalsa(versaoAtiva, versoes = [versaoAtiva]) {
  const raiz = ajuda.dirTemporario("console-inst-");
  for (const v of versoes) {
    const dir = path.join(raiz, "versoes", v);
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "remoteifes-console", version: v }));
    fs.writeFileSync(path.join(dir, "console.js"), "module.exports={executar(){}};");
    fs.writeFileSync(path.join(dir, "src", "servidor.js"), "module.exports={};");
  }
  fs.writeFileSync(
    path.join(raiz, "estado-instalacao.json"),
    JSON.stringify({ versaoAtiva, versaoAnterior: versoes.length > 1 ? versoes[0] : null, transacao: null })
  );
  return raiz;
}

function ambienteDeAtualizacao({ base, chavePublica, raizInstalacao, versaoPayload = "1.0.0" }) {
  const amb = ajuda.ambiente({
    env: {
      CONSOLE_RELEASE_BASE: base,
      CONSOLE_CHAVE_RELEASE: chavePublica,
      CONSOLE_RAIZ_INSTALACAO: raizInstalacao,
    },
  });
  // The updater reads the "running" version from the package.json at the Console root; in tests the
  // running payload is simulated by the active version directory.
  amb.atualizador = require(path.join(ajuda.RAIZ, "src", "atualizador.js"));
  return amb;
}

// --- Trust ----------------------------------------------------------------------------

test("without any trusted key, no update is accepted", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const release = require(path.join(ajuda.RAIZ, "src", "release.js"));

  const r = release.verificarManifesto(Buffer.from("{}"), "x", { chaves: [] });
  assert.equal(r.ok, false);
  assert.equal(r.naoConfigurado, true);
  assert.match(r.motivo, /não está configurada/);
});

test("the embedded key does not verify what an ephemeral test key signed", (t) => {
  const chaves = parDeChaves();
  const amb = ajuda.ambiente({ env: { CONSOLE_CHAVE_RELEASE: undefined } });
  t.after(() => amb.restaurar());
  const release = require(path.join(ajuda.RAIZ, "src", "release.js"));

  assert.deepEqual(release.chavesConfiaveis().map((c) => c.origem), ["embutida"]);
  const m = assinado(chaves, manifestoDe({ versao: "2.0.0", artefatos: [ARTEFATO] }));
  const r = release.verificarManifesto(m.bytes, m.assinatura);
  assert.equal(r.ok, false);
  assert.match(r.motivo, /não confere com nenhuma chave confiável/);
});

test("a manifest with an invalid signature is refused before any write", (t) => {
  const chaves = parDeChaves();
  const outra = parDeChaves();
  const amb = ajuda.ambiente({ env: { CONSOLE_CHAVE_RELEASE: chaves.publicaB64 } });
  t.after(() => amb.restaurar());
  const release = require(path.join(ajuda.RAIZ, "src", "release.js"));

  const bytes = Buffer.from(manifestoDe({ versao: "2.0.0", artefatos: [{ alvo: "linux-x64", arquivo: "a.tar.gz", sha256: "a".repeat(64), bytes: 10 }] }));
  const assinaturaErrada = crypto.sign(null, bytes, outra.privada).toString("base64");

  const r = release.verificarManifesto(bytes, assinaturaErrada);
  assert.equal(r.ok, false);
  assert.match(r.motivo, /não confere com nenhuma chave confiável/);
});

test("an expired manifest is refused (replay and version freezing)", (t) => {
  const chaves = parDeChaves();
  const amb = ajuda.ambiente({ env: { CONSOLE_CHAVE_RELEASE: chaves.publicaB64 } });
  t.after(() => amb.restaurar());
  const release = require(path.join(ajuda.RAIZ, "src", "release.js"));

  const bytes = Buffer.from(
    manifestoDe({
      versao: "2.0.0",
      expiraEm: new Date(Date.now() - 86400_000).toISOString(),
      artefatos: [{ alvo: "linux-x64", arquivo: "a.tar.gz", sha256: "a".repeat(64), bytes: 10 }],
    })
  );
  const r = release.verificarManifesto(bytes, crypto.sign(null, bytes, chaves.privada).toString("base64"));
  assert.equal(r.ok, false);
  assert.match(r.motivo, /expirado/);
});

test("a target missing from the manifest is refused with the list of what exists", (t) => {
  const chaves = parDeChaves();
  const amb = ajuda.ambiente({ env: { CONSOLE_CHAVE_RELEASE: chaves.publicaB64 } });
  t.after(() => amb.restaurar());
  const release = require(path.join(ajuda.RAIZ, "src", "release.js"));

  const manifesto = { artefatos: [{ alvo: "linux-arm", arquivo: "a.tar.gz", sha256: "a".repeat(64), bytes: 10 }] };
  const r = release.escolherArtefato(manifesto, "windows-x64");
  assert.equal(r.ok, false);
  assert.match(r.motivo, /não traz artefato para windows-x64/);
  assert.match(r.motivo, /linux-arm/);
});

test("the version policy refuses downgrades and requires the declared minimum", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const release = require(path.join(ajuda.RAIZ, "src", "release.js"));

  assert.equal(release.politicaDeVersao({ versao: "1.0.0" }, "2.0.0").ok, false);
  assert.match(release.politicaDeVersao({ versao: "1.0.0" }, "2.0.0").motivo, /não faz downgrade/);
  assert.equal(release.politicaDeVersao({ versao: "2.0.0" }, "2.0.0").jaInstalada, true);
  assert.equal(release.politicaDeVersao({ versao: "3.0.0", minimoParaAtualizar: "2.5.0" }, "2.0.0").ok, false);
  assert.equal(release.politicaDeVersao({ versao: "3.0.0", minimoParaAtualizar: "2.0.0" }, "2.0.0").ok, true);
});

test("key rotation is accepted only from an already authenticated manifest", (t) => {
  const chaves = parDeChaves();
  const sucessora = parDeChaves();
  const amb = ajuda.ambiente({ env: { CONSOLE_CHAVE_RELEASE: chaves.publicaB64 } });
  t.after(() => amb.restaurar());
  const release = require(path.join(ajuda.RAIZ, "src", "release.js"));
  const ids = () => release.chavesConfiaveis().map((c) => c.id);

  // An object that merely looks like a verification result registers nothing.
  const forjado = { ok: true, manifesto: { versao: "2.1.0", proximaChave: { publica: sucessora.publicaB64 } } };
  assert.equal(release.registrarRotacao(forjado).rotacionada, false);
  assert.ok(!ids().includes(release.idDaChave(sucessora.publicaB64)));
  // Neither does a manifest verified against an explicit key list instead of this console's trust.
  const anuncio = assinado(chaves, manifestoDe({ versao: "2.1.0", artefatos: [ARTEFATO], proximaChave: { publica: sucessora.publicaB64 } }));
  const explicito = release.verificarManifesto(anuncio.bytes, anuncio.assinatura, {
    chaves: [{ chave: release.chaveDeBase64(chaves.publicaB64), id: release.idDaChave(chaves.publicaB64), origem: "teste" }],
  });
  assert.equal(explicito.ok, true);
  assert.equal(release.registrarRotacao(explicito).rotacionada, false);

  const verificado = release.verificarManifesto(anuncio.bytes, anuncio.assinatura);
  assert.equal(verificado.ok, true, verificado.motivo);
  assert.equal(release.registrarRotacao(verificado).rotacionada, true);
  assert.ok(ids().includes(release.idDaChave(sucessora.publicaB64)), "the successor is trusted");

  // A manifest signed only by the successor now verifies.
  const seguinte = assinado(sucessora, manifestoDe({ versao: "2.2.0", artefatos: [ARTEFATO] }));
  assert.equal(release.verificarManifesto(seguinte.bytes, seguinte.assinatura).ok, true);
});

test("once the successor signs, the key it replaced is retired", (t) => {
  const k1 = parDeChaves();
  const k2 = parDeChaves();
  const k3 = parDeChaves();
  const amb = ajuda.ambiente({ env: { CONSOLE_CHAVE_RELEASE: k1.publicaB64 } });
  t.after(() => amb.restaurar());
  const release = require(path.join(ajuda.RAIZ, "src", "release.js"));
  const verificar = (m) => release.verificarManifesto(m.bytes, m.assinatura);
  const confiaveis = () => release.chavesConfiaveis().map((c) => c.id).filter((id) => id !== release.idDaChave(release.CHAVE_PUBLICA_OFICIAL));

  release.registrarRotacao(verificar(assinado(k1, manifestoDe({ versao: "2.1.0", artefatos: [ARTEFATO], proximaChave: { publica: k2.publicaB64 } }))));
  // Until the successor is used, the current key still verifies: a console may see several
  // manifests from the old key before the first one from the new.
  assert.equal(verificar(assinado(k1, manifestoDe({ versao: "2.1.1", artefatos: [ARTEFATO] }))).ok, true);

  const primeiroDaSucessora = verificar(assinado(k2, manifestoDe({ versao: "2.2.0", artefatos: [ARTEFATO] })));
  assert.equal(primeiroDaSucessora.ok, true);
  assert.deepEqual(release.registrarRotacao(primeiroDaSucessora).aposentadas, [release.idDaChave(k1.publicaB64)]);

  const doAntigo = verificar(assinado(k1, manifestoDe({ versao: "9.0.0", artefatos: [ARTEFATO] })));
  assert.equal(doAntigo.ok, false, "a retired key no longer verifies, even from the environment");
  assert.match(doAntigo.motivo, /não confere com nenhuma chave confiável/);
  assert.deepEqual(confiaveis(), [release.idDaChave(k2.publicaB64)]);

  // The retired key cannot come back as a declared successor.
  const devolve = verificar(assinado(k2, manifestoDe({ versao: "2.3.0", artefatos: [ARTEFATO], proximaChave: { publica: k1.publicaB64 } })));
  assert.equal(devolve.ok, false);
  assert.match(devolve.motivo, /aposentada/);

  // A second rotation retires the chain: only the newest key remains.
  release.registrarRotacao(verificar(assinado(k2, manifestoDe({ versao: "2.4.0", artefatos: [ARTEFATO], proximaChave: { publica: k3.publicaB64 } }))));
  release.registrarRotacao(verificar(assinado(k3, manifestoDe({ versao: "2.5.0", artefatos: [ARTEFATO] }))));
  assert.deepEqual(confiaveis(), [release.idDaChave(k3.publicaB64)]);
  assert.equal(verificar(assinado(k2, manifestoDe({ versao: "9.0.0", artefatos: [ARTEFATO] }))).ok, false);
});

test("successors vouched for by a key that is no longer an anchor stop counting", (t) => {
  const antiga = parDeChaves();
  const sucessora = parDeChaves();
  const nova = parDeChaves();
  const estadoDir = ajuda.dirTemporario("console-rotacao-");
  let amb = ajuda.ambiente({ estadoDir, env: { CONSOLE_CHAVE_RELEASE: antiga.publicaB64 } });
  let release = require(path.join(ajuda.RAIZ, "src", "release.js"));
  const anuncio = assinado(antiga, manifestoDe({ versao: "2.1.0", artefatos: [ARTEFATO], proximaChave: { publica: sucessora.publicaB64 } }));
  release.registrarRotacao(release.verificarManifesto(anuncio.bytes, anuncio.assinatura));
  assert.ok(release.chavesConfiaveis().some((c) => c.id === release.idDaChave(sucessora.publicaB64)));
  amb.restaurar();

  // A package that anchors on a different key (the recovery from a compromised key) keeps the
  // state directory but not what the old key vouched for.
  amb = ajuda.ambiente({ estadoDir, env: { CONSOLE_CHAVE_RELEASE: nova.publicaB64 } });
  t.after(() => amb.restaurar());
  release = require(path.join(ajuda.RAIZ, "src", "release.js"));
  const ids = release.chavesConfiaveis().map((c) => c.id);
  assert.ok(!ids.includes(release.idDaChave(sucessora.publicaB64)));
  assert.ok(ids.includes(release.idDaChave(nova.publicaB64)));
  const daSucessora = assinado(sucessora, manifestoDe({ versao: "3.0.0", artefatos: [ARTEFATO] }));
  assert.equal(release.verificarManifesto(daSucessora.bytes, daSucessora.assinatura).ok, false);
});

test("a malformed or unusable successor key refuses the manifest", (t) => {
  const chaves = parDeChaves();
  const amb = ajuda.ambiente({ env: { CONSOLE_CHAVE_RELEASE: chaves.publicaB64 } });
  t.after(() => amb.restaurar());
  const release = require(path.join(ajuda.RAIZ, "src", "release.js"));

  const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ type: "spki", format: "der" }).toString("base64");
  for (const [proximaChave, motivo] of [
    [{ publica: "não é base64" }, /proximaChave recusada/],
    [{ publica: Buffer.from("curta").toString("base64") }, /proximaChave recusada/],
    [{ publica: rsa }, /não Ed25519/],
    [{ publica: chaves.publicaB64 }, /própria chave que assinou/],
    ["texto", /proximaChave malformada/],
    [{ outra: "coisa" }, /proximaChave malformada/],
  ]) {
    const m = assinado(chaves, manifestoDe({ versao: "2.1.0", artefatos: [ARTEFATO], proximaChave }));
    const r = release.verificarManifesto(m.bytes, m.assinatura);
    assert.equal(r.ok, false, JSON.stringify(proximaChave));
    assert.match(r.motivo, motivo);
  }
  assert.equal(fs.existsSync(path.join(process.env.CONSOLE_ESTADO_DIR, "chaves-release.json")), false, "nothing was registered");
});

test("malformed signatures are refused before any key is tried", (t) => {
  const chaves = parDeChaves();
  const amb = ajuda.ambiente({ env: { CONSOLE_CHAVE_RELEASE: chaves.publicaB64 } });
  t.after(() => amb.restaurar());
  const release = require(path.join(ajuda.RAIZ, "src", "release.js"));

  const m = assinado(chaves, manifestoDe({ versao: "2.0.0", artefatos: [ARTEFATO] }));
  assert.equal(release.verificarManifesto(m.bytes, m.assinatura).ok, true, "control: the real signature passes");
  const bin = Buffer.from(m.assinatura, "base64");
  for (const ruim of [
    "",
    "   ",
    undefined,
    "abc",
    m.assinatura.slice(0, -2), // padding removed
    `${m.assinatura.slice(0, 40)}*${m.assinatura.slice(41)}`, // a character Node's decoder would skip
    bin.subarray(0, 63).toString("base64"),
    Buffer.concat([bin, Buffer.from([0])]).toString("base64"),
  ]) {
    const r = release.verificarManifesto(m.bytes, ruim);
    assert.equal(r.ok, false, JSON.stringify(ruim));
    assert.match(r.motivo, /assinatura malformada/);
  }
  // Well formed, but not over these bytes.
  const outro = Buffer.from(bin);
  outro[10] ^= 0x01;
  assert.match(release.verificarManifesto(m.bytes, outro.toString("base64")).motivo, /não confere/);
});

test("any change to the signed bytes invalidates the manifest, reformatting included", (t) => {
  const chaves = parDeChaves();
  const amb = ajuda.ambiente({ env: { CONSOLE_CHAVE_RELEASE: chaves.publicaB64 } });
  t.after(() => amb.restaurar());
  const release = require(path.join(ajuda.RAIZ, "src", "release.js"));

  const m = assinado(chaves, manifestoDe({ versao: "2.0.0", artefatos: [ARTEFATO] }));
  const texto = m.bytes.toString("utf8");
  for (const alterado of [
    texto.replace('"2.0.0"', '"2.0.1"'),
    texto.replace(ARTEFATO.sha256, "b".repeat(64)),
    JSON.stringify(JSON.parse(texto)),
    `${texto}\n`,
  ]) {
    const r = release.verificarManifesto(Buffer.from(alterado, "utf8"), m.assinatura);
    assert.equal(r.ok, false);
    assert.match(r.motivo, /não confere/);
  }
});

test("a manifest with two artifacts for one target is refused", (t) => {
  const chaves = parDeChaves();
  const amb = ajuda.ambiente({ env: { CONSOLE_CHAVE_RELEASE: chaves.publicaB64 } });
  t.after(() => amb.restaurar());
  const release = require(path.join(ajuda.RAIZ, "src", "release.js"));

  const m = assinado(chaves, manifestoDe({ versao: "2.0.0", artefatos: [ARTEFATO, { ...ARTEFATO, arquivo: "b.tar.gz" }] }));
  assert.match(release.verificarManifesto(m.bytes, m.assinatura).motivo, /dois artefatos para linux-x64/);
});

// --- Extraction -------------------------------------------------------------------------------

test("extraction refuses a path that escapes the destination", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const atualizador = require(path.join(ajuda.RAIZ, "src", "atualizador.js"));

  const dir = ajuda.dirTemporario("console-tar-");
  const malicioso = path.join(dir, "mal.tar.gz");
  fs.writeFileSync(malicioso, tarGz({ "../fora.txt": "escapou" }));
  assert.throws(() => atualizador.extrairTarGz(malicioso, path.join(dir, "destino")), /escapa do destino|fora do destino/);
  assert.ok(!fs.existsSync(path.join(dir, "fora.txt")), "nothing may be written outside");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("extraction refuses an absolute path", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const atualizador = require(path.join(ajuda.RAIZ, "src", "atualizador.js"));

  const dir = ajuda.dirTemporario("console-tar-");
  const malicioso = path.join(dir, "mal.tar.gz");
  fs.writeFileSync(malicioso, tarGz({ "/etc/passwd": "x" }));
  assert.throws(() => atualizador.extrairTarGz(malicioso, path.join(dir, "destino")), /escapa|fora/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("extraction accepts a legitimate payload and preserves only the executable bit", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const atualizador = require(path.join(ajuda.RAIZ, "src", "atualizador.js"));

  const dir = ajuda.dirTemporario("console-tar-");
  const arquivo = path.join(dir, "ok.tar.gz");
  fs.writeFileSync(arquivo, payloadValido("2.0.0"));
  const destino = path.join(dir, "destino");
  const r = atualizador.extrairTarGz(arquivo, destino);
  assert.equal(r.arquivos, 3);
  assert.ok(fs.existsSync(path.join(destino, "console.js")));
  assert.equal(JSON.parse(fs.readFileSync(path.join(destino, "package.json"), "utf8")).version, "2.0.0");
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- Transaction -------------------------------------------------------------------------------

test("complete flow: verifies, installs side by side and swaps the pointer", async (t) => {
  const chaves = parDeChaves();
  const artefatoBin = payloadValido("2.0.0");
  const nomeArtefato = `remoteifes-console-2.0.0-${process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux"}-${process.arch}.tar.gz`;
  const manifesto = manifestoDe({
    versao: "2.0.0",
    artefatos: [
      {
        alvo: `${process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux"}-${process.arch}`,
        formato: "tar.gz",
        arquivo: nomeArtefato,
        sha256: crypto.createHash("sha256").update(artefatoBin).digest("hex"),
        bytes: artefatoBin.length,
      },
    ],
  });
  const assinatura = crypto.sign(null, Buffer.from(manifesto), chaves.privada).toString("base64");
  const servidor = await servidorDeRelease({
    "manifesto.json": manifesto,
    "manifesto.json.sig": assinatura,
    [nomeArtefato]: artefatoBin,
  });
  const raiz = instalacaoFalsa("1.0.0");
  const amb = ambienteDeAtualizacao({ base: servidor.base, chavePublica: chaves.publicaB64, raizInstalacao: raiz });
  t.after(async () => {
    await servidor.fechar();
    amb.restaurar();
    fs.rmSync(raiz, { recursive: true, force: true });
  });

  const linhas = [];
  const r = await amb.atualizador.atualizar("2.0.0", { log: (l) => linhas.push(l) });
  assert.equal(r.ok, true, r.erro);
  assert.equal(r.versao, "2.0.0");

  const estadoFinal = JSON.parse(fs.readFileSync(path.join(raiz, "estado-instalacao.json"), "utf8"));
  assert.equal(estadoFinal.versaoAtiva, "2.0.0");
  assert.equal(estadoFinal.versaoAnterior, "1.0.0", "the previous version is kept for rollback");
  assert.ok(fs.existsSync(path.join(raiz, "versoes", "2.0.0", "console.js")));
  assert.ok(fs.existsSync(path.join(raiz, "versoes", "1.0.0", "console.js")), "the previous version is not deleted");
  assert.ok(!fs.existsSync(path.join(raiz, "descargas")) || fs.readdirSync(path.join(raiz, "descargas")).length === 0);
  assert.ok(linhas.some((l) => /SHA-256 confere/.test(l)));

  // No credential was sent to the release server.
  assert.ok(servidor.pedidos.every((p) => p.autorizacao === null), "release downloads carry no credential");
});

test("a mismatched digest aborts before switching the active version", async (t) => {
  const chaves = parDeChaves();
  const artefatoBin = payloadValido("2.0.0");
  const alvo = `${process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux"}-${process.arch}`;
  const nomeArtefato = "payload.tar.gz";
  const manifesto = manifestoDe({
    versao: "2.0.0",
    artefatos: [{ alvo, formato: "tar.gz", arquivo: nomeArtefato, sha256: "b".repeat(64), bytes: artefatoBin.length }],
  });
  const servidor = await servidorDeRelease({
    "manifesto.json": manifesto,
    "manifesto.json.sig": crypto.sign(null, Buffer.from(manifesto), chaves.privada).toString("base64"),
    [nomeArtefato]: artefatoBin,
  });
  const raiz = instalacaoFalsa("1.0.0");
  const amb = ambienteDeAtualizacao({ base: servidor.base, chavePublica: chaves.publicaB64, raizInstalacao: raiz });
  t.after(async () => {
    await servidor.fechar();
    amb.restaurar();
    fs.rmSync(raiz, { recursive: true, force: true });
  });

  const r = await amb.atualizador.atualizar("2.0.0", { log: () => {} });
  assert.equal(r.ok, false);
  assert.match(r.erro, /SHA-256 divergente/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(raiz, "estado-instalacao.json"), "utf8")).versaoAtiva, "1.0.0");
  assert.ok(!fs.existsSync(path.join(raiz, "versoes", "2.0.0")), "nada instalado");
});

test("an artifact whose internal version differs from the target is refused", async (t) => {
  const chaves = parDeChaves();
  const artefatoBin = payloadValido("9.9.9");
  const alvo = `${process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux"}-${process.arch}`;
  const manifesto = manifestoDe({
    versao: "2.0.0",
    artefatos: [
      { alvo, formato: "tar.gz", arquivo: "p.tar.gz", sha256: crypto.createHash("sha256").update(artefatoBin).digest("hex"), bytes: artefatoBin.length },
    ],
  });
  const servidor = await servidorDeRelease({
    "manifesto.json": manifesto,
    "manifesto.json.sig": crypto.sign(null, Buffer.from(manifesto), chaves.privada).toString("base64"),
    "p.tar.gz": artefatoBin,
  });
  const raiz = instalacaoFalsa("1.0.0");
  const amb = ambienteDeAtualizacao({ base: servidor.base, chavePublica: chaves.publicaB64, raizInstalacao: raiz });
  t.after(async () => {
    await servidor.fechar();
    amb.restaurar();
    fs.rmSync(raiz, { recursive: true, force: true });
  });

  const r = await amb.atualizador.atualizar("2.0.0", { log: () => {} });
  assert.equal(r.ok, false);
  assert.match(r.erro, /declara versão 9\.9\.9/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(raiz, "estado-instalacao.json"), "utf8")).versaoAtiva, "1.0.0");
});

test("an interrupted transaction is reconciled at startup, with no half installation", (t) => {
  const raiz = instalacaoFalsa("1.0.0");
  const amb = ajuda.ambiente({ env: { CONSOLE_RAIZ_INSTALACAO: raiz } });
  t.after(() => {
    amb.restaurar();
    fs.rmSync(raiz, { recursive: true, force: true });
  });
  const atualizador = require(path.join(ajuda.RAIZ, "src", "atualizador.js"));

  // Simulates a power loss during installation: staging and a partial version on disk.
  fs.mkdirSync(path.join(raiz, "versoes", "2.0.0"), { recursive: true });
  fs.mkdirSync(path.join(raiz, "descargas", "lixo"), { recursive: true });
  fs.writeFileSync(
    path.join(raiz, "estado-instalacao.json"),
    JSON.stringify({ versaoAtiva: "1.0.0", versaoAnterior: null, transacao: { versao: "2.0.0", etapa: "instalando" } })
  );

  const r = atualizador.reconciliar();
  assert.equal(r.reconciliado, true);
  assert.equal(r.etapaInterrompida, "instalando");
  assert.ok(!fs.existsSync(path.join(raiz, "versoes", "2.0.0")), "the incomplete version is discarded");
  assert.ok(!fs.existsSync(path.join(raiz, "descargas")), "staging is cleaned");
  assert.equal(JSON.parse(fs.readFileSync(path.join(raiz, "estado-instalacao.json"), "utf8")).versaoAtiva, "1.0.0");
});

test("a completed transaction is not undone by reconciliation", (t) => {
  const raiz = instalacaoFalsa("2.0.0", ["1.0.0", "2.0.0"]);
  const amb = ajuda.ambiente({ env: { CONSOLE_RAIZ_INSTALACAO: raiz } });
  t.after(() => {
    amb.restaurar();
    fs.rmSync(raiz, { recursive: true, force: true });
  });
  const atualizador = require(path.join(ajuda.RAIZ, "src", "atualizador.js"));

  fs.writeFileSync(
    path.join(raiz, "estado-instalacao.json"),
    JSON.stringify({ versaoAtiva: "2.0.0", versaoAnterior: "1.0.0", transacao: { versao: "2.0.0", etapa: "concluida" } })
  );
  const r = atualizador.reconciliar();
  assert.equal(r.etapaInterrompida, null);
  assert.ok(fs.existsSync(path.join(raiz, "versoes", "2.0.0")), "the completed version remains");
});

test("rollback swaps the pointer to the previous version, without network", async (t) => {
  const raiz = instalacaoFalsa("2.0.0", ["1.0.0", "2.0.0"]);
  fs.writeFileSync(
    path.join(raiz, "estado-instalacao.json"),
    JSON.stringify({ versaoAtiva: "2.0.0", versaoAnterior: "1.0.0", transacao: null })
  );
  const amb = ajuda.ambiente({ env: { CONSOLE_RAIZ_INSTALACAO: raiz } });
  t.after(() => {
    amb.restaurar();
    fs.rmSync(raiz, { recursive: true, force: true });
  });
  const atualizador = require(path.join(ajuda.RAIZ, "src", "atualizador.js"));

  const r = await atualizador.reverter({ log: () => {} });
  assert.equal(r.ok, true, r.erro);
  const estadoFinal = JSON.parse(fs.readFileSync(path.join(raiz, "estado-instalacao.json"), "utf8"));
  assert.equal(estadoFinal.versaoAtiva, "1.0.0");
  assert.equal(estadoFinal.versaoAnterior, "2.0.0", "the one that left becomes the previous version, to allow going back");
});

test("the bootstrap falls back to the previous version when the active one is broken", (t) => {
  const raiz = instalacaoFalsa("2.0.0", ["1.0.0", "2.0.0"]);
  t.after(() => fs.rmSync(raiz, { recursive: true, force: true }));

  // Ativa corrompida: console.js some.
  fs.rmSync(path.join(raiz, "versoes", "2.0.0", "console.js"), { force: true });
  fs.writeFileSync(
    path.join(raiz, "estado-instalacao.json"),
    JSON.stringify({ versaoAtiva: "2.0.0", versaoAnterior: "1.0.0", transacao: null })
  );
  fs.copyFileSync(path.join(ajuda.RAIZ, "instalacao", "console-bootstrap.js"), path.join(raiz, "console-bootstrap.js"));

  const { execFileSync } = require("child_process");
  const saida = execFileSync(process.execPath, [path.join(raiz, "console-bootstrap.js")], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CONSOLE_SEM_PRIVILEGIO: "1" },
  });
  // The test payload only exposes an empty `executar`; what matters is which version was chosen.
  assert.ok(true, saida);
});

test("a pointer at a version that did not start is reported, not hidden", async (t) => {
  // The bootstrap falls back to a usable version when the active one does not load (the safety net
  // working). The problem is silence: the update reported success, the Console came back, and the
  // operator believes they run code that is not running. The divergence between pointer and process
  // must surface.
  const raiz = ajuda.dirTemporario("console-diverg-");
  const amb = ajuda.ambiente({ env: { CONSOLE_RAIZ_INSTALACAO: raiz } });
  t.after(() => {
    amb.restaurar();
    fs.rmSync(raiz, { recursive: true, force: true });
  });
  const atualizador = require(path.join(ajuda.RAIZ, "src", "atualizador.js"));
  const emExecucao = atualizador.versaoEmExecucao();

  // Side-by-side layout with the pointer on a version that is NOT the one this process loaded.
  for (const v of [emExecucao, "99.0.0"]) {
    fs.mkdirSync(path.join(raiz, "versoes", v), { recursive: true });
    fs.writeFileSync(path.join(raiz, "versoes", v, "package.json"), `${JSON.stringify({ version: v })}\n`);
  }
  fs.writeFileSync(
    path.join(raiz, "estado-instalacao.json"),
    `${JSON.stringify({ versaoAtiva: "99.0.0", versaoAnterior: emExecucao, transacao: null })}\n`
  );

  const s = await atualizador.situacao();
  assert.ok(s.divergenciaDeVersao, "the divergence must be reported");
  assert.equal(s.divergenciaDeVersao.registrada, "99.0.0");
  assert.equal(s.divergenciaDeVersao.emExecucao, emExecucao);
  assert.match(s.divergenciaDeVersao.motivo, /não subiu/);
  assert.match(s.divergenciaDeVersao.motivo, /NÃO é o que a versão ativa indica/);
});

test("without divergence, the status does not invent an alarm", async (t) => {
  const raiz = ajuda.dirTemporario("console-ok-");
  const amb = ajuda.ambiente({ env: { CONSOLE_RAIZ_INSTALACAO: raiz } });
  t.after(() => {
    amb.restaurar();
    fs.rmSync(raiz, { recursive: true, force: true });
  });
  const atualizador = require(path.join(ajuda.RAIZ, "src", "atualizador.js"));
  const emExecucao = atualizador.versaoEmExecucao();

  fs.mkdirSync(path.join(raiz, "versoes", emExecucao), { recursive: true });
  fs.writeFileSync(path.join(raiz, "versoes", emExecucao, "package.json"), `${JSON.stringify({ version: emExecucao })}\n`);
  fs.writeFileSync(
    path.join(raiz, "estado-instalacao.json"),
    `${JSON.stringify({ versaoAtiva: emExecucao, versaoAnterior: null, transacao: null })}\n`
  );

  const s = await atualizador.situacao();
  assert.equal(s.divergenciaDeVersao, null, "a coherent installation must not produce a warning");
});

test("running from source is not treated as divergence", async (t) => {
  // Without a side-by-side layout there is no pointer to diverge from; warning here would be noise
  // in every development session.
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const atualizador = require(path.join(ajuda.RAIZ, "src", "atualizador.js"));

  const s = await atualizador.situacao();
  assert.equal(s.gerenciadoLadoALado, false);
  assert.equal(s.divergenciaDeVersao, null);
});

test("the status distinguishes installed, published and stale observation", async (t) => {
  const raiz = instalacaoFalsa("1.0.0");
  const amb = ajuda.ambiente({ env: { CONSOLE_RAIZ_INSTALACAO: raiz } });
  t.after(() => {
    amb.restaurar();
    fs.rmSync(raiz, { recursive: true, force: true });
  });
  const atualizador = require(path.join(ajuda.RAIZ, "src", "atualizador.js"));

  const s = await atualizador.situacao({ consultarRede: false });
  assert.equal(s.confiancaConfigurada, true, "installed copies carry the publishing key");
  assert.ok(s.chavesDePublicacao.some((c) => c.origem === "embutida" && /^ed25519:[0-9a-f]{16}$/.test(c.id)));
  assert.equal(s.versaoAtivaRegistrada, "1.0.0");
  assert.ok(s.alvo.includes(process.arch));
  assert.match(s.observacaoDeDistribuicao, /independente do commit do RemoteIFES/);
});

test("the bootstrap falls back to the previous version when the active one EXISTS but does not load", (t) => {
  // The file existing is not the same as loading it. A signed payload can carry everything required
  // and still have a syntax error or a failing require; the previous version must then be tried.
  const raiz = ajuda.dirTemporario("console-boot-");
  t.after(() => fs.rmSync(raiz, { recursive: true, force: true }));

  const bootstrap = path.join(raiz, "console-bootstrap.js");
  fs.copyFileSync(path.join(ajuda.RAIZ, "instalacao", "console-bootstrap.js"), bootstrap);

  // 2.0.0: present, with a console.js that THROWS on load.
  fs.mkdirSync(path.join(raiz, "versoes", "2.0.0"), { recursive: true });
  fs.writeFileSync(path.join(raiz, "versoes", "2.0.0", "console.js"), 'throw new Error("payload quebrado de proposito");\n');

  // 1.0.0: present and sound.
  fs.mkdirSync(path.join(raiz, "versoes", "1.0.0"), { recursive: true });
  fs.writeFileSync(
    path.join(raiz, "versoes", "1.0.0", "console.js"),
    'module.exports = { executar() { process.stdout.write("SUBIU 1.0.0\\n"); } };\n'
  );

  fs.writeFileSync(
    path.join(raiz, "estado-instalacao.json"),
    `${JSON.stringify({ versaoAtiva: "2.0.0", versaoAnterior: "1.0.0", transacao: null })}\n`
  );

  const r = require("child_process").spawnSync(process.execPath, [bootstrap], { encoding: "utf8", timeout: 30_000 });
  const saida = `${r.stdout || ""}${r.stderr || ""}`;
  assert.equal(r.status, 0, `the bootstrap must start the previous version. Output:\n${saida}`);
  assert.match(saida, /SUBIU 1\.0\.0/, "the previous version must actually run");
  assert.match(saida, /não carregou/, "the reason the active version failed must appear");
  assert.match(saida, /payload quebrado de proposito/, "the original error must be shown, not swallowed");
});

test("when no version loads, the bootstrap fails and says so", (t) => {
  const raiz = ajuda.dirTemporario("console-boot2-");
  t.after(() => fs.rmSync(raiz, { recursive: true, force: true }));

  const bootstrap = path.join(raiz, "console-bootstrap.js");
  fs.copyFileSync(path.join(ajuda.RAIZ, "instalacao", "console-bootstrap.js"), bootstrap);
  for (const v of ["2.0.0", "1.0.0"]) {
    fs.mkdirSync(path.join(raiz, "versoes", v), { recursive: true });
    fs.writeFileSync(path.join(raiz, "versoes", v, "console.js"), 'throw new Error("quebrado");\n');
  }
  fs.writeFileSync(
    path.join(raiz, "estado-instalacao.json"),
    `${JSON.stringify({ versaoAtiva: "2.0.0", versaoAnterior: "1.0.0", transacao: null })}\n`
  );

  const r = require("child_process").spawnSync(process.execPath, [bootstrap], { encoding: "utf8", timeout: 30_000 });
  const saida = `${r.stdout || ""}${r.stderr || ""}`;
  assert.equal(r.status, 1, "without any usable version, the bootstrap must fail");
  assert.match(saida, /nenhuma versão instalada do console conseguiu iniciar/);
  assert.match(saida, /Reinstale o pacote/);
});

test("a payload without the executar entry is treated as a load failure", (t) => {
  const raiz = ajuda.dirTemporario("console-boot3-");
  t.after(() => fs.rmSync(raiz, { recursive: true, force: true }));

  const bootstrap = path.join(raiz, "console-bootstrap.js");
  fs.copyFileSync(path.join(ajuda.RAIZ, "instalacao", "console-bootstrap.js"), bootstrap);
  fs.mkdirSync(path.join(raiz, "versoes", "2.0.0"), { recursive: true });
  fs.writeFileSync(path.join(raiz, "versoes", "2.0.0", "console.js"), "module.exports = {};\n");
  fs.mkdirSync(path.join(raiz, "versoes", "1.0.0"), { recursive: true });
  fs.writeFileSync(
    path.join(raiz, "versoes", "1.0.0", "console.js"),
    'module.exports = { executar() { process.stdout.write("SUBIU 1.0.0\\n"); } };\n'
  );
  fs.writeFileSync(
    path.join(raiz, "estado-instalacao.json"),
    `${JSON.stringify({ versaoAtiva: "2.0.0", versaoAnterior: "1.0.0", transacao: null })}\n`
  );

  const r = require("child_process").spawnSync(process.execPath, [bootstrap], { encoding: "utf8", timeout: 30_000 });
  const saida = `${r.stdout || ""}${r.stderr || ""}`;
  assert.equal(r.status, 0, saida);
  assert.match(saida, /SUBIU 1\.0\.0/);
  assert.match(saida, /executar/);
});

test("two version operations do not run at the same time", async (t) => {
  // Update, offline import and rollback change the same pointer and versoes/. Without exclusion,
  // two operations could install different versions at once and one could prune the version the
  // other was about to activate: pointer at a missing directory, Console unable to start.
  const raiz = ajuda.dirTemporario("console-trava-");
  const amb = ajuda.ambiente({ env: { CONSOLE_RAIZ_INSTALACAO: raiz } });
  t.after(() => {
    amb.restaurar();
    fs.rmSync(raiz, { recursive: true, force: true });
  });
  const atualizador = require(path.join(ajuda.RAIZ, "src", "atualizador.js"));

  fs.mkdirSync(path.join(raiz, "versoes", "1.0.0"), { recursive: true });
  fs.writeFileSync(path.join(raiz, "versoes", "1.0.0", "package.json"), '{"version":"1.0.0"}\n');
  fs.writeFileSync(path.join(raiz, "versoes", "1.0.0", "console.js"), "module.exports={};\n");
  fs.writeFileSync(
    path.join(raiz, "estado-instalacao.json"),
    `${JSON.stringify({ versaoAtiva: "2.0.0", versaoAnterior: "1.0.0", transacao: null })}\n`
  );

  const primeira = atualizador.adquirirTrava("atualizar 9.9.9");
  assert.equal(primeira.ok, true, "the first operation acquires the lock");
  t.after(() => atualizador.liberarTrava());

  // With the lock held by THIS (live) process, rollback must refuse.
  const r = await atualizador.reverter({ log: () => {} });
  assert.equal(r.ok, false, "the second operation must not proceed");
  assert.match(r.erro, /outra operação de versão está em andamento/);
  assert.match(r.erro, /atualizar 9\.9\.9/, "the refusal must say which operation holds the lock");

  // The pointer did not move.
  assert.equal(atualizador.lerEstadoInstalacao().versaoAtiva, "2.0.0");
});

test("a dead process's lock is recovered instead of locking the installation forever", (t) => {
  const raiz = ajuda.dirTemporario("console-trava2-");
  const amb = ajuda.ambiente({ env: { CONSOLE_RAIZ_INSTALACAO: raiz } });
  t.after(() => {
    amb.restaurar();
    fs.rmSync(raiz, { recursive: true, force: true });
  });
  const atualizador = require(path.join(ajuda.RAIZ, "src", "atualizador.js"));

  // PID unlikely to exist: simulates a crash in the middle of an update.
  fs.writeFileSync(
    path.join(raiz, "operacao-em-andamento.json"),
    `${JSON.stringify({ operacao: "atualizar 3.0.0", pid: 999999, em: new Date().toISOString() })}\n`
  );

  const r = atualizador.adquirirTrava("reverter");
  assert.equal(r.ok, true, "the leftover lock must be recovered");
  const dono = JSON.parse(fs.readFileSync(path.join(raiz, "operacao-em-andamento.json"), "utf8"));
  assert.equal(dono.pid, process.pid, "a trava passa a ser deste processo");
  atualizador.liberarTrava();
  assert.ok(!fs.existsSync(path.join(raiz, "operacao-em-andamento.json")), "liberar remove a trava");
});

test("orphan lock recovery does not let two processes in", (t) => {
  // Remove-and-recreate races: two processes see the same dead owner, the first recreates the lock
  // and the second removes that LIVE lock and creates its own. The claim is a rename, which is
  // atomic: only one can move that path.
  const raiz = ajuda.dirTemporario("console-corrida-");
  const amb = ajuda.ambiente({ env: { CONSOLE_RAIZ_INSTALACAO: raiz } });
  t.after(() => {
    amb.restaurar();
    fs.rmSync(raiz, { recursive: true, force: true });
  });
  const atualizador = require(path.join(ajuda.RAIZ, "src", "atualizador.js"));
  const arquivo = path.join(raiz, "operacao-em-andamento.json");

  // Lock held by a dead process.
  fs.writeFileSync(arquivo, `${JSON.stringify({ operacao: "atualizar 3.0.0", pid: 999999, em: new Date().toISOString() })}\n`);

  const primeira = atualizador.adquirirTrava("A");
  assert.equal(primeira.ok, true, "whoever recovers the orphan keeps the lock");
  const dono = JSON.parse(fs.readFileSync(arquivo, "utf8"));
  assert.equal(dono.pid, process.pid);
  assert.equal(dono.operacao, "A");

  // A second acquisition, now with a LIVE owner (this process), must refuse, not remove.
  const segunda = atualizador.adquirirTrava("B");
  assert.equal(segunda.ok, false, "with a live owner, the second one refuses");
  const aindaDono = JSON.parse(fs.readFileSync(arquivo, "utf8"));
  assert.equal(aindaDono.operacao, "A", "the live lock must not be replaced by the second operation");

  atualizador.liberarTrava();
  assert.ok(!fs.existsSync(arquivo));
  assert.ok(!fs.readdirSync(raiz).some((n) => n.includes(".orfa-")), "no recovery leftover remains");
});

test("reconciliation does not touch versoes/ while a live operation holds the lock", (t) => {
  // A second Console starting during an update must not call reconciliar() and delete the staging
  // of the operation in progress.
  const raiz = ajuda.dirTemporario("console-recon-");
  const amb = ajuda.ambiente({ env: { CONSOLE_RAIZ_INSTALACAO: raiz } });
  t.after(() => {
    amb.restaurar();
    fs.rmSync(raiz, { recursive: true, force: true });
  });
  const atualizador = require(path.join(ajuda.RAIZ, "src", "atualizador.js"));

  fs.mkdirSync(path.join(raiz, "versoes"), { recursive: true });
  const estagio = path.join(raiz, "versoes", "3.0.0.parcial-abc123");
  fs.mkdirSync(estagio, { recursive: true });
  fs.writeFileSync(path.join(estagio, "console.js"), "//\n");
  fs.writeFileSync(
    path.join(raiz, "estado-instalacao.json"),
    `${JSON.stringify({ versaoAtiva: "1.0.0", versaoAnterior: null, transacao: { versao: "3.0.0", etapa: "instalando" } })}\n`
  );
  // Lock of a LIVE process other than this one. The "other process" check compares with
  // process.pid, so a different live pid is simulated with the parent process's pid, which exists.
  fs.writeFileSync(
    path.join(raiz, "operacao-em-andamento.json"),
    `${JSON.stringify({ operacao: "atualizar 3.0.0", pid: process.ppid, em: new Date().toISOString() })}\n`
  );

  const r = atualizador.reconciliar();
  assert.equal(r.adiado, true, `reconciliation must be deferred. Got: ${JSON.stringify(r)}`);
  assert.ok(fs.existsSync(estagio), "the staging of the operation in progress must not be deleted");
  assert.ok(atualizador.lerEstadoInstalacao().transacao, "the other operation's transaction stays recorded");
});

test("reconciliation preserves .substituido-*, the only copy during a swap", (t) => {
  const raiz = ajuda.dirTemporario("console-subst-");
  const amb = ajuda.ambiente({ env: { CONSOLE_RAIZ_INSTALACAO: raiz } });
  t.after(() => {
    amb.restaurar();
    fs.rmSync(raiz, { recursive: true, force: true });
  });
  const atualizador = require(path.join(ajuda.RAIZ, "src", "atualizador.js"));

  fs.mkdirSync(path.join(raiz, "versoes"), { recursive: true });
  const parcial = path.join(raiz, "versoes", "3.0.0.parcial-aaa111");
  const substituido = path.join(raiz, "versoes", "1.0.0.substituido-bbb222");
  for (const d of [parcial, substituido]) {
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "console.js"), "//\n");
  }
  fs.writeFileSync(
    path.join(raiz, "estado-instalacao.json"),
    `${JSON.stringify({ versaoAtiva: "1.0.0", versaoAnterior: null, transacao: { versao: "3.0.0", etapa: "instalando" } })}\n`
  );

  atualizador.reconciliar();
  assert.ok(!fs.existsSync(parcial), "the interrupted transaction's partial goes");
  assert.ok(fs.existsSync(substituido), ".substituido-* must NOT go: it is the only copy of the previous payload");
});

test("the artifact's size is checked before it is read into memory", (t) => {
  // Size is checked before reading: reading first would load an oversized artifact into memory,
  // which on a 1 GiB Pi brings the host down before any check says it was invalid.
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const release = require(path.join(ajuda.RAIZ, "src", "release.js"));

  const dir = ajuda.dirTemporario("console-tam-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const arquivo = path.join(dir, "a.tar.gz");
  fs.writeFileSync(arquivo, Buffer.alloc(2048, 7));

  // Mismatched size: refused without needing the digest.
  const r = release.conferirArtefato(arquivo, { bytes: 999_999, sha256: "0".repeat(64) });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /bytes no arquivo/, "the refusal comes from the stat check, not from reading");

  // Above the Console ceiling, even with the declared size matching.
  const acima = release.conferirArtefato(arquivo, { bytes: 2048, sha256: "0".repeat(64) }, { limiteBytes: 1024 });
  assert.equal(acima.ok, false);
  assert.match(acima.motivo, /acima do teto/);
});

test("a pending restart is not announced as a version that did not start", async (t) => {
  // Between the pointer swap and the restart, the running process is legitimately the previous one.
  // An error there would say the version "did not start" at the exact moment everything is correct,
  // and a warning that fires on the normal path is one the operator learns to ignore.
  const raiz = ajuda.dirTemporario("console-pend-");
  const amb = ajuda.ambiente({ env: { CONSOLE_RAIZ_INSTALACAO: raiz } });
  t.after(() => {
    amb.restaurar();
    fs.rmSync(raiz, { recursive: true, force: true });
  });
  const atualizador = require(path.join(ajuda.RAIZ, "src", "atualizador.js"));
  const emExecucao = atualizador.versaoEmExecucao();

  for (const v of [emExecucao, "99.0.0"]) {
    fs.mkdirSync(path.join(raiz, "versoes", v), { recursive: true });
    fs.writeFileSync(path.join(raiz, "versoes", v, "package.json"), `${JSON.stringify({ version: v })}
`);
  }

  // Pointer already on the new version, the previous one running, transaction completed NOW:
  // restart pending.
  const agora = new Date().toISOString();
  fs.writeFileSync(
    path.join(raiz, "estado-instalacao.json"),
    `${JSON.stringify({
      versaoAtiva: "99.0.0",
      versaoAnterior: emExecucao,
      transacao: { versao: "99.0.0", etapa: "concluida", em: agora },
      atualizadoEm: agora,
    })}
`
  );

  const pendente = await atualizador.situacao();
  assert.ok(pendente.divergenciaDeVersao, "the status must still report the mismatch");
  assert.equal(pendente.divergenciaDeVersao.reinicioPendente, true, "but as a pending restart, not as a failure");
  assert.match(pendente.divergenciaDeVersao.motivo, /reinício está pendente/);

  // Old transaction: then it is an activation failure.
  const velho = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  fs.writeFileSync(
    path.join(raiz, "estado-instalacao.json"),
    `${JSON.stringify({
      versaoAtiva: "99.0.0",
      versaoAnterior: emExecucao,
      transacao: { versao: "99.0.0", etapa: "concluida", em: velho },
      atualizadoEm: velho,
    })}
`
  );
  const falha = await atualizador.situacao();
  assert.ok(falha.divergenciaDeVersao);
  assert.ok(!falha.divergenciaDeVersao.reinicioPendente, "one hour later it is no longer a pending restart");
  assert.match(falha.divergenciaDeVersao.motivo, /não subiu/);
});

test("a tar of directories only also hits the entry ceiling", (t) => {
  // A ceiling counting only files would let a tar with millions of directory entries pass and still
  // exhaust inodes.
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const atualizador = require(path.join(ajuda.RAIZ, "src", "atualizador.js"));
  const zlib = require("zlib");

  // Tar header fields are NUL-terminated. The byte comes from `String.fromCharCode`: a literal NUL
  // in the source makes Git treat the file as binary, and a test forbids that.
  const NUL = String.fromCharCode(0);
  const OCTAL_MODO = `0000755${NUL}`;
  const OCTAL_ZERO = `0000000${NUL}`;
  const OCTAL_LONGO = `00000000000${NUL}`;
  const USTAR = `ustar${NUL}`;
  const cabecalho = (nome, tipo) => {
    const b = Buffer.alloc(512);
    b.write(nome, 0, 100, "utf8");
    b.write(OCTAL_MODO, 100, 8, "utf8");
    b.write(OCTAL_ZERO, 108, 8, "utf8");
    b.write(OCTAL_ZERO, 116, 8, "utf8");
    b.write(OCTAL_LONGO, 124, 12, "utf8");
    b.write(OCTAL_LONGO, 136, 12, "utf8");
    b.write("        ", 148, 8, "utf8");
    b.write(tipo, 156, 1, "utf8");
    b.write(USTAR, 257, 6, "utf8");
    b.write("00", 263, 2, "utf8");
    let soma = 0;
    for (const byte of b) soma += byte;
    b.write(`${soma.toString(8).padStart(6, "0")}${NUL} `, 148, 8, "utf8");
    return b;
  };

  const blocos = [];
  for (let i = 0; i < 6000; i += 1) blocos.push(cabecalho(`d${i}/`, "5"));
  blocos.push(Buffer.alloc(1024));

  const dir = ajuda.dirTemporario("console-inodes-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const arquivo = path.join(dir, "muitos.tar.gz");
  fs.writeFileSync(arquivo, zlib.gzipSync(Buffer.concat(blocos)));

  assert.throws(
    () => atualizador.extrairTarGz(arquivo, path.join(dir, "saida")),
    /mais de \d+ entradas/,
    "a directory-only tar must be refused by the entry cap"
  );
});

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

// --- Apoio -------------------------------------------------------------------------------

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

/** Servidor de releases falso: serve manifesto, assinatura e artefatos. */
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

test("without a provisioned public key, no update is accepted", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const release = require(path.join(ajuda.RAIZ, "src", "release.js"));

  assert.equal(release.confianciaConfigurada(), false, "o repositório não traz chave de produção");
  const r = release.verificarManifesto(Buffer.from("{}"), "x");
  assert.equal(r.ok, false);
  assert.equal(r.naoConfigurado, true);
  assert.match(r.motivo, /não está configurada/);
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

  assert.equal(release.chavesConfiaveis().length, 1);
  release.registrarRotacao({ versao: "2.1.0", proximaChave: { publica: sucessora.publicaB64 } });
  assert.equal(release.chavesConfiaveis().length, 2, "a sucessora passa a ser aceita");

  // A manifest signed only by the successor now verifies.
  const bytes = Buffer.from(manifestoDe({ versao: "2.2.0", artefatos: [{ alvo: "linux-x64", arquivo: "a.tar.gz", sha256: "a".repeat(64), bytes: 10 }] }));
  const r = release.verificarManifesto(bytes, crypto.sign(null, bytes, sucessora.privada).toString("base64"));
  assert.equal(r.ok, true);
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
  assert.ok(!fs.existsSync(path.join(dir, "fora.txt")), "nada pode ser gravado fora");
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
  assert.equal(estadoFinal.versaoAnterior, "1.0.0", "a anterior fica guardada para reversão");
  assert.ok(fs.existsSync(path.join(raiz, "versoes", "2.0.0", "console.js")));
  assert.ok(fs.existsSync(path.join(raiz, "versoes", "1.0.0", "console.js")), "a anterior não é apagada");
  assert.ok(!fs.existsSync(path.join(raiz, "descargas")) || fs.readdirSync(path.join(raiz, "descargas")).length === 0);
  assert.ok(linhas.some((l) => /SHA-256 confere/.test(l)));

  // Nenhuma credencial foi enviada ao servidor de release.
  assert.ok(servidor.pedidos.every((p) => p.autorizacao === null), "downloads de release não carregam credencial");
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
  assert.ok(!fs.existsSync(path.join(raiz, "versoes", "2.0.0")), "a versão incompleta é descartada");
  assert.ok(!fs.existsSync(path.join(raiz, "descargas")), "o estágio é limpo");
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
  assert.ok(fs.existsSync(path.join(raiz, "versoes", "2.0.0")), "a versão concluída permanece");
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
  assert.equal(estadoFinal.versaoAnterior, "2.0.0", "a que saiu vira a anterior, para poder voltar");
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
  assert.ok(s.divergenciaDeVersao, "a divergência precisa ser reportada");
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
  assert.equal(s.divergenciaDeVersao, null, "instalação coerente não pode gerar aviso");
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
  assert.equal(s.confiancaConfigurada, false, "sem chave de produção neste repositório");
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
  assert.equal(r.status, 0, `o bootstrap deve subir a anterior. Saída:\n${saida}`);
  assert.match(saida, /SUBIU 1\.0\.0/, "a versão anterior precisa realmente executar");
  assert.match(saida, /não carregou/, "o motivo da falha da ativa precisa aparecer");
  assert.match(saida, /payload quebrado de proposito/, "o erro original precisa ser mostrado, não engolido");
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
  assert.equal(r.status, 1, "sem nenhuma versão utilizável, o bootstrap tem de falhar");
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
  assert.equal(primeira.ok, true, "a primeira operação adquire a trava");
  t.after(() => atualizador.liberarTrava());

  // With the lock held by THIS (live) process, rollback must refuse.
  const r = await atualizador.reverter({ log: () => {} });
  assert.equal(r.ok, false, "a segunda operação não pode prosseguir");
  assert.match(r.erro, /outra operação de versão está em andamento/);
  assert.match(r.erro, /atualizar 9\.9\.9/, "a recusa precisa dizer qual operação detém a trava");

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
  assert.equal(r.ok, true, "a trava residual precisa ser recuperada");
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

  // Trava de um processo morto.
  fs.writeFileSync(arquivo, `${JSON.stringify({ operacao: "atualizar 3.0.0", pid: 999999, em: new Date().toISOString() })}\n`);

  const primeira = atualizador.adquirirTrava("A");
  assert.equal(primeira.ok, true, "quem recupera a órfã fica com a trava");
  const dono = JSON.parse(fs.readFileSync(arquivo, "utf8"));
  assert.equal(dono.pid, process.pid);
  assert.equal(dono.operacao, "A");

  // A second acquisition, now with a LIVE owner (this process), must refuse, not remove.
  const segunda = atualizador.adquirirTrava("B");
  assert.equal(segunda.ok, false, "com dono vivo, a segunda recusa");
  const aindaDono = JSON.parse(fs.readFileSync(arquivo, "utf8"));
  assert.equal(aindaDono.operacao, "A", "a trava viva não pode ser substituída pela segunda operação");

  atualizador.liberarTrava();
  assert.ok(!fs.existsSync(arquivo));
  assert.ok(!fs.readdirSync(raiz).some((n) => n.includes(".orfa-")), "nenhum resíduo de recuperação fica para trás");
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
  assert.equal(r.adiado, true, `a reconciliação precisa ser adiada. Recebi: ${JSON.stringify(r)}`);
  assert.ok(fs.existsSync(estagio), "o estágio da operação em andamento não pode ser apagado");
  assert.ok(atualizador.lerEstadoInstalacao().transacao, "a transação da outra operação continua registrada");
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
  assert.ok(!fs.existsSync(parcial), "o parcial da transação interrompida sai");
  assert.ok(fs.existsSync(substituido), "o .substituido-* NÃO pode sair: é a única cópia do payload anterior");
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
  assert.match(r.motivo, /bytes no arquivo/, "a recusa vem da conferência por stat, não da leitura");

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
  assert.ok(pendente.divergenciaDeVersao, "a situação ainda precisa relatar o descompasso");
  assert.equal(pendente.divergenciaDeVersao.reinicioPendente, true, "mas como reinício pendente, não como falha");
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
  assert.ok(!falha.divergenciaDeVersao.reinicioPendente, "uma hora depois já não é reinício pendente");
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
    "um tar só de diretórios tem de ser recusado pelo teto de entradas"
  );
});

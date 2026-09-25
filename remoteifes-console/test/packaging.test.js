const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const http = require("http");
const zlib = require("zlib");
const { execFileSync } = require("child_process");
const ajuda = require("./helpers");

// Complete distribution chain: build -> sign -> publish -> update -> verify.
//
// This test prevents the classic packaging failure: the artifact exists, the manifest exists, and
// the update still does not work because the package format does not match the extractor, or
// because the signature was never actually checked against the downloaded content.

const ARVORE = ["console.js", "launcher.js", "package.json", "ARQUITETURA.md", "DISTRIBUICAO.md", "src", "bin", "web", "instalacao", "helper", "systemd", "empacotar"];

/**
 * Copy of the Console at a chosen version, so the publication is newer than the installed one.
 */
function arvoreNaVersao(versao) {
  const raiz = ajuda.dirTemporario("console-fonte-");
  for (const item of ARVORE) {
    const origem = path.join(ajuda.RAIZ, item);
    if (fs.existsSync(origem)) fs.cpSync(origem, path.join(raiz, item), { recursive: true });
  }
  const pacote = JSON.parse(fs.readFileSync(path.join(raiz, "package.json"), "utf8"));
  pacote.version = versao;
  fs.writeFileSync(path.join(raiz, "package.json"), `${JSON.stringify(pacote, null, 2)}\n`);
  return raiz;
}

function construir(raizFonte, saida, extra = []) {
  execFileSync(process.execPath, [path.join(raizFonte, "empacotar", "construir.js"), "--saida", saida, ...extra], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 300_000,
  });
}

function gerarChave(dir) {
  execFileSync(process.execPath, [path.join(ajuda.RAIZ, "empacotar", "assinar-manifesto.js"), "--gerar-chave", dir], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
  return {
    privada: path.join(dir, "release-ed25519.privada.pem"),
    publicaB64: fs.readFileSync(path.join(dir, "release-ed25519.publica.b64"), "utf8").trim(),
  };
}

function assinar(manifesto, chavePrivada) {
  execFileSync(
    process.execPath,
    [path.join(ajuda.RAIZ, "empacotar", "assinar-manifesto.js"), "--manifesto", manifesto, "--chave", chavePrivada],
    { stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }
  );
}

/**
 * Serves a release directory over HTTP on 127.0.0.1, with no credential requirement.
 */
function servirDiretorio(dir) {
  const servidor = http.createServer((req, res) => {
    const nome = decodeURIComponent(req.url.replace(/^\//, "").split("?")[0]);
    const alvo = path.resolve(dir, nome);
    if (!alvo.startsWith(path.resolve(dir)) || !fs.existsSync(alvo) || !fs.statSync(alvo).isFile()) {
      res.writeHead(404);
      return res.end();
    }
    const dados = fs.readFileSync(alvo);
    res.writeHead(200, { "Content-Length": dados.length });
    res.end(dados);
  });
  return new Promise((r) =>
    servidor.listen(0, "127.0.0.1", () =>
      r({
        base: `http://127.0.0.1:${servidor.address().port}`,
        fechar: () =>
          new Promise((f) => {
            servidor.closeAllConnections && servidor.closeAllConnections();
            servidor.close(() => f());
          }),
      })
    )
  );
}

/**
 * Side-by-side installation with an old version already present.
 */
function instalacaoCom(versaoAntiga) {
  const raiz = ajuda.dirTemporario("console-inst-");
  const dir = path.join(raiz, "versoes", versaoAntiga);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ version: versaoAntiga })}\n`);
  fs.writeFileSync(path.join(dir, "console.js"), "module.exports = { executar() {} };\n");
  fs.writeFileSync(
    path.join(raiz, "estado-instalacao.json"),
    `${JSON.stringify({ versaoAtiva: versaoAntiga, versaoAnterior: null, transacao: null })}\n`
  );
  return raiz;
}

test("the builder produces payload, manifest and honest provenance", (t) => {
  const saida = ajuda.dirTemporario("console-dist-");
  t.after(() => fs.rmSync(saida, { recursive: true, force: true }));

  construir(ajuda.RAIZ, saida);
  const versao = JSON.parse(fs.readFileSync(path.join(ajuda.RAIZ, "package.json"), "utf8")).version;

  const manifesto = JSON.parse(fs.readFileSync(path.join(saida, "manifesto.json"), "utf8"));
  assert.equal(manifesto.esquema, 1);
  assert.equal(manifesto.versao, versao);
  assert.ok(manifesto.artefatos.length >= 1);
  assert.ok(Date.parse(manifesto.expiraEm) > Date.now(), "the manifest must be created with a future expiry");

  // Without a signature the manifest is worthless, and the builder does not produce one: signing is
  // a credentialed step, separate from the build so the key is never exposed to build code.
  assert.ok(!fs.existsSync(path.join(saida, "manifesto.json.sig")), "the credentialed step signs");

  const proveniencia = JSON.parse(fs.readFileSync(path.join(saida, "proveniencia.json"), "utf8"));
  assert.equal(proveniencia.assinado, false, "CI artifacts are not production artifacts");
  assert.match(proveniencia.observacao, /NÃO ASSINADOS/);
  assert.ok(proveniencia.artefatos.every((a) => /^[0-9a-f]{64}$/.test(a.sha256)));
});

test("the built payload is exactly what the updater's extractor understands", (t) => {
  const saida = ajuda.dirTemporario("console-dist-");
  const amb = ajuda.ambiente();
  t.after(() => {
    amb.restaurar();
    fs.rmSync(saida, { recursive: true, force: true });
  });

  construir(ajuda.RAIZ, saida);
  const manifesto = JSON.parse(fs.readFileSync(path.join(saida, "manifesto.json"), "utf8"));
  const atualizador = require(path.join(ajuda.RAIZ, "src", "atualizador.js"));

  const destino = path.join(saida, "extraido");
  const r = atualizador.extrairTarGz(path.join(saida, manifesto.artefatos[0].arquivo), destino);
  assert.ok(r.arquivos > 20, "o payload traz o programa inteiro");
  for (const exigido of ["console.js", "launcher.js", "package.json", path.join("src", "servidor.js"), path.join("web", "index.html"), path.join("instalacao", "console-bootstrap.js")]) {
    assert.ok(fs.existsSync(path.join(destino, exigido)), `payload without ${exigido}`);
  }
  // Tests and packaging material are not part of the installed program.
  assert.ok(!fs.existsSync(path.join(destino, "test")), "tests do not enter the payload");
  assert.ok(!fs.existsSync(path.join(destino, "empacotar")), "the packager does not enter the payload");
});

test("the tar is well formed for ANY reader, not only our extractor", (t) => {
  // Regression: the typeflag header field is 1 byte and is not NUL-terminated. Writing it through a
  // helper that reserves the last byte for a terminator truncated it to zero (AREGTYPE); readers
  // treat that as a regular file, so a directory became an empty file of the same name, and `dpkg`,
  // which extracts member by member and does not create missing paths, refused the whole package.
  // The Console's own extractor creates directories itself and did not notice.
  const saida = ajuda.dirTemporario("console-tar-");
  t.after(() => fs.rmSync(saida, { recursive: true, force: true }));

  construir(ajuda.RAIZ, saida, ["--alvo", "linux-arm64", "--formato", "payload"]);
  const versao = JSON.parse(fs.readFileSync(path.join(ajuda.RAIZ, "package.json"), "utf8")).version;
  const bruto = require("zlib").gunzipSync(fs.readFileSync(path.join(saida, `remoteifes-console-${versao}-linux-arm64.tar.gz`)));

  const membros = [];
  let posicao = 0;
  while (posicao + 512 <= bruto.length) {
    const cabecalho = bruto.subarray(posicao, posicao + 512);
    if (cabecalho.every((b) => b === 0)) break;
    const texto = (i, n) => cabecalho.subarray(i, i + n).toString("utf8").replace(/\0.*$/, "").trim();
    const nome = texto(0, 100);
    const tamanho = parseInt(texto(124, 12) || "0", 8) || 0;
    membros.push({ nome, tipo: String.fromCharCode(cabecalho[156]), modo: parseInt(texto(100, 8) || "0", 8), ustar: texto(257, 6) });
    posicao += 512 + Math.ceil(tamanho / 512) * 512;
  }

  assert.ok(membros.length > 40, "the payload has the whole program");
  for (const m of membros) {
    assert.ok(m.tipo === "0" || m.tipo === "5", `${m.nome} has typeflag ${JSON.stringify(m.tipo)}; only file (0) and directory (5) are emitted`);
    assert.equal(m.ustar, "ustar", `${m.nome} does not declare the ustar format`);
  }

  // Every directory appears as its own member, BEFORE anything that lives in it.
  const vistos = new Set();
  for (const m of membros) {
    if (m.tipo === "5") {
      assert.match(m.nome, /\/$/, `directory entry ${m.nome} must end with a slash`);
      vistos.add(m.nome);
      continue;
    }
    const partes = m.nome.split("/").slice(0, -1);
    let acumulado = "";
    for (const parte of partes) {
      acumulado += `${parte}/`;
      assert.ok(vistos.has(acumulado), `${m.nome} appears before the directory entry ${acumulado}`);
    }
  }
  assert.ok(vistos.has("src/") && vistos.has("src/plataforma/"), "nested directories also have their own entry");

  // The executable bit comes from the shebang; no setuid/setgid comes out of here.
  const runner = membros.find((m) => m.nome === "bin/backup.js");
  assert.ok(runner, "the runners travel in the payload");
  assert.equal(runner.modo, 0o755, "a runner with a shebang must be executable");
  assert.ok(membros.every((m) => (m.modo & 0o6000) === 0), "no member may carry setuid/setgid");
});

test("complete chain: build, sign, publish and actually update", async (t) => {
  const NOVA = "99.9.0";
  const fonte = arvoreNaVersao(NOVA);
  const saida = ajuda.dirTemporario("console-dist-");
  const chaves = ajuda.dirTemporario("console-chave-");
  const instalacao = instalacaoCom("0.0.1");
  t.after(() => {
    for (const d of [fonte, saida, chaves, instalacao]) fs.rmSync(d, { recursive: true, force: true });
  });

  construir(fonte, saida);
  const par = gerarChave(chaves);
  assinar(path.join(saida, "manifesto.json"), par.privada);
  assert.ok(fs.existsSync(path.join(saida, "manifesto.json.sig")));

  const servidor = await servirDiretorio(saida);
  const amb = ajuda.ambiente({
    env: { CONSOLE_RELEASE_BASE: servidor.base, CONSOLE_CHAVE_RELEASE: par.publicaB64, CONSOLE_RAIZ_INSTALACAO: instalacao },
  });
  t.after(async () => {
    await servidor.fechar();
    amb.restaurar();
  });
  const atualizador = require(path.join(ajuda.RAIZ, "src", "atualizador.js"));

  const linhas = [];
  const r = await atualizador.atualizar(NOVA, { log: (l) => linhas.push(l) });
  assert.equal(r.ok, true, r.erro);
  assert.equal(r.versao, NOVA);
  assert.ok(
    linhas.some((l) => /SHA-256 confere/.test(l)),
    "the digest must be checked against the signed manifest"
  );

  // The new version is on disk, the pointer references it, and the previous one is kept.
  const instaladoEm = path.join(instalacao, "versoes", NOVA);
  assert.ok(fs.existsSync(path.join(instaladoEm, "console.js")));
  assert.ok(fs.existsSync(path.join(instaladoEm, "src", "servidor.js")));
  const info = atualizador.lerEstadoInstalacao();
  assert.equal(info.versaoAtiva, NOVA);
  assert.equal(info.versaoAnterior, "0.0.1");
  assert.equal(info.transacao.etapa, "concluida", "no transaction stays pending after success");
  assert.ok(!fs.existsSync(path.join(instalacao, "descargas", NOVA)), "the staging area is cleaned");

  // And rollback moves the pointer back without any network: the release server is already closed.
  await servidor.fechar();
  const volta = await atualizador.reverter();
  assert.equal(volta.ok, true, volta.erro);
  assert.equal(atualizador.lerEstadoInstalacao().versaoAtiva, "0.0.1");
});

test("offline import actually installs, without any network", async (t) => {
  // A Pi without Internet receives manifest, signature and artifact on a USB drive, and offline
  // import must install them without going to the network.
  const NOVA = "99.9.2";
  const fonte = arvoreNaVersao(NOVA);
  const saida = ajuda.dirTemporario("console-dist-");
  const chaves = ajuda.dirTemporario("console-chave-");
  const instalacao = instalacaoCom("0.0.1");
  t.after(() => {
    for (const d of [fonte, saida, chaves, instalacao]) fs.rmSync(d, { recursive: true, force: true });
  });

  construir(fonte, saida);
  const par = gerarChave(chaves);
  assinar(path.join(saida, "manifesto.json"), par.privada);

  // No release base configured: any network attempt would fail.
  const amb = ajuda.ambiente({
    env: { CONSOLE_CHAVE_RELEASE: par.publicaB64, CONSOLE_RAIZ_INSTALACAO: instalacao, CONSOLE_RELEASE_BASE: undefined },
  });
  t.after(() => amb.restaurar());
  const atualizador = require(path.join(ajuda.RAIZ, "src", "atualizador.js"));
  const manifesto = JSON.parse(fs.readFileSync(path.join(saida, "manifesto.json"), "utf8"));

  const linhas = [];
  const r = await atualizador.importarOffline({
    manifesto: path.join(saida, "manifesto.json"),
    assinatura: path.join(saida, "manifesto.json.sig"),
    artefato: path.join(saida, manifesto.artefatos[0].arquivo),
    log: (l) => linhas.push(l),
  });

  assert.equal(r.ok, true, r.erro);
  assert.equal(r.versao, NOVA);
  assert.ok(fs.existsSync(path.join(instalacao, "versoes", NOVA, "src", "servidor.js")), "the payload must be installed");
  const info = atualizador.lerEstadoInstalacao();
  assert.equal(info.versaoAtiva, NOVA, "the pointer must reference the imported version");
  assert.equal(info.versaoAnterior, "0.0.1");
  assert.equal(info.transacao.etapa, "concluida");
});

test("swapping the artifact after verification does not change what is installed", async (t) => {
  // Window between verification and installation: if the digest were computed on one read and
  // extraction did another read of the SAME path, whoever could swap the file in between would
  // install content that never went through verification. On the offline path the file sits where
  // the operator pointed (a shared /tmp, a USB drive), where a swap is plausible.
  //
  // The test swaps the file exactly in that interval by intercepting the check.
  const NOVA = "99.9.4";
  const fonte = arvoreNaVersao(NOVA);
  const saida = ajuda.dirTemporario("console-dist-");
  const chaves = ajuda.dirTemporario("console-chave-");
  const instalacao = instalacaoCom("0.0.1");
  t.after(() => {
    for (const d of [fonte, saida, chaves, instalacao]) fs.rmSync(d, { recursive: true, force: true });
  });

  construir(fonte, saida);
  const par = gerarChave(chaves);
  assinar(path.join(saida, "manifesto.json"), par.privada);

  const amb = ajuda.ambiente({
    env: { CONSOLE_CHAVE_RELEASE: par.publicaB64, CONSOLE_RAIZ_INSTALACAO: instalacao },
  });
  t.after(() => amb.restaurar());
  const release = require(path.join(ajuda.RAIZ, "src", "release.js"));
  const atualizador = require(path.join(ajuda.RAIZ, "src", "atualizador.js"));

  const manifesto = JSON.parse(fs.readFileSync(path.join(saida, "manifesto.json"), "utf8"));
  const artefato = path.join(saida, manifesto.artefatos[0].arquivo);

  // As soon as the check passes, the file on disk becomes garbage. If installation re-reads the
  // path, it extracts garbage (or fails); if it extracts the checked buffer, nothing changes.
  const originalConferir = release.conferirArtefato;
  release.conferirArtefato = (caminho, meta) => {
    const r = originalConferir(caminho, meta);
    fs.writeFileSync(caminho, Buffer.from("conteudo-trocado-depois-da-verificacao"));
    return r;
  };
  t.after(() => {
    release.conferirArtefato = originalConferir;
  });

  const r = await atualizador.importarOffline({
    manifesto: path.join(saida, "manifesto.json"),
    assinatura: `${path.join(saida, "manifesto.json")}.sig`,
    artefato,
    log: () => {},
  });

  assert.equal(r.ok, true, `installation must use the verified bytes: ${r.erro}`);
  const instalado = path.join(instalacao, "versoes", NOVA);
  assert.ok(fs.existsSync(path.join(instalado, "src", "servidor.js")), "the verified payload is what was installed");
  const pacote = JSON.parse(fs.readFileSync(path.join(instalado, "package.json"), "utf8"));
  assert.equal(pacote.version, NOVA, "the installed content is the original artifact's, not the swapped one");
});

test("offline import refuses a tampered artifact and installs nothing", async (t) => {
  const NOVA = "99.9.3";
  const fonte = arvoreNaVersao(NOVA);
  const saida = ajuda.dirTemporario("console-dist-");
  const chaves = ajuda.dirTemporario("console-chave-");
  const instalacao = instalacaoCom("0.0.1");
  t.after(() => {
    for (const d of [fonte, saida, chaves, instalacao]) fs.rmSync(d, { recursive: true, force: true });
  });

  construir(fonte, saida);
  const par = gerarChave(chaves);
  assinar(path.join(saida, "manifesto.json"), par.privada);

  const manifesto = JSON.parse(fs.readFileSync(path.join(saida, "manifesto.json"), "utf8"));
  const artefato = path.join(saida, manifesto.artefatos[0].arquivo);
  fs.appendFileSync(artefato, "conteudo-extra");

  const amb = ajuda.ambiente({
    env: { CONSOLE_CHAVE_RELEASE: par.publicaB64, CONSOLE_RAIZ_INSTALACAO: instalacao },
  });
  t.after(() => amb.restaurar());
  const atualizador = require(path.join(ajuda.RAIZ, "src", "atualizador.js"));

  const r = await atualizador.importarOffline({
    manifesto: path.join(saida, "manifesto.json"),
    assinatura: path.join(saida, "manifesto.json.sig"),
    artefato,
    log: () => {},
  });
  assert.equal(r.ok, false);
  assert.ok(!fs.existsSync(path.join(instalacao, "versoes", NOVA)), "nothing may be installed with a mismatched digest");
  assert.equal(atualizador.lerEstadoInstalacao().versaoAtiva, "0.0.1", "the pointer does not move");
});

test("a manifest tampered with after signing is refused", async (t) => {
  const saida = ajuda.dirTemporario("console-dist-");
  const chaves = ajuda.dirTemporario("console-chave-");
  t.after(() => {
    for (const d of [saida, chaves]) fs.rmSync(d, { recursive: true, force: true });
  });

  construir(ajuda.RAIZ, saida);
  const par = gerarChave(chaves);
  assinar(path.join(saida, "manifesto.json"), par.privada);

  // Swapping the digest while keeping the old signature is exactly the attack the signature exists
  // to prevent: pointing a legitimate release at other content.
  const manifesto = JSON.parse(fs.readFileSync(path.join(saida, "manifesto.json"), "utf8"));
  manifesto.artefatos[0].sha256 = "c".repeat(64);
  fs.writeFileSync(path.join(saida, "manifesto.json"), `${JSON.stringify(manifesto, null, 2)}\n`);

  const servidor = await servirDiretorio(saida);
  const amb = ajuda.ambiente({ env: { CONSOLE_RELEASE_BASE: servidor.base, CONSOLE_CHAVE_RELEASE: par.publicaB64 } });
  t.after(async () => {
    await servidor.fechar();
    amb.restaurar();
  });
  const atualizador = require(path.join(ajuda.RAIZ, "src", "atualizador.js"));

  const r = await atualizador.verificarPublicacao({ forcar: true });
  assert.equal(r.ok, false);
  assert.equal(r.recusado, true);
  assert.match(r.motivo, /assinatura/i);
});

test("an artifact swapped on the server does not pass the signed manifest's digest", async (t) => {
  const NOVA = "99.9.1";
  const fonte = arvoreNaVersao(NOVA);
  const saida = ajuda.dirTemporario("console-dist-");
  const chaves = ajuda.dirTemporario("console-chave-");
  const instalacao = instalacaoCom("0.0.1");
  t.after(() => {
    for (const d of [fonte, saida, chaves, instalacao]) fs.rmSync(d, { recursive: true, force: true });
  });

  construir(fonte, saida);
  const par = gerarChave(chaves);
  assinar(path.join(saida, "manifesto.json"), par.privada);

  // Manifest and signature remain intact; the served file is what was swapped.
  const manifesto = JSON.parse(fs.readFileSync(path.join(saida, "manifesto.json"), "utf8"));
  const artefato = path.join(saida, manifesto.artefatos[0].arquivo);
  const original = fs.readFileSync(artefato);
  fs.writeFileSync(artefato, Buffer.concat([original, Buffer.from("conteudo-extra")]));

  const servidor = await servirDiretorio(saida);
  const amb = ajuda.ambiente({
    env: { CONSOLE_RELEASE_BASE: servidor.base, CONSOLE_CHAVE_RELEASE: par.publicaB64, CONSOLE_RAIZ_INSTALACAO: instalacao },
  });
  t.after(async () => {
    await servidor.fechar();
    amb.restaurar();
  });
  const atualizador = require(path.join(ajuda.RAIZ, "src", "atualizador.js"));

  const r = await atualizador.atualizar(NOVA, { log: () => {} });
  assert.equal(r.ok, false);
  assert.ok(!fs.existsSync(path.join(instalacao, "versoes", NOVA)), "nothing is installed when the digest does not match");
  assert.equal(atualizador.lerEstadoInstalacao().versaoAtiva, "0.0.1", "the pointer does not move");
});

test("without a provisioned publishing key, the Console says so instead of accepting any release", async (t) => {
  const amb = ajuda.ambiente({ env: { CONSOLE_CHAVE_RELEASE: undefined } });
  t.after(() => amb.restaurar());
  const release = require(path.join(ajuda.RAIZ, "src", "release.js"));
  const atualizador = require(path.join(ajuda.RAIZ, "src", "atualizador.js"));

  assert.equal(release.CHAVE_PUBLICA_OFICIAL, null, "no production key stays in the repository");
  assert.equal(release.confianciaConfigurada(), false);
  const r = await atualizador.verificarPublicacao({ forcar: true });
  assert.equal(r.ok, false);
  assert.equal(r.naoConfigurado, true);
  assert.match(r.motivo, /chave pública/);
});

test("the signing tool refuses a manifest that is already expired", (t) => {
  const dir = ajuda.dirTemporario("console-sig-");
  const chaves = ajuda.dirTemporario("console-chave-");
  t.after(() => {
    for (const d of [dir, chaves]) fs.rmSync(d, { recursive: true, force: true });
  });

  const par = gerarChave(chaves);
  const manifesto = path.join(dir, "manifesto.json");
  fs.writeFileSync(
    manifesto,
    `${JSON.stringify({ esquema: 1, versao: "2.0.0", expiraEm: new Date(Date.now() - 1000).toISOString(), artefatos: [] })}\n`
  );
  assert.throws(() => assinar(manifesto, par.privada));
  assert.ok(!fs.existsSync(`${manifesto}.sig`), "nothing is signed");
});

test("the private publishing key never comes from a command-line argument", () => {
  const fonte = fs.readFileSync(path.join(ajuda.RAIZ, "empacotar", "assinar-manifesto.js"), "utf8");
  // `--chave` receives a PATH; key material comes from a file or the environment variable.
  assert.match(fonte, /CONSOLE_CHAVE_PRIVADA/);
  assert.ok(!/--chave-conteudo|--chave-privada-conteudo|--segredo/.test(fonte), "no option may accept the key in argv");
});

test("the .deb is assembled in the ar format dpkg understands", (t) => {
  const saida = ajuda.dirTemporario("console-deb-");
  t.after(() => fs.rmSync(saida, { recursive: true, force: true }));

  construir(ajuda.RAIZ, saida, ["--alvo", "linux-x64", "--formato", "todos"]);
  const versao = JSON.parse(fs.readFileSync(path.join(ajuda.RAIZ, "package.json"), "utf8")).version;
  const deb = path.join(saida, `remoteifes-console_${versao}_all.deb`);
  assert.ok(fs.existsSync(deb), "the .deb must be buildable from any platform");

  const conteudo = fs.readFileSync(deb);
  assert.equal(conteudo.subarray(0, 8).toString(), "!<arch>\n", "the .deb is an ar archive");
  for (const membro of ["debian-binary", "control.tar.gz", "data.tar.gz"]) {
    assert.ok(conteudo.includes(Buffer.from(membro)), `membro ${membro} ausente`);
  }

  // Provisioning is delegated to the same installer and uninstaller as a manual installation.
  const membros = membrosAr(conteudo);
  const controle = entradasTar(zlib.gunzipSync(membros["control.tar.gz"]));
  for (const script of ["postinst", "prerm", "postrm"]) {
    assert.ok(controle[script], `maintainer script ${script} missing`);
    assert.equal(controle[script].modo & 0o111, 0o111, `${script} must be executable`);
    assert.match(controle[script].texto, /^#!\/bin\/sh\nset -e\n/);
  }
  assert.match(controle.postinst.texto, new RegExp(`versoes/${versao}/instalacao/instalar\\.js" --pacote`));
  assert.match(controle.prerm.texto, new RegExp(`versoes/${versao}/instalacao/desinstalar\\.js" --pacote --sim`));
  assert.match(controle.postrm.texto, /"\$1" = "purge"[\s\S]*rm -rf \/var\/lib\/remoteifes-console/);
  assert.ok(!/purge/.test(controle.prerm.texto), "a plain remove never deletes the state");

  const dados = entradasTar(zlib.gunzipSync(membros["data.tar.gz"]));
  assert.ok(dados["opt/remoteifes-console/console-bootstrap.js"], "the stable layer belongs to the package");
  assert.ok(!dados["opt/remoteifes-console/estado-instalacao.json"], "the version pointer is rewritten by the updater, so dpkg must not own it");
});

function membrosAr(buffer) {
  const membros = {};
  let pos = 8;
  while (pos + 60 <= buffer.length) {
    const nome = buffer.subarray(pos, pos + 16).toString().trim().replace(/\/$/, "");
    const tamanho = Number.parseInt(buffer.subarray(pos + 48, pos + 58).toString().trim(), 10);
    membros[nome] = buffer.subarray(pos + 60, pos + 60 + tamanho);
    pos += 60 + tamanho + (tamanho % 2);
  }
  return membros;
}

function entradasTar(buffer) {
  const entradas = {};
  for (let pos = 0; pos + 512 <= buffer.length; ) {
    const cabecalho = buffer.subarray(pos, pos + 512);
    const nome = cabecalho.subarray(0, 100).toString().replace(/\0.*$/s, "");
    if (!nome) break;
    const prefixo = cabecalho.subarray(345, 500).toString().replace(/\0.*$/s, "");
    const tamanho = Number.parseInt(cabecalho.subarray(124, 136).toString().replace(/\0.*$/s, "").trim() || "0", 8);
    const modo = Number.parseInt(cabecalho.subarray(100, 108).toString().replace(/\0.*$/s, "").trim() || "0", 8);
    const completo = (prefixo ? `${prefixo}/${nome}` : nome).replace(/^\.\//, "");
    entradas[completo] = { modo, texto: buffer.subarray(pos + 512, pos + 512 + tamanho).toString("utf8") };
    pos += 512 + Math.ceil(tamanho / 512) * 512;
  }
  return entradas;
}

// --- Credential on redirect -----------------------------------------------------------

/**
 * HTTP server that records the headers of every request received.
 */
function servidorQueRegistra(responder) {
  const recebidas = [];
  const servidor = http.createServer((req, res) => {
    recebidas.push({ url: req.url, autorizacao: req.headers.authorization || null });
    responder(req, res, servidor);
  });
  return new Promise((r) =>
    servidor.listen(0, "127.0.0.1", () =>
      r({
        porta: servidor.address().port,
        recebidas,
        fechar: () =>
          new Promise((f) => {
            servidor.closeAllConnections && servidor.closeAllConnections();
            servidor.close(() => f());
          }),
      })
    )
  );
}

const CORPO_ARTEFATO = Buffer.from("conteudo-de-artefato-de-ci-para-teste");

test("the GitHub token does not follow a redirect to another host", async (t) => {
  // The artifact download answers 302 to signed storage on another domain. Sending `Authorization`
  // along would hand the token to a host that does not need it and may log it. Moving the header
  // out of its host condition must fail this test.
  const cdn = await servidorQueRegistra((req, res) => {
    res.writeHead(200, { "Content-Length": CORPO_ARTEFATO.length });
    res.end(CORPO_ARTEFATO);
  });
  t.after(() => cdn.fechar());

  const api = await servidorQueRegistra((req, res) => {
    if (req.url.includes("/artifacts?")) {
      const corpo = JSON.stringify({
        artifacts: [{ id: 7, name: "pacote", size_in_bytes: CORPO_ARTEFATO.length, expired: false, created_at: null, expires_at: null }],
      });
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(corpo) });
      return res.end(corpo);
    }
    if (req.url.includes("/artifacts/7/zip")) {
      res.writeHead(302, { Location: `http://127.0.0.1:${cdn.porta}/armazenamento-assinado/pacote.zip` });
      return res.end();
    }
    res.writeHead(404);
    res.end();
  });
  t.after(() => api.fechar());

  const amb = ajuda.ambiente({ githubApi: `http://127.0.0.1:${api.porta}` });
  t.after(() => amb.restaurar());
  const github = require(path.join(ajuda.RAIZ, "src", "github.js"));
  github.gravarToken("ghp_umtokenfalsoparateste0000000000");

  const dir = ajuda.dirTemporario("console-dl-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const destino = path.join(dir, "pacote.zip");

  const r = await github.baixarArtefato(1, 7, destino);
  assert.equal(r.ok, true, r.erro);

  const daApi = api.recebidas.filter((x) => x.url.includes("/artifacts"));
  assert.ok(daApi.length >= 2, `expected listing + download from the API; got ${JSON.stringify(api.recebidas)}`);
  assert.ok(
    daApi.every((x) => /^Bearer /.test(x.autorizacao || "")),
    "the API host must receive the credential on every call"
  );

  assert.equal(cdn.recebidas.length, 1, "storage receives the redirected download");
  assert.equal(cdn.recebidas[0].autorizacao, null, "storage must NOT receive the credential");
  assert.equal(fs.readFileSync(destino).toString(), CORPO_ARTEFATO.toString(), "the downloaded content is storage's");
});

test("a redirect loop is cut off instead of followed forever", async (t) => {
  let saltos = 0;
  const laco = await servidorQueRegistra((req, res, servidor) => {
    if (req.url.includes("/artifacts?")) {
      const corpo = JSON.stringify({ artifacts: [{ id: 9, name: "p", size_in_bytes: 10, expired: false }] });
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(corpo) });
      return res.end(corpo);
    }
    saltos += 1;
    res.writeHead(302, { Location: `http://127.0.0.1:${servidor.address().port}/de-novo/${saltos}` });
    res.end();
  });
  t.after(() => laco.fechar());

  const amb = ajuda.ambiente({ githubApi: `http://127.0.0.1:${laco.porta}` });
  t.after(() => amb.restaurar());
  const github = require(path.join(ajuda.RAIZ, "src", "github.js"));

  const dir = ajuda.dirTemporario("console-laco-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const destino = path.join(dir, "p.zip");

  const r = await github.baixarArtefato(1, 9, destino);
  assert.equal(r.ok, false);
  assert.match(r.erro, /redirecionamentos/);
  assert.ok(saltos <= 6, `the loop must be cut quickly; there were ${saltos} redirects`);
  assert.ok(!fs.existsSync(destino), "nothing is written when the download does not complete");
});

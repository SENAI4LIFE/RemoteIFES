const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const http = require("http");
const zlib = require("zlib");
const { execFileSync } = require("child_process");
const ajuda = require("./helpers");
const { criarAutoridade, atestarDiretorio, confiarEm } = require("./support/atestacoes");
const { listarDependencias } = require("../instalacao/dependencias");

// Complete distribution chain: build -> attest -> publish -> update -> verify.
//
// This test prevents the classic packaging failure: the artifact exists, the manifest exists, and
// the update still does not work because the package format does not match the extractor, or
// because the attestation was never actually checked against the downloaded content. The
// attestations come from a private test Sigstore standing in for GitHub Actions
// (test/support/atestacoes.js).

const ARVORE = ["console.js", "launcher.js", "package.json", "package-lock.json", "ARQUITETURA.md", "DISTRIBUICAO.md", "src", "bin", "web", "instalacao", "helper", "systemd", "empacotar"];
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

let autoridade;
test.before(async () => {
  autoridade = await criarAutoridade();
});

/**
 * Copy of the Console at a chosen version, so the publication is newer than the installed one. It
 * carries the production dependencies, as a checkout after `npm ci --omit=dev` would.
 */
function arvoreNaVersao(versao) {
  const raiz = ajuda.dirTemporario("console-fonte-");
  for (const item of [...ARVORE, ...listarDependencias(ajuda.RAIZ)]) {
    const origem = path.join(ajuda.RAIZ, item);
    if (fs.existsSync(origem)) fs.cpSync(origem, path.join(raiz, item), { recursive: true });
  }
  const pacote = JSON.parse(fs.readFileSync(path.join(raiz, "package.json"), "utf8"));
  pacote.version = versao;
  fs.writeFileSync(path.join(raiz, "package.json"), `${JSON.stringify(pacote, null, 2)}\n`);
  return raiz;
}

/** A copy outside Git names its commit; the checkout itself gets it from Git. */
function construir(raizFonte, saida, extra = []) {
  const commit = raizFonte === ajuda.RAIZ ? [] : ["--commit", COMMIT];
  execFileSync(process.execPath, [path.join(raizFonte, "empacotar", "construir.js"), "--saida", saida, ...commit, ...extra], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 300_000,
  });
}

/** Build and attest, as a release publication does. */
async function release(raizFonte, saida, extra = []) {
  construir(raizFonte, saida, extra);
  return atestarDiretorio(autoridade, saida);
}

/** A Console environment that trusts the test Sigstore. */
function ambienteConfiando(t, env) {
  const amb = ajuda.ambiente({ env });
  const desfazer = confiarEm(amb, autoridade);
  t.after(() => {
    desfazer();
    amb.restaurar();
  });
  return amb;
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
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ajuda.RAIZ, encoding: "utf8" }).trim();
  assert.equal(manifesto.commit, head, "the manifest names the commit built; the attestation must name the same");
  assert.equal(require(path.join(ajuda.RAIZ, "src", "release.js")).validarEstrutura(manifesto).ok, true, "a manifest the Console accepts");

  // The build attests nothing and holds no identity: the release publication does that afterwards.
  assert.ok(!fs.existsSync(path.join(saida, "atestacao.sigstore.json")));

  const proveniencia = JSON.parse(fs.readFileSync(path.join(saida, "proveniencia.json"), "utf8"));
  assert.equal(proveniencia.assinaturaDeCodigo, false, "no platform code signature is claimed");
  assert.match(proveniencia.observacao, /SEM ASSINATURA DE CÓDIGO/);
  assert.equal(proveniencia.commit, head);
  assert.ok(proveniencia.artefatos.every((a) => /^[0-9a-f]{64}$/.test(a.sha256)));
  execFileSync(process.execPath, [path.join(ajuda.RAIZ, "empacotar", "conferir-proveniencia.js"), saida], { stdio: "pipe" });
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
  // The release verifier does, and the test-only Sigstore mock does not.
  assert.ok(fs.existsSync(path.join(destino, "node_modules", "@sigstore", "verify", "package.json")));
  assert.ok(fs.existsSync(path.join(destino, "node_modules", "@sigstore", "tuf", "seeds.json")), "the Sigstore root it starts from");
  assert.ok(!fs.existsSync(path.join(destino, "node_modules", "@sigstore", "mock")), "test-only packages stay out");
  assert.ok(!fs.existsSync(path.join(destino, "node_modules", ".bin")));
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
    const prefixo = texto(345, 155);
    const nome = prefixo ? `${prefixo}/${texto(0, 100)}` : texto(0, 100);
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

test("complete chain: build, attest, publish and actually update", async (t) => {
  const NOVA = "99.9.0";
  const fonte = arvoreNaVersao(NOVA);
  const saida = ajuda.dirTemporario("console-dist-");
  const instalacao = instalacaoCom("0.0.1");
  t.after(() => {
    for (const d of [fonte, saida, instalacao]) fs.rmSync(d, { recursive: true, force: true });
  });

  await release(fonte, saida);
  assert.ok(fs.existsSync(path.join(saida, "atestacao.sigstore.json")));

  const servidor = await servirDiretorio(saida);
  t.after(() => servidor.fechar());
  ambienteConfiando(t, { CONSOLE_RELEASE_BASE: servidor.base, CONSOLE_RAIZ_INSTALACAO: instalacao });
  const atualizador = require(path.join(ajuda.RAIZ, "src", "atualizador.js"));

  const linhas = [];
  const r = await atualizador.atualizar(NOVA, { log: (l) => linhas.push(l) });
  assert.equal(r.ok, true, r.erro);
  assert.equal(r.versao, NOVA);
  assert.ok(
    linhas.some((l) => /SHA-256 confere/.test(l)),
    "the digest must be checked against the attested manifest"
  );

  // The new version is on disk with its verifier, the pointer references it, and the previous one
  // is kept.
  const instaladoEm = path.join(instalacao, "versoes", NOVA);
  assert.ok(fs.existsSync(path.join(instaladoEm, "console.js")));
  assert.ok(fs.existsSync(path.join(instaladoEm, "src", "servidor.js")));
  assert.ok(fs.existsSync(path.join(instaladoEm, "node_modules", "@sigstore", "verify", "package.json")), "the next update can be verified too");
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
  // A Pi without Internet receives manifest, attestation and artifact on a USB drive, and offline
  // import must install them without going to the network.
  const NOVA = "99.9.2";
  const fonte = arvoreNaVersao(NOVA);
  const saida = ajuda.dirTemporario("console-dist-");
  const instalacao = instalacaoCom("0.0.1");
  t.after(() => {
    for (const d of [fonte, saida, instalacao]) fs.rmSync(d, { recursive: true, force: true });
  });

  await release(fonte, saida);

  // No release base configured: any network attempt would fail.
  const amb = ambienteConfiando(t, { CONSOLE_RAIZ_INSTALACAO: instalacao, CONSOLE_RELEASE_BASE: undefined });
  const atualizador = require(path.join(ajuda.RAIZ, "src", "atualizador.js"));
  const manifesto = JSON.parse(fs.readFileSync(path.join(saida, "manifesto.json"), "utf8"));

  const linhas = [];
  const r = await atualizador.importarOffline({
    manifesto: path.join(saida, "manifesto.json"),
    atestacao: path.join(saida, "atestacao.sigstore.json"),
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
  assert.deepEqual(amb.atestacao.raizDeConfianca.chamadas, [{ rede: false }], "and asked only for the local trusted root");
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
  const instalacao = instalacaoCom("0.0.1");
  t.after(() => {
    for (const d of [fonte, saida, instalacao]) fs.rmSync(d, { recursive: true, force: true });
  });

  await release(fonte, saida);

  ambienteConfiando(t, { CONSOLE_RAIZ_INSTALACAO: instalacao });
  const release_ = require(path.join(ajuda.RAIZ, "src", "release.js"));
  const atualizador = require(path.join(ajuda.RAIZ, "src", "atualizador.js"));

  const manifesto = JSON.parse(fs.readFileSync(path.join(saida, "manifesto.json"), "utf8"));
  const artefato = path.join(saida, manifesto.artefatos[0].arquivo);

  // As soon as the check passes, the file on disk becomes garbage. If installation re-reads the
  // path, it extracts garbage (or fails); if it extracts the checked buffer, nothing changes.
  const originalConferir = release_.conferirArtefato;
  release_.conferirArtefato = (caminho, meta) => {
    const r = originalConferir(caminho, meta);
    fs.writeFileSync(caminho, Buffer.from("conteudo-trocado-depois-da-verificacao"));
    return r;
  };
  t.after(() => {
    release_.conferirArtefato = originalConferir;
  });

  const r = await atualizador.importarOffline({
    manifesto: path.join(saida, "manifesto.json"),
    atestacao: path.join(saida, "atestacao.sigstore.json"),
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
  const instalacao = instalacaoCom("0.0.1");
  t.after(() => {
    for (const d of [fonte, saida, instalacao]) fs.rmSync(d, { recursive: true, force: true });
  });

  await release(fonte, saida);

  const manifesto = JSON.parse(fs.readFileSync(path.join(saida, "manifesto.json"), "utf8"));
  const artefato = path.join(saida, manifesto.artefatos[0].arquivo);
  fs.appendFileSync(artefato, "conteudo-extra");

  ambienteConfiando(t, { CONSOLE_RAIZ_INSTALACAO: instalacao });
  const atualizador = require(path.join(ajuda.RAIZ, "src", "atualizador.js"));

  const r = await atualizador.importarOffline({
    manifesto: path.join(saida, "manifesto.json"),
    atestacao: path.join(saida, "atestacao.sigstore.json"),
    artefato,
    log: () => {},
  });
  assert.equal(r.ok, false);
  assert.ok(!fs.existsSync(path.join(instalacao, "versoes", NOVA)), "nothing may be installed with a mismatched digest");
  assert.equal(atualizador.lerEstadoInstalacao().versaoAtiva, "0.0.1", "the pointer does not move");
});

test("offline import of a release the Sigstore root does not vouch for installs nothing", async (t) => {
  const NOVA = "99.9.6";
  const fonte = arvoreNaVersao(NOVA);
  const saida = ajuda.dirTemporario("console-dist-");
  const instalacao = instalacaoCom("0.0.1");
  t.after(() => {
    for (const d of [fonte, saida, instalacao]) fs.rmSync(d, { recursive: true, force: true });
  });
  const manifesto = await release(fonte, saida);
  // No test trust here: the Console's own root (the real Sigstore's) does not know the test CA.
  const amb = ajuda.ambiente({ env: { CONSOLE_RAIZ_INSTALACAO: instalacao } });
  t.after(() => amb.restaurar());
  const atualizador = require(path.join(ajuda.RAIZ, "src", "atualizador.js"));

  const r = await atualizador.importarOffline({
    manifesto: path.join(saida, "manifesto.json"),
    atestacao: path.join(saida, "atestacao.sigstore.json"),
    artefato: path.join(saida, manifesto.artefatos[0].arquivo),
    log: () => {},
  });
  assert.equal(r.ok, false);
  assert.match(r.erro, /não confere criptograficamente/);
  assert.ok(!fs.existsSync(path.join(instalacao, "versoes", NOVA)));
});

test("a manifest changed after attestation is refused", async (t) => {
  const saida = ajuda.dirTemporario("console-dist-");
  t.after(() => fs.rmSync(saida, { recursive: true, force: true }));

  await release(ajuda.RAIZ, saida);

  // Changing a digest while keeping the attestation is exactly the attack the attestation exists to
  // prevent: pointing a legitimate release at other content.
  const manifesto = JSON.parse(fs.readFileSync(path.join(saida, "manifesto.json"), "utf8"));
  manifesto.artefatos[0].sha256 = "c".repeat(64);
  fs.writeFileSync(path.join(saida, "manifesto.json"), `${JSON.stringify(manifesto, null, 2)}\n`);

  const servidor = await servirDiretorio(saida);
  t.after(() => servidor.fechar());
  ambienteConfiando(t, { CONSOLE_RELEASE_BASE: servidor.base });
  const atualizador = require(path.join(ajuda.RAIZ, "src", "atualizador.js"));

  const r = await atualizador.verificarPublicacao({ forcar: true });
  assert.equal(r.ok, false);
  assert.equal(r.recusado, true);
  assert.match(r.motivo, /não é o arquivo que a atestação cobre/);
});

test("an artifact swapped on the server does not pass the attested manifest's digest", async (t) => {
  const NOVA = "99.9.1";
  const fonte = arvoreNaVersao(NOVA);
  const saida = ajuda.dirTemporario("console-dist-");
  const instalacao = instalacaoCom("0.0.1");
  t.after(() => {
    for (const d of [fonte, saida, instalacao]) fs.rmSync(d, { recursive: true, force: true });
  });

  await release(fonte, saida);

  // Manifest and attestation remain intact; the served file is what was swapped.
  const manifesto = JSON.parse(fs.readFileSync(path.join(saida, "manifesto.json"), "utf8"));
  const artefato = path.join(saida, manifesto.artefatos[0].arquivo);
  const original = fs.readFileSync(artefato);
  fs.writeFileSync(artefato, Buffer.concat([original, Buffer.from("conteudo-extra")]));

  const servidor = await servirDiretorio(saida);
  t.after(() => servidor.fechar());
  ambienteConfiando(t, { CONSOLE_RELEASE_BASE: servidor.base, CONSOLE_RAIZ_INSTALACAO: instalacao });
  const atualizador = require(path.join(ajuda.RAIZ, "src", "atualizador.js"));

  const r = await atualizador.atualizar(NOVA, { log: () => {} });
  assert.equal(r.ok, false);
  assert.ok(!fs.existsSync(path.join(instalacao, "versoes", NOVA)), "nothing is installed when the digest does not match");
  assert.equal(atualizador.lerEstadoInstalacao().versaoAtiva, "0.0.1", "the pointer does not move");
});

test("an installed Console verifies releases with no setup step", (t) => {
  // Nothing to provision at installation, bootstrap or first access: the identity policy is code,
  // and the Sigstore root the Console starts from travels in its own dependencies.
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const atestacao = amb.atestacao;
  assert.equal(atestacao.IDENTIDADE_OFICIAL.repositorio, "https://github.com/SENAI4LIFE/RemoteIFES");
  assert.equal(atestacao.IDENTIDADE_OFICIAL.workflow, ".github/workflows/console-release.yml");
  const configuracao = fs.readFileSync(path.join(ajuda.RAIZ, "src", "config.js"), "utf8");
  assert.ok(!/SIGSTORE|ATESTACAO|RAIZ_CONFIANCA/.test(configuracao), "no trust setting exists to configure");
  const instalar = fs.readFileSync(path.join(ajuda.RAIZ, "instalacao", "instalar.js"), "utf8");
  assert.ok(!/sigstore|atestacao/i.test(instalar.replace(/dependencias/g, "")), "the installer has no release-trust step");
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
  // The release verifier travels in the package; its deepest paths need the ustar prefix field.
  const verificador = `opt/remoteifes-console/versoes/${versao}/node_modules/@sigstore/verify/package.json`;
  assert.ok(dados[verificador], "the .deb carries the release verifier");
  assert.ok(Object.keys(dados).some((n) => n.length > 100), "long paths are kept whole");
  assert.ok(!Object.keys(dados).some((n) => n.includes("@sigstore/mock")), "test-only packages stay out");
  assert.ok(!dados["opt/remoteifes-console/estado-instalacao.json"], "the version pointer is rewritten by the updater, so dpkg must not own it");
});

test("the Windows installer script delegates to the portable installer and asks for no privilege", () => {
  const nsi = fs.readFileSync(path.join(ajuda.RAIZ, "empacotar", "windows", "instalador.nsi"), "utf8");

  // A per-user installation must not ask for elevation: the scheduled task that opens the Console on
  // logon is registered for the user, and the destination is under %LOCALAPPDATA%.
  assert.match(nsi, /^RequestExecutionLevel user$/m);
  assert.match(nsi, /InstallDir "\$LOCALAPPDATA\\Programs\\RemoteIFES Console"/);

  // The destination chosen here is handed to the portable installer, so there is one answer to
  // where the program goes, and one implementation of how it gets there.
  assert.match(nsi, /instalacao\\instalar\.js" --escopo usuario --raiz "\$INSTDIR"/);
  assert.ok(!/--escopo sistema/.test(nsi), "a machine-wide install is a separate elevated path");

  // Removal goes through the Console's own uninstaller, which refuses a directory that does not
  // prove to be an installation. The installer never deletes a tree by itself.
  assert.match(nsi, /desinstalar-console\.js" --sim --raiz "\$INSTDIR"/);
  assert.ok(!/RMDir \/r/.test(nsi), "no recursive removal outside the Console's own uninstaller");

  // Programs and Features entry, and the no-console-window launcher for both shortcuts.
  for (const chave of ["DisplayName", "DisplayVersion", "UninstallString", "QuietUninstallString", "InstallLocation"]) {
    assert.ok(nsi.includes(`"${chave}"`), `uninstall entry missing ${chave}`);
  }
  assert.match(nsi, /wscript\.exe/, "the shortcuts open the Console without a console window");

  // A payload file without an extension must not be silently left out of the installer.
  assert.ok(!/File \/r "\$\{PAYLOAD\}\\\*\.\*"/.test(nsi), "the payload glob must not be *.*");
  assert.match(nsi, /File \/r "\$\{PAYLOAD\}\\\*"/);
  assert.match(nsi, /MUI_LANGUAGE "PortugueseBR"/);

  // A silent run must never block on a dialog: /S is what a deployment script uses, and what the
  // QuietUninstallString in Programs and Features runs. NSIS still shows MessageBox when silent.
  for (const [indice, linha] of nsi.split("\n").entries()) {
    if (!/^\s*MessageBox\b/.test(linha)) continue;
    const anteriores = nsi.split("\n").slice(Math.max(0, indice - 3), indice).join("\n");
    assert.match(anteriores, /\$\{IfNot\} \$\{Silent\}/, `MessageBox na linha ${indice + 1} não está sob um guarda de modo silencioso`);
  }

  // The Console's own uninstaller removes the tree this executable lives in, so it must not be
  // invoked with `_?=`, which keeps it running inside that tree.
  const instrucoes = nsi
    .split("\n")
    .filter((linha) => !/^\s*;/.test(linha))
    .join("\n");
  assert.ok(!/_\?=/.test(instrucoes), "o desinstalador não deve depender de _?=");
});

test("the Windows installer executable is built as a real Windows program", (t) => {
  let makensis = null;
  for (const candidato of [process.env.MAKENSIS, "makensis"].filter(Boolean)) {
    try {
      execFileSync(candidato, ["-VERSION"], { stdio: "ignore" });
      makensis = candidato;
      break;
    } catch {
      // Not available here.
    }
  }
  if (!makensis) {
    // The CI job that installs and removes the executable runs on a Windows runner, where NSIS is
    // provisioned; this check only adds the cross-build on a machine that can compile it.
    t.skip("makensis não disponível nesta máquina");
    return;
  }

  const saida = ajuda.dirTemporario("console-exe-");
  t.after(() => fs.rmSync(saida, { recursive: true, force: true }));
  construir(ajuda.RAIZ, saida, ["--alvo", "windows-x64", "--formato", "exe"]);

  const versao = JSON.parse(fs.readFileSync(path.join(ajuda.RAIZ, "package.json"), "utf8")).version;
  const exe = path.join(saida, `remoteifes-console-${versao}-windows-x64-instalador.exe`);
  assert.ok(fs.existsSync(exe), "o instalador .exe não foi construído");
  const conteudo = fs.readFileSync(exe);
  assert.equal(conteudo.subarray(0, 2).toString("latin1"), "MZ", "must be a Windows executable");
  assert.ok(conteudo.includes(Buffer.from("Nullsoft")), "must be the NSIS installer");
  // The payload travels inside the installer: an executable without it would install nothing.
  assert.ok(conteudo.length > 150 * 1024, `instalador pequeno demais (${conteudo.length} bytes)`);

  const proveniencia = JSON.parse(fs.readFileSync(path.join(saida, "proveniencia.json"), "utf8"));
  assert.equal(proveniencia.assinaturaDeCodigo, false, "there is no code-signing credential; provenance must say so");
  assert.ok(
    proveniencia.artefatos.some((a) => a.formato === "exe" && a.arquivo === path.basename(exe)),
    "o .exe deve constar na procedência"
  );
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

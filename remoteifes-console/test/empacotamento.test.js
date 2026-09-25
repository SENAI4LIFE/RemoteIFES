const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { execFileSync } = require("child_process");
const ajuda = require("./ajuda");
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
  assert.equal(manifesto.commit, head, "o manifesto nomeia o commit construído; a atestação precisa nomear o mesmo");
  assert.equal(require(path.join(ajuda.RAIZ, "src", "release.js")).validarEstrutura(manifesto).ok, true, "um manifesto que o console aceita");

  // The build attests nothing and holds no identity: the release publication does that afterwards.
  assert.ok(!fs.existsSync(path.join(saida, "atestacao.sigstore.json")));

  const proveniencia = JSON.parse(fs.readFileSync(path.join(saida, "proveniencia.json"), "utf8"));
  assert.equal(proveniencia.assinaturaDeCodigo, false, "nenhuma assinatura de código da plataforma é declarada");
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
    assert.ok(fs.existsSync(path.join(destino, exigido)), `payload sem ${exigido}`);
  }
  // Tests and packaging material are not part of the installed program.
  assert.ok(!fs.existsSync(path.join(destino, "test")), "testes não entram no payload");
  assert.ok(!fs.existsSync(path.join(destino, "empacotar")), "o empacotador não entra no payload");
  // The release verifier does, and the test-only Sigstore mock does not.
  assert.ok(fs.existsSync(path.join(destino, "node_modules", "@sigstore", "verify", "package.json")));
  assert.ok(fs.existsSync(path.join(destino, "node_modules", "@sigstore", "tuf", "seeds.json")), "a raiz do Sigstore de que ele parte");
  assert.ok(!fs.existsSync(path.join(destino, "node_modules", "@sigstore", "mock")), "pacotes só de teste ficam de fora");
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

  assert.ok(membros.length > 40, "o payload tem o programa inteiro");
  for (const m of membros) {
    assert.ok(m.tipo === "0" || m.tipo === "5", `${m.nome} tem typeflag ${JSON.stringify(m.tipo)}; só arquivo (0) e diretório (5) são emitidos`);
    assert.equal(m.ustar, "ustar", `${m.nome} não declara o formato ustar`);
  }

  // Every directory appears as its own member, BEFORE anything that lives in it.
  const vistos = new Set();
  for (const m of membros) {
    if (m.tipo === "5") {
      assert.match(m.nome, /\/$/, `entrada de diretório ${m.nome} precisa terminar em barra`);
      vistos.add(m.nome);
      continue;
    }
    const partes = m.nome.split("/").slice(0, -1);
    let acumulado = "";
    for (const parte of partes) {
      acumulado += `${parte}/`;
      assert.ok(vistos.has(acumulado), `${m.nome} aparece antes da entrada de diretório ${acumulado}`);
    }
  }
  assert.ok(vistos.has("src/") && vistos.has("src/plataforma/"), "diretórios aninhados também têm entrada própria");

  // The executable bit comes from the shebang; no setuid/setgid comes out of here.
  const runner = membros.find((m) => m.nome === "bin/backup.js");
  assert.ok(runner, "os runners viajam no payload");
  assert.equal(runner.modo, 0o755, "um runner com shebang precisa sair executável");
  assert.ok(membros.every((m) => (m.modo & 0o6000) === 0), "nenhum membro pode carregar setuid/setgid");
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
    "o digest precisa ser conferido contra o manifesto atestado"
  );

  // The new version is on disk with its verifier, the pointer references it, and the previous one
  // is kept.
  const instaladoEm = path.join(instalacao, "versoes", NOVA);
  assert.ok(fs.existsSync(path.join(instaladoEm, "console.js")));
  assert.ok(fs.existsSync(path.join(instaladoEm, "src", "servidor.js")));
  assert.ok(fs.existsSync(path.join(instaladoEm, "node_modules", "@sigstore", "verify", "package.json")), "a próxima atualização também pode ser verificada");
  const info = atualizador.lerEstadoInstalacao();
  assert.equal(info.versaoAtiva, NOVA);
  assert.equal(info.versaoAnterior, "0.0.1");
  assert.equal(info.transacao.etapa, "concluida", "nenhuma transação fica pendente depois do sucesso");
  assert.ok(!fs.existsSync(path.join(instalacao, "descargas", NOVA)), "a área de estágio é limpa");

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

  // Nenhuma base de release configurada: qualquer tentativa de rede falharia.
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
  assert.ok(fs.existsSync(path.join(instalacao, "versoes", NOVA, "src", "servidor.js")), "o payload precisa ficar instalado");
  const info = atualizador.lerEstadoInstalacao();
  assert.equal(info.versaoAtiva, NOVA, "o ponteiro tem de apontar para a versão importada");
  assert.equal(info.versaoAnterior, "0.0.1");
  assert.equal(info.transacao.etapa, "concluida");
  assert.deepEqual(amb.atestacao.raizDeConfianca.chamadas, [{ rede: false }], "e só pediu a raiz de confiança local");
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

  assert.equal(r.ok, true, `a instalação deve usar os bytes verificados: ${r.erro}`);
  const instalado = path.join(instalacao, "versoes", NOVA);
  assert.ok(fs.existsSync(path.join(instalado, "src", "servidor.js")), "o payload verificado é o que ficou instalado");
  const pacote = JSON.parse(fs.readFileSync(path.join(instalado, "package.json"), "utf8"));
  assert.equal(pacote.version, NOVA, "o conteúdo instalado é o do artefato original, não o trocado");
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
  assert.ok(!fs.existsSync(path.join(instalacao, "versoes", NOVA)), "nada pode ser instalado com digest divergente");
  assert.equal(atualizador.lerEstadoInstalacao().versaoAtiva, "0.0.1", "o ponteiro não se move");
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
  assert.ok(!fs.existsSync(path.join(instalacao, "versoes", NOVA)), "nada é instalado quando o digest não confere");
  assert.equal(atualizador.lerEstadoInstalacao().versaoAtiva, "0.0.1", "o ponteiro não se move");
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
  assert.ok(!/SIGSTORE|ATESTACAO|RAIZ_CONFIANCA/.test(configuracao), "não existe configuração de confiança a ajustar");
  const instalar = fs.readFileSync(path.join(ajuda.RAIZ, "instalacao", "instalar.js"), "utf8");
  assert.ok(!/sigstore|atestacao/i.test(instalar.replace(/dependencias/g, "")), "o instalador não tem etapa de confiança de release");
});

test("the .deb is assembled in the ar format dpkg understands", (t) => {
  const saida = ajuda.dirTemporario("console-deb-");
  t.after(() => fs.rmSync(saida, { recursive: true, force: true }));

  construir(ajuda.RAIZ, saida, ["--alvo", "linux-x64", "--formato", "todos"]);
  const versao = JSON.parse(fs.readFileSync(path.join(ajuda.RAIZ, "package.json"), "utf8")).version;
  const deb = path.join(saida, `remoteifes-console_${versao}_all.deb`);
  assert.ok(fs.existsSync(deb), "o .deb precisa ser construído a partir de qualquer plataforma");

  const conteudo = fs.readFileSync(deb);
  assert.equal(conteudo.subarray(0, 8).toString(), "!<arch>\n", "o .deb é um arquivo ar");
  for (const membro of ["debian-binary", "control.tar.gz", "data.tar.gz"]) {
    assert.ok(conteudo.includes(Buffer.from(membro)), `membro ${membro} ausente`);
  }
});

// --- Credencial em redirecionamento -----------------------------------------------------------

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
  assert.ok(daApi.length >= 2, `esperava listagem + download na API; recebi ${JSON.stringify(api.recebidas)}`);
  assert.ok(
    daApi.every((x) => /^Bearer /.test(x.autorizacao || "")),
    "o host da API precisa receber a credencial em todas as chamadas"
  );

  assert.equal(cdn.recebidas.length, 1, "o armazenamento recebe o download redirecionado");
  assert.equal(cdn.recebidas[0].autorizacao, null, "o armazenamento NÃO pode receber a credencial");
  assert.equal(fs.readFileSync(destino).toString(), CORPO_ARTEFATO.toString(), "o conteúdo baixado é o do armazenamento");
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
  assert.ok(saltos <= 6, `o laço tem de ser cortado rápido; houve ${saltos} redirecionamentos`);
  assert.ok(!fs.existsSync(destino), "nada é gravado quando o download não conclui");
});

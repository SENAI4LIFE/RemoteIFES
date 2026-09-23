const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { execFileSync } = require("child_process");
const ajuda = require("./ajuda");

// Cadeia completa de distribuição: construir → assinar → publicar → atualizar → verificar.
//
// É o teste que impede a falha clássica de empacotamento: o artefato existe, o manifesto existe,
// e mesmo assim a atualização não funciona porque o formato do pacote não casa com o extrator,
// ou porque a assinatura nunca foi realmente conferida contra o conteúdo baixado.

const ARVORE = ["console.js", "launcher.js", "package.json", "ARQUITETURA.md", "DISTRIBUICAO.md", "src", "bin", "web", "instalacao", "helper", "systemd", "empacotar"];

/** Cópia do console numa versão escolhida, para que a publicação seja mais nova que a instalada. */
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

/** Serve um diretório de release por HTTP em 127.0.0.1, sem nenhum requisito de credencial. */
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

/** Instalação lado a lado com uma versão antiga já presente. */
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

test("o construtor produz payload, manifesto e procedência honesta", (t) => {
  const saida = ajuda.dirTemporario("console-dist-");
  t.after(() => fs.rmSync(saida, { recursive: true, force: true }));

  construir(ajuda.RAIZ, saida);
  const versao = JSON.parse(fs.readFileSync(path.join(ajuda.RAIZ, "package.json"), "utf8")).version;

  const manifesto = JSON.parse(fs.readFileSync(path.join(saida, "manifesto.json"), "utf8"));
  assert.equal(manifesto.esquema, 1);
  assert.equal(manifesto.versao, versao);
  assert.ok(manifesto.artefatos.length >= 1);
  assert.ok(Date.parse(manifesto.expiraEm) > Date.now(), "o manifesto precisa nascer com validade futura");

  // Sem assinatura o manifesto não vale nada, e o construtor não a produz: assinar é etapa
  // credenciada, separada do build justamente para não expor a chave ao código do build.
  assert.ok(!fs.existsSync(path.join(saida, "manifesto.json.sig")), "quem assina é a etapa credenciada");

  const proveniencia = JSON.parse(fs.readFileSync(path.join(saida, "proveniencia.json"), "utf8"));
  assert.equal(proveniencia.assinado, false, "artefatos de CI não são de produção");
  assert.match(proveniencia.observacao, /NÃO ASSINADOS/);
  assert.ok(proveniencia.artefatos.every((a) => /^[0-9a-f]{64}$/.test(a.sha256)));
});

test("o payload construído é exatamente o que o extrator do atualizador entende", (t) => {
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
  // Testes e material de empacotamento não viajam no programa instalado.
  assert.ok(!fs.existsSync(path.join(destino, "test")), "testes não entram no payload");
  assert.ok(!fs.existsSync(path.join(destino, "empacotar")), "o empacotador não entra no payload");
});

test("o tar é bem formado para QUALQUER leitor, não só para o nosso extrator", (t) => {
  // Regressão de um defeito que passou despercebido porque o único leitor era o extrator do
  // próprio console, que cria diretórios sozinho. O campo typeflag do cabeçalho tem 1 byte e
  // não é terminado por NUL; ele era escrito por um helper que reservava o último byte para o
  // terminador, o que com tamanho 1 truncava o campo para vazio. Todo membro saía com \0
  // (AREGTYPE), que leitores tratam como arquivo comum — então os arquivos funcionavam e um
  // diretório virava um arquivo vazio de mesmo nome. O `dpkg`, que extrai membro a membro e
  // não inventa caminho, recusava o pacote inteiro.
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

  assert.ok(membros.length > 40, "o payload tem o programa inteiro");
  for (const m of membros) {
    assert.ok(m.tipo === "0" || m.tipo === "5", `${m.nome} tem typeflag ${JSON.stringify(m.tipo)}; só arquivo (0) e diretório (5) são emitidos`);
    assert.equal(m.ustar, "ustar", `${m.nome} não declara o formato ustar`);
  }

  // Todo diretório aparece como membro próprio, ANTES de qualquer coisa que more nele.
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

  // O bit de execução vem do shebang; nada de setuid/setgid saindo daqui.
  const runner = membros.find((m) => m.nome === "bin/backup.js");
  assert.ok(runner, "os runners viajam no payload");
  assert.equal(runner.modo, 0o755, "um runner com shebang precisa sair executável");
  assert.ok(membros.every((m) => (m.modo & 0o6000) === 0), "nenhum membro pode carregar setuid/setgid");
});

test("cadeia completa: construir, assinar, publicar e atualizar de verdade", async (t) => {
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
    "o digest precisa ser conferido contra o manifesto assinado"
  );

  // A versão nova está no disco, o ponteiro apontando para ela, e a anterior guardada.
  const instaladoEm = path.join(instalacao, "versoes", NOVA);
  assert.ok(fs.existsSync(path.join(instaladoEm, "console.js")));
  assert.ok(fs.existsSync(path.join(instaladoEm, "src", "servidor.js")));
  const info = atualizador.lerEstadoInstalacao();
  assert.equal(info.versaoAtiva, NOVA);
  assert.equal(info.versaoAnterior, "0.0.1");
  assert.equal(info.transacao.etapa, "concluida", "nenhuma transação fica pendente depois do sucesso");
  assert.ok(!fs.existsSync(path.join(instalacao, "descargas", NOVA)), "a área de estágio é limpa");

  // E a reversão volta o ponteiro sem rede nenhuma: o servidor de release já está fechado.
  await servidor.fechar();
  const volta = await atualizador.reverter();
  assert.equal(volta.ok, true, volta.erro);
  assert.equal(atualizador.lerEstadoInstalacao().versaoAtiva, "0.0.1");
});

test("um manifesto adulterado depois de assinado é recusado", async (t) => {
  const saida = ajuda.dirTemporario("console-dist-");
  const chaves = ajuda.dirTemporario("console-chave-");
  t.after(() => {
    for (const d of [saida, chaves]) fs.rmSync(d, { recursive: true, force: true });
  });

  construir(ajuda.RAIZ, saida);
  const par = gerarChave(chaves);
  assinar(path.join(saida, "manifesto.json"), par.privada);

  // Trocar o digest mantendo a assinatura antiga é exatamente o ataque que a assinatura existe
  // para impedir: apontar um release legítimo para outro conteúdo.
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

test("um artefato trocado no servidor não passa pelo digest do manifesto assinado", async (t) => {
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

  // O manifesto e a assinatura continuam íntegros; quem foi trocado foi o arquivo servido.
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
  assert.ok(!fs.existsSync(path.join(instalacao, "versoes", NOVA)), "nada é instalado quando o digest não confere");
  assert.equal(atualizador.lerEstadoInstalacao().versaoAtiva, "0.0.1", "o ponteiro não se move");
});

test("sem chave de publicação provisionada, o console diz isso em vez de aceitar qualquer release", async (t) => {
  const amb = ajuda.ambiente({ env: { CONSOLE_CHAVE_RELEASE: undefined } });
  t.after(() => amb.restaurar());
  const release = require(path.join(ajuda.RAIZ, "src", "release.js"));
  const atualizador = require(path.join(ajuda.RAIZ, "src", "atualizador.js"));

  assert.equal(release.CHAVE_PUBLICA_OFICIAL, null, "nenhuma chave de produção fica no repositório");
  assert.equal(release.confianciaConfigurada(), false);
  const r = await atualizador.verificarPublicacao({ forcar: true });
  assert.equal(r.ok, false);
  assert.equal(r.naoConfigurado, true);
  assert.match(r.motivo, /chave pública/);
});

test("a ferramenta de assinatura recusa manifesto que já nasce expirado", (t) => {
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
  assert.ok(!fs.existsSync(`${manifesto}.sig`), "nada é assinado");
});

test("a chave privada de publicação nunca vem de argumento de linha de comando", () => {
  const fonte = fs.readFileSync(path.join(ajuda.RAIZ, "empacotar", "assinar-manifesto.js"), "utf8");
  // `--chave` recebe um CAMINHO; o material da chave vem de arquivo ou da variável de ambiente.
  assert.match(fonte, /CONSOLE_CHAVE_PRIVADA/);
  assert.ok(!/--chave-conteudo|--chave-privada-conteudo|--segredo/.test(fonte), "não pode existir opção que receba a chave em argv");
});

test("o .deb é montado no formato ar que o dpkg entende", (t) => {
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

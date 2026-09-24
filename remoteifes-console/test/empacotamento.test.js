const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { execFileSync } = require("child_process");
const ajuda = require("./ajuda");
const { criarAutoridade, atestarDiretorio, confiarEm } = require("./support/atestacoes");
const { listarDependencias } = require("../instalacao/dependencias");

// Cadeia completa de distribuição: construir → atestar → publicar → atualizar → verificar.
//
// É o teste que impede a falha clássica de empacotamento: o artefato existe, o manifesto existe,
// e mesmo assim a atualização não funciona porque o formato do pacote não casa com o extrator,
// ou porque a atestação nunca foi realmente conferida contra o conteúdo baixado. As atestações
// vêm de um Sigstore privado de teste, no lugar do GitHub Actions (test/support/atestacoes.js).

const ARVORE = ["console.js", "launcher.js", "package.json", "package-lock.json", "ARQUITETURA.md", "DISTRIBUICAO.md", "src", "bin", "web", "instalacao", "helper", "systemd", "empacotar"];
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

let autoridade;
test.before(async () => {
  autoridade = await criarAutoridade();
});

/**
 * Cópia do console numa versão escolhida, para que a publicação seja mais nova que a instalada. Leva
 * as dependências de produção, como um checkout depois de `npm ci --omit=dev`.
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

/** Uma cópia fora do Git informa o seu commit; o próprio checkout o obtém do Git. */
function construir(raizFonte, saida, extra = []) {
  const commit = raizFonte === ajuda.RAIZ ? [] : ["--commit", COMMIT];
  execFileSync(process.execPath, [path.join(raizFonte, "empacotar", "construir.js"), "--saida", saida, ...commit, ...extra], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 300_000,
  });
}

/** Construir e atestar, como a publicação de um release faz. */
async function release(raizFonte, saida, extra = []) {
  construir(raizFonte, saida, extra);
  return atestarDiretorio(autoridade, saida);
}

/** Um ambiente do console que confia no Sigstore de teste. */
function ambienteConfiando(t, env) {
  const amb = ajuda.ambiente({ env });
  const desfazer = confiarEm(amb, autoridade);
  t.after(() => {
    desfazer();
    amb.restaurar();
  });
  return amb;
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
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ajuda.RAIZ, encoding: "utf8" }).trim();
  assert.equal(manifesto.commit, head, "o manifesto nomeia o commit construído; a atestação precisa nomear o mesmo");
  assert.equal(require(path.join(ajuda.RAIZ, "src", "release.js")).validarEstrutura(manifesto).ok, true, "um manifesto que o console aceita");

  // O build não atesta nada e não tem identidade: isso é feito depois, na publicação do release.
  assert.ok(!fs.existsSync(path.join(saida, "atestacao.sigstore.json")));

  const proveniencia = JSON.parse(fs.readFileSync(path.join(saida, "proveniencia.json"), "utf8"));
  assert.equal(proveniencia.assinaturaDeCodigo, false, "nenhuma assinatura de código da plataforma é declarada");
  assert.match(proveniencia.observacao, /SEM ASSINATURA DE CÓDIGO/);
  assert.equal(proveniencia.commit, head);
  assert.ok(proveniencia.artefatos.every((a) => /^[0-9a-f]{64}$/.test(a.sha256)));
  execFileSync(process.execPath, [path.join(ajuda.RAIZ, "empacotar", "conferir-proveniencia.js"), saida], { stdio: "pipe" });
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
  // O verificador de releases entra, e o mock do Sigstore, só de teste, não.
  assert.ok(fs.existsSync(path.join(destino, "node_modules", "@sigstore", "verify", "package.json")));
  assert.ok(fs.existsSync(path.join(destino, "node_modules", "@sigstore", "tuf", "seeds.json")), "a raiz do Sigstore de que ele parte");
  assert.ok(!fs.existsSync(path.join(destino, "node_modules", "@sigstore", "mock")), "pacotes só de teste ficam de fora");
  assert.ok(!fs.existsSync(path.join(destino, "node_modules", ".bin")));
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

test("cadeia completa: construir, atestar, publicar e atualizar de verdade", async (t) => {
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

  // A versão nova está no disco com o seu verificador, o ponteiro apontando para ela, e a anterior
  // guardada.
  const instaladoEm = path.join(instalacao, "versoes", NOVA);
  assert.ok(fs.existsSync(path.join(instaladoEm, "console.js")));
  assert.ok(fs.existsSync(path.join(instaladoEm, "src", "servidor.js")));
  assert.ok(fs.existsSync(path.join(instaladoEm, "node_modules", "@sigstore", "verify", "package.json")), "a próxima atualização também pode ser verificada");
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

test("importação offline instala de verdade, sem rede nenhuma", async (t) => {
  // Um Pi sem Internet recebe manifesto, atestação e artefato em pendrive. Antes isto apenas
  // verificava e mandava "usar a ação de atualização" — que vai à rede: um beco sem saída
  // exatamente no caso que a função existe para atender.
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

test("importação offline recusa artefato adulterado e não instala nada", async (t) => {
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

test("importação offline de um release que a raiz do Sigstore não reconhece não instala nada", async (t) => {
  const NOVA = "99.9.6";
  const fonte = arvoreNaVersao(NOVA);
  const saida = ajuda.dirTemporario("console-dist-");
  const instalacao = instalacaoCom("0.0.1");
  t.after(() => {
    for (const d of [fonte, saida, instalacao]) fs.rmSync(d, { recursive: true, force: true });
  });
  const manifesto = await release(fonte, saida);
  // Sem confiança de teste aqui: a raiz do próprio console (a do Sigstore real) não conhece a CA de
  // teste.
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

test("um manifesto alterado depois da atestação é recusado", async (t) => {
  const saida = ajuda.dirTemporario("console-dist-");
  t.after(() => fs.rmSync(saida, { recursive: true, force: true }));

  await release(ajuda.RAIZ, saida);

  // Trocar um digest mantendo a atestação é exatamente o ataque que a atestação existe para
  // impedir: apontar um release legítimo para outro conteúdo.
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

test("um artefato trocado no servidor não passa pelo digest do manifesto atestado", async (t) => {
  const NOVA = "99.9.1";
  const fonte = arvoreNaVersao(NOVA);
  const saida = ajuda.dirTemporario("console-dist-");
  const instalacao = instalacaoCom("0.0.1");
  t.after(() => {
    for (const d of [fonte, saida, instalacao]) fs.rmSync(d, { recursive: true, force: true });
  });

  await release(fonte, saida);

  // O manifesto e a atestação continuam íntegros; quem foi trocado foi o arquivo servido.
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

test("um console instalado verifica releases sem nenhuma etapa de configuração", (t) => {
  // Nada a provisionar na instalação, no bootstrap ou no primeiro acesso: a política de identidade é
  // código, e a raiz do Sigstore de que o console parte viaja nas suas próprias dependências.
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

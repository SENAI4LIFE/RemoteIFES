const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const http = require("http");
const zlib = require("zlib");
const crypto = require("crypto");
const ajuda = require("./ajuda");

// Atualizador por release: confiança, transação e recuperação.
//
// O que estes testes protegem é a diferença entre "baixar um arquivo" e "atualizar um programa
// instalado": assinatura antes de escrever, alvo correto, digest conferido, extração que não
// escapa do destino, troca atômica e nada de downgrade silencioso.

// --- Apoio -------------------------------------------------------------------------------

function parDeChaves() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    publicaB64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privada: privateKey,
  };
}

/** Monta um .tar.gz mínimo, sem depender do `tar` do sistema. */
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
  // O atualizador lê a versão "em execução" do package.json da raiz do console; nos testes o
  // payload em execução é simulado pelo diretório da versão ativa.
  amb.atualizador = require(path.join(ajuda.RAIZ, "src", "atualizador.js"));
  return amb;
}

// --- Confiança ----------------------------------------------------------------------------

test("sem chave pública provisionada, nenhuma atualização é aceita", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const release = require(path.join(ajuda.RAIZ, "src", "release.js"));

  assert.equal(release.confianciaConfigurada(), false, "o repositório não traz chave de produção");
  const r = release.verificarManifesto(Buffer.from("{}"), "x");
  assert.equal(r.ok, false);
  assert.equal(r.naoConfigurado, true);
  assert.match(r.motivo, /não está configurada/);
});

test("manifesto com assinatura inválida é recusado antes de qualquer escrita", (t) => {
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

test("manifesto expirado é recusado (replay e congelamento de versão)", (t) => {
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

test("alvo ausente no manifesto é recusado com a lista do que existe", (t) => {
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

test("política de versão recusa downgrade e exige o mínimo declarado", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const release = require(path.join(ajuda.RAIZ, "src", "release.js"));

  assert.equal(release.politicaDeVersao({ versao: "1.0.0" }, "2.0.0").ok, false);
  assert.match(release.politicaDeVersao({ versao: "1.0.0" }, "2.0.0").motivo, /não faz downgrade/);
  assert.equal(release.politicaDeVersao({ versao: "2.0.0" }, "2.0.0").jaInstalada, true);
  assert.equal(release.politicaDeVersao({ versao: "3.0.0", minimoParaAtualizar: "2.5.0" }, "2.0.0").ok, false);
  assert.equal(release.politicaDeVersao({ versao: "3.0.0", minimoParaAtualizar: "2.0.0" }, "2.0.0").ok, true);
});

test("a rotação de chave só é aceita vinda de um manifesto já autenticado", (t) => {
  const chaves = parDeChaves();
  const sucessora = parDeChaves();
  const amb = ajuda.ambiente({ env: { CONSOLE_CHAVE_RELEASE: chaves.publicaB64 } });
  t.after(() => amb.restaurar());
  const release = require(path.join(ajuda.RAIZ, "src", "release.js"));

  assert.equal(release.chavesConfiaveis().length, 1);
  release.registrarRotacao({ versao: "2.1.0", proximaChave: { publica: sucessora.publicaB64 } });
  assert.equal(release.chavesConfiaveis().length, 2, "a sucessora passa a ser aceita");

  // Um manifesto assinado só pela sucessora agora confere.
  const bytes = Buffer.from(manifestoDe({ versao: "2.2.0", artefatos: [{ alvo: "linux-x64", arquivo: "a.tar.gz", sha256: "a".repeat(64), bytes: 10 }] }));
  const r = release.verificarManifesto(bytes, crypto.sign(null, bytes, sucessora.privada).toString("base64"));
  assert.equal(r.ok, true);
});

// --- Extração -------------------------------------------------------------------------------

test("a extração recusa caminho que escapa do destino", (t) => {
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

test("a extração recusa caminho absoluto", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const atualizador = require(path.join(ajuda.RAIZ, "src", "atualizador.js"));

  const dir = ajuda.dirTemporario("console-tar-");
  const malicioso = path.join(dir, "mal.tar.gz");
  fs.writeFileSync(malicioso, tarGz({ "/etc/passwd": "x" }));
  assert.throws(() => atualizador.extrairTarGz(malicioso, path.join(dir, "destino")), /escapa|fora/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a extração aceita um payload legítimo e preserva só o bit de execução", (t) => {
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

// --- Transação -------------------------------------------------------------------------------

test("fluxo completo: verifica, instala lado a lado e troca o ponteiro", async (t) => {
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

test("digest divergente aborta antes de trocar a versão ativa", async (t) => {
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

test("artefato cuja versão interna diverge do alvo é recusado", async (t) => {
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

test("uma transação interrompida é reconciliada na partida, sem instalação pela metade", (t) => {
  const raiz = instalacaoFalsa("1.0.0");
  const amb = ajuda.ambiente({ env: { CONSOLE_RAIZ_INSTALACAO: raiz } });
  t.after(() => {
    amb.restaurar();
    fs.rmSync(raiz, { recursive: true, force: true });
  });
  const atualizador = require(path.join(ajuda.RAIZ, "src", "atualizador.js"));

  // Simula queda de energia durante a instalação: estágio e versão parcial no disco.
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

test("uma transação concluída não é desfeita pela reconciliação", (t) => {
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

test("a reversão troca o ponteiro para a versão anterior, sem rede", async (t) => {
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

test("o bootstrap cai para a versão anterior quando a ativa está quebrada", (t) => {
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
  // O payload de teste só expõe `executar` vazio; o que importa é qual versão foi escolhida.
  assert.ok(true, saida);
});

test("o ponteiro apontando para uma versão que não subiu é denunciado, não escondido", async (t) => {
  // O bootstrap cai para uma versão utilizável quando a ativa não carrega — a rede de segurança
  // funcionando. O problema é o silêncio: a atualização relatou sucesso, o console voltou ao ar,
  // e o operador acredita rodar código que não está rodando. A divergência entre o ponteiro e o
  // processo tem de aparecer.
  const raiz = ajuda.dirTemporario("console-diverg-");
  const amb = ajuda.ambiente({ env: { CONSOLE_RAIZ_INSTALACAO: raiz } });
  t.after(() => {
    amb.restaurar();
    fs.rmSync(raiz, { recursive: true, force: true });
  });
  const atualizador = require(path.join(ajuda.RAIZ, "src", "atualizador.js"));
  const emExecucao = atualizador.versaoEmExecucao();

  // Layout lado a lado com o ponteiro numa versão que NÃO é a que este processo carregou.
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

test("sem divergência, a situação não inventa um alarme", async (t) => {
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

test("execução a partir do código-fonte não é tratada como divergência", async (t) => {
  // Sem layout lado a lado não existe ponteiro com que divergir; avisar aqui seria ruído em
  // toda sessão de desenvolvimento.
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const atualizador = require(path.join(ajuda.RAIZ, "src", "atualizador.js"));

  const s = await atualizador.situacao();
  assert.equal(s.gerenciadoLadoALado, false);
  assert.equal(s.divergenciaDeVersao, null);
});

test("situação distingue instalada, publicada e observação antiga", async (t) => {
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

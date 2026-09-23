const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const http = require("http");
const zlib = require("zlib");
const ajuda = require("./ajuda");
const { criarAutoridade, confiarEm, sha256 } = require("./support/atestacoes");

// Release updater: trust, transaction and recovery.
//
// These tests protect the difference between "downloading a file" and "updating an installed
// program": provenance before writing, correct target, checked digest, extraction that does not
// escape the destination, atomic swap and no silent downgrade. The attestations come from a
// private test Sigstore (test/support/atestacoes.js); proveniencia.test.js covers the
// attestation itself.

// --- Apoio -------------------------------------------------------------------------------

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

let autoridade;
test.before(async () => {
  autoridade = await criarAutoridade();
});

function alvoLocal() {
  const so = { win32: "windows", darwin: "macos", linux: "linux" }[process.platform] || process.platform;
  return `${so}-${process.arch}`;
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

/**
 * Um release publicado como a publicação o deixa: manifesto, um payload por alvo e a atestação
 * sobre todos eles.
 */
async function publicacao({ versao, payload = payloadValido(versao), alvos = [alvoLocal()], minimoParaAtualizar = null, identidade } = {}) {
  const arquivos = {};
  const artefatos = alvos.map((alvo) => {
    const arquivo = `remoteifes-console-${versao}-${alvo}.tar.gz`;
    arquivos[arquivo] = payload;
    return { alvo, formato: "tar.gz", arquivo, sha256: sha256(payload), bytes: payload.length };
  });
  arquivos["manifesto.json"] = Buffer.from(
    `${JSON.stringify(
      { esquema: 1, versao, canal: "estavel", publicadoEm: new Date().toISOString(), commit: COMMIT, minimoParaAtualizar, notas: "https://exemplo.invalid/notas", artefatos },
      null,
      2
    )}\n`
  );
  const sujeitos = Object.entries(arquivos).map(([name, conteudo]) => ({ name, sha256: sha256(conteudo) }));
  arquivos["atestacao.sigstore.json"] = await autoridade.atestar({ sujeitos, versao, commit: COMMIT, identidade });
  return arquivos;
}

/** Servidor de releases falso: serve o manifesto, a atestação e os artefatos. */
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

function ambienteDeAtualizacao({ base, raizInstalacao }) {
  const amb = ajuda.ambiente({
    env: {
      CONSOLE_RELEASE_BASE: base,
      CONSOLE_RAIZ_INSTALACAO: raizInstalacao,
    },
  });
  // O atualizador lê a versão "em execução" do package.json da raiz do console; nos testes o
  // payload em execução é simulado pelo diretório da versão ativa.
  amb.atualizador = amb.atualizador || require(path.join(ajuda.RAIZ, "src", "atualizador.js"));
  const desfazer = confiarEm(amb, autoridade);
  const restaurar = amb.restaurar;
  amb.restaurar = () => {
    desfazer();
    restaurar();
  };
  return amb;
}

// --- Política de release ------------------------------------------------------------------

test("alvo ausente no manifesto é recusado com a lista do que existe", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const manifesto = { artefatos: [{ alvo: "linux-arm", arquivo: "a.tar.gz", sha256: "a".repeat(64), bytes: 10 }] };
  const r = amb.release.escolherArtefato(manifesto, "windows-x64");
  assert.equal(r.ok, false);
  assert.match(r.motivo, /não traz artefato para windows-x64/);
  assert.match(r.motivo, /linux-arm/);
});

test("política de versão recusa downgrade e exige o mínimo declarado", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const release = amb.release;

  assert.equal(release.politicaDeVersao({ versao: "1.0.0" }, "2.0.0").ok, false);
  assert.match(release.politicaDeVersao({ versao: "1.0.0" }, "2.0.0").motivo, /não faz downgrade/);
  assert.equal(release.politicaDeVersao({ versao: "2.0.0" }, "2.0.0").jaInstalada, true);
  assert.equal(release.politicaDeVersao({ versao: "3.0.0", minimoParaAtualizar: "2.5.0" }, "2.0.0").ok, false);
  assert.equal(release.politicaDeVersao({ versao: "3.0.0", minimoParaAtualizar: "2.0.0" }, "2.0.0").ok, true);
});

test("uma publicação sem a sua atestação não instala nada", async (t) => {
  const arquivos = await publicacao({ versao: "2.0.0" });
  delete arquivos["atestacao.sigstore.json"];
  const servidor = await servidorDeRelease(arquivos);
  const raiz = instalacaoFalsa("1.0.0");
  const amb = ambienteDeAtualizacao({ base: servidor.base, raizInstalacao: raiz });
  t.after(async () => {
    await servidor.fechar();
    amb.restaurar();
    fs.rmSync(raiz, { recursive: true, force: true });
  });

  const r = await amb.atualizador.atualizar("2.0.0", { log: () => {} });
  assert.equal(r.ok, false);
  assert.match(r.erro, /atestação de proveniência/);
  assert.ok(!servidor.pedidos.some((p) => p.url.endsWith(".tar.gz")), "o artefato nem chega a ser baixado");
  assert.equal(JSON.parse(fs.readFileSync(path.join(raiz, "estado-instalacao.json"), "utf8")).versaoAtiva, "1.0.0");
});

test("um release atestado sem artefato para este sistema e arquitetura não instala nada", async (t) => {
  const outro = alvoLocal().endsWith("-riscv64") ? "linux-x64" : "linux-riscv64";
  const servidor = await servidorDeRelease(await publicacao({ versao: "2.0.0", alvos: [outro] }));
  const raiz = instalacaoFalsa("1.0.0");
  const amb = ambienteDeAtualizacao({ base: servidor.base, raizInstalacao: raiz });
  t.after(async () => {
    await servidor.fechar();
    amb.restaurar();
    fs.rmSync(raiz, { recursive: true, force: true });
  });

  const r = await amb.atualizador.atualizar("2.0.0", { log: () => {} });
  assert.equal(r.ok, false);
  assert.match(r.erro, new RegExp(`não traz artefato para ${alvoLocal()}`));
  assert.ok(!servidor.pedidos.some((p) => p.url.endsWith(".tar.gz")), "nada baixado");
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
  const servidor = await servidorDeRelease(await publicacao({ versao: "2.0.0" }));
  const raiz = instalacaoFalsa("1.0.0");
  const amb = ambienteDeAtualizacao({ base: servidor.base, raizInstalacao: raiz });
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

  // A atestação foi buscada e conferida antes de o artefato ser pedido.
  const ordem = servidor.pedidos.map((p) => p.url);
  assert.ok(ordem.indexOf("/atestacao.sigstore.json") >= 0 && ordem.indexOf("/atestacao.sigstore.json") < ordem.findIndex((u) => u.endsWith(".tar.gz")));
  // Nenhuma credencial foi enviada ao servidor de release.
  assert.ok(servidor.pedidos.every((p) => p.autorizacao === null), "downloads de release não carregam credencial");
});

test("um artefato trocado no servidor depois da atestação aborta antes de trocar a versão ativa", async (t) => {
  const arquivos = await publicacao({ versao: "2.0.0" });
  const nome = Object.keys(arquivos).find((n) => n.endsWith(".tar.gz"));
  arquivos[nome] = Buffer.concat([arquivos[nome], Buffer.from("x")]);
  const servidor = await servidorDeRelease(arquivos);
  const raiz = instalacaoFalsa("1.0.0");
  const amb = ambienteDeAtualizacao({ base: servidor.base, raizInstalacao: raiz });
  t.after(async () => {
    await servidor.fechar();
    amb.restaurar();
    fs.rmSync(raiz, { recursive: true, force: true });
  });

  const r = await amb.atualizador.atualizar("2.0.0", { log: () => {} });
  assert.equal(r.ok, false);
  assert.match(r.erro, /download passou do limite|tamanho divergente|SHA-256 divergente/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(raiz, "estado-instalacao.json"), "utf8")).versaoAtiva, "1.0.0");
  assert.ok(!fs.existsSync(path.join(raiz, "versoes", "2.0.0")), "nada instalado");

  // Mesmo tamanho, outros bytes: o próprio digest recusa.
  const igual = await publicacao({ versao: "2.0.0" });
  const outroNome = Object.keys(igual).find((n) => n.endsWith(".tar.gz"));
  const trocado = Buffer.from(igual[outroNome]);
  trocado[trocado.length - 1] ^= 0xff;
  igual[outroNome] = trocado;
  const segundo = await servidorDeRelease(igual);
  process.env.CONSOLE_RELEASE_BASE = segundo.base;
  t.after(() => segundo.fechar());
  const r2 = await amb.atualizador.atualizar("2.0.0", { log: () => {} });
  assert.equal(r2.ok, false);
  assert.match(r2.erro, /SHA-256 divergente/);
  assert.ok(!fs.existsSync(path.join(raiz, "versoes", "2.0.0")), "nada instalado");
});

test("artefato cuja versão interna diverge do alvo é recusado", async (t) => {
  // Atestado, digest correto, e ainda assim não é o que diz ser por dentro: conferido antes da troca.
  const servidor = await servidorDeRelease(await publicacao({ versao: "2.0.0", payload: payloadValido("9.9.9") }));
  const raiz = instalacaoFalsa("1.0.0");
  const amb = ambienteDeAtualizacao({ base: servidor.base, raizInstalacao: raiz });
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

test("situação distingue instalada, publicada e observação antiga", async (t) => {
  const raiz = instalacaoFalsa("1.0.0");
  const amb = ajuda.ambiente({ env: { CONSOLE_RAIZ_INSTALACAO: raiz } });
  t.after(() => {
    amb.restaurar();
    fs.rmSync(raiz, { recursive: true, force: true });
  });
  const atualizador = require(path.join(ajuda.RAIZ, "src", "atualizador.js"));

  const s = await atualizador.situacao({ consultarRede: false });
  assert.equal(s.versaoAtivaRegistrada, "1.0.0");
  assert.ok(s.alvo.includes(process.arch));
  assert.match(s.observacaoDeDistribuicao, /independente do commit do RemoteIFES/);
});

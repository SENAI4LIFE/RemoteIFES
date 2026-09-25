const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { execFileSync, spawn } = require("child_process");

/**
 * Runs a Console runner without blocking the event loop. `execFileSync` would freeze the test
 * process and the fake application with it, and the runner would see a silent /health as a harness
 * artifact rather than because the application actually stopped.
 */
function rodarRunner(script, args, env) {
  return new Promise((resolve) => {
    const filho = spawn(process.execPath, [path.join(ajuda.RAIZ, "bin", script), ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let saida = "";
    filho.stdout.on("data", (d) => (saida += d));
    filho.stderr.on("data", (d) => (saida += d));
    filho.on("close", (codigo) => resolve({ codigo, saida }));
  });
}
const ajuda = require("./helpers");

// Impact assessment before interrupting, and database restore safety.

function checkoutComDados({ porta }) {
  const raiz = ajuda.dirTemporario("console-dados-");
  const servidor = path.join(raiz, "remoteifes-server");
  fs.mkdirSync(path.join(servidor, "data", "backups"), { recursive: true });
  fs.writeFileSync(path.join(servidor, "package.json"), JSON.stringify({ version: "3.0.0" }));
  fs.writeFileSync(path.join(servidor, ".env"), `PORTA=${porta}
`);

  // The restore runner reuses the checkout's real backupService on purpose: it guarantees a
  // consistent snapshot, integrity_check, pre-restore copy and rollback. The test checkout receives
  // exactly those files, without the rest of the server.
  const origem = path.join(ajuda.RAIZ, "..", "remoteifes-server");
  for (const relativo of [
    ["src", "config", "paths.js"],
    ["src", "utils", "logger.js"],
    ["src", "services", "backupService.js"],
  ]) {
    const destino = path.join(servidor, ...relativo);
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.copyFileSync(path.join(origem, ...relativo), destino);
  }
  return raiz;
}

/**
 * Fake application: answers /health and /manutencao/prontidao like the real one.
 */
function aplicacaoFalsa(prontidao, { saudavel = true } = {}) {
  let token = null;
  const servidor = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(saudavel ? 200 : 503, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: saudavel, banco: "ok", ambiente: "production", commit: "a".repeat(40), uptimeSegundos: 120 }));
    }
    if (req.url === "/manutencao/prontidao") {
      if (prontidao === null) {
        res.writeHead(404, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false }));
      }
      const header = req.headers.authorization || "";
      if (token && header !== `Bearer ${token}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false }));
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, em: new Date().toISOString(), ...prontidao }));
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    servidor.listen(0, "127.0.0.1", () =>
      resolve({
        porta: servidor.address().port,
        definirToken: (t) => {
          token = t;
        },
        fechar: () => new Promise((r) => servidor.close(() => r())),
      })
    );
  });
}

test("the readiness contract secret is created with restricted permissions", async (t) => {
  const app = await aplicacaoFalsa({ dispositivos: { conectados: 0, canaisDeComando: 0 }, ota: { ativos: 0, porFase: {} }, rollout: null });
  const checkout = checkoutComDados({ porta: app.porta });
  const amb = ajuda.ambiente({ checkout });
  t.after(async () => {
    await app.fechar();
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  const token = amb.prontidao.garantirTokenProntidao();
  assert.ok(token.length >= 32);
  const arquivo = amb.prontidao.caminhoTokenProntidao();
  assert.ok(fs.existsSync(arquivo));
  assert.ok(!path.resolve(arquivo).includes("remoteifes-console"), "the secret lives in the application's data/, which reads it");
  // Calling again does not change the secret (changing it would invalidate the application's
  // in-flight read).
  assert.equal(amb.prontidao.garantirTokenProntidao(), token);
});

test("an application without the readiness contract yields 'unknown', never zero", async (t) => {
  const app = await aplicacaoFalsa(null);
  const checkout = checkoutComDados({ porta: app.porta });
  const amb = ajuda.ambiente({ checkout });
  t.after(async () => {
    await app.fechar();
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  amb.prontidao.garantirTokenProntidao();
  const avaliacao = await amb.prontidao.avaliar({ interrompeServico: true });
  const desconhecido = avaliacao.avisos.find((a) => a.titulo === "Atividade dos ESP32 desconhecida");
  assert.ok(desconhecido, "the missing contract must become an explicit warning");
  assert.match(desconhecido.detalhe, /trate como desconhecido, não como zero/);
  assert.equal(avaliacao.contexto.prontidaoObservavel, false);
});

test("OTA in the validando phase blocks the interruption", async (t) => {
  const app = await aplicacaoFalsa({
    dispositivos: { conectados: 3, canaisDeComando: 2, salas: [] },
    // `validando` is exactly the phase monitoramentoService leaves out when counting
    // otaEmAndamento; here it must count.
    ota: { ativos: 1, porFase: { ofertado: 0, baixando: 0, gravado: 0, reiniciando: 0, validando: 1 }, salas: ["A-101"] },
    rollout: null,
  });
  const checkout = checkoutComDados({ porta: app.porta });
  const amb = ajuda.ambiente({ checkout });
  t.after(async () => {
    await app.fechar();
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  amb.prontidao.garantirTokenProntidao();
  const avaliacao = await amb.prontidao.avaliar({ interrompeServico: true });
  assert.equal(avaliacao.pronto, false);
  const bloqueio = avaliacao.bloqueios.find((b) => b.titulo === "Atualização de firmware em andamento");
  assert.ok(bloqueio, "OTA em validando tem de bloquear");
  assert.match(bloqueio.detalhe, /validando: 1/);
});

test("a paused rollout with pending work becomes a warning; an active one blocks", async (t) => {
  const pausado = await aplicacaoFalsa({
    dispositivos: { conectados: 0, canaisDeComando: 0, salas: [] },
    ota: { ativos: 0, porFase: {}, salas: [] },
    rollout: { ativo: false, estado: "pausado", pausado: true, versao: "4.1.0", pendentes: 7 },
  });
  const checkout = checkoutComDados({ porta: pausado.porta });
  const amb = ajuda.ambiente({ checkout });
  t.after(async () => {
    await pausado.fechar();
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  amb.prontidao.garantirTokenProntidao();
  const avaliacao = await amb.prontidao.avaliar({ interrompeServico: true });
  const aviso = avaliacao.avisos.find((a) => a.titulo.includes("pausada com trabalho pendente"));
  assert.ok(aviso, "a paused rollout with pending work must not disappear from the assessment");
  assert.match(aviso.detalhe, /7 pendente/);
  assert.match(aviso.detalhe, /volta a mexer nos dispositivos/);
});

test("a paused rollout with a device still in flight blocks, not just warns", async (t) => {
  // Pausing the rollout does not recall devices already writing: an ESP32 in "atualizando",
  // "reiniciando" or "validando" stays in flight. Restarting the service at that instant risks a
  // device that does not come back, so this blocks.
  const pausado = await aplicacaoFalsa({
    dispositivos: { conectados: 0, canaisDeComando: 0, salas: [] },
    ota: { ativos: 0, porFase: {}, salas: [] },
    rollout: { ativo: false, estado: "pausado", pausado: true, versao: "4.1.0", pendentes: 0, emAndamento: 2 },
  });
  const checkout = checkoutComDados({ porta: pausado.porta });
  const amb = ajuda.ambiente({ checkout });
  t.after(async () => {
    await pausado.fechar();
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  amb.prontidao.garantirTokenProntidao();
  const avaliacao = await amb.prontidao.avaliar({ interrompeServico: true });
  const bloqueio = avaliacao.bloqueios.find((b) => b.titulo.includes("em atualização"));
  assert.ok(bloqueio, `a device in flight must block. Assessment: ${JSON.stringify(avaliacao)}`);
  assert.match(bloqueio.detalhe, /2 em voo/);
  assert.match(bloqueio.detalhe, /Espere os dispositivos em voo terminarem/);
});

test("the command channel is distinguished from presence in the hub", async (t) => {
  const app = await aplicacaoFalsa({
    dispositivos: { conectados: 10, canaisDeComando: 4, salas: [] },
    ota: { ativos: 0, porFase: {}, salas: [] },
    rollout: null,
  });
  const checkout = checkoutComDados({ porta: app.porta });
  const amb = ajuda.ambiente({ checkout });
  t.after(async () => {
    await app.fechar();
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  amb.prontidao.garantirTokenProntidao();
  const avaliacao = await amb.prontidao.avaliar({ interrompeServico: true });
  const info = avaliacao.informacoes.find((i) => i.titulo.includes("canal de comandos"));
  assert.ok(info);
  assert.match(info.detalhe, /4 de 10 presentes/);
  assert.match(info.detalhe, /reconectam sozinhos/);
});

test("an operation in progress blocks another", async (t) => {
  const app = await aplicacaoFalsa({ dispositivos: { conectados: 0, canaisDeComando: 0, salas: [] }, ota: { ativos: 0, porFase: {}, salas: [] }, rollout: null });
  const checkout = checkoutComDados({ porta: app.porta });
  const amb = ajuda.ambiente({ checkout });
  t.after(async () => {
    await app.fechar();
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  fs.writeFileSync(
    path.join(amb.estadoDir, "trabalhos.json"),
    JSON.stringify({ trabalhos: [{ id: "x", acao: "atualizacao.aplicar", rotulo: "Atualizar", estado: "executando", iniciadoEm: new Date().toISOString(), pid: process.pid }] })
  );
  const avaliacao = await amb.prontidao.avaliar({ interrompeServico: true });
  assert.equal(avaliacao.pronto, false);
  assert.ok(avaliacao.bloqueios.some((b) => b.titulo === "Operação do console em andamento"));
});

test("user sessions are described as recent activity, not an exact count", async (t) => {
  const app = await aplicacaoFalsa({ dispositivos: { conectados: 0, canaisDeComando: 0, salas: [] }, ota: { ativos: 0, porFase: {}, salas: [] }, rollout: null });
  const checkout = checkoutComDados({ porta: app.porta });
  const amb = ajuda.ambiente({ checkout });
  t.after(async () => {
    await app.fechar();
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  amb.prontidao.garantirTokenProntidao();
  const avaliacao = await amb.prontidao.avaliar({ interrompeServico: true });
  const sessoes = avaliacao.informacoes.find((i) => i.titulo.toLowerCase().includes("sessõe"));
  assert.ok(sessoes);
  assert.match(sessoes.detalhe, /desconhecid|não a contagem exata/i);
});

// --- Backup and restore -------------------------------------------------------------------

function criarBancoDeTeste(caminho, { usuarios = 1 } = {}) {
  const { DatabaseSync } = require("node:sqlite");
  fs.mkdirSync(path.dirname(caminho), { recursive: true });
  const db = new DatabaseSync(caminho);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE IF NOT EXISTS usuarios (id INTEGER PRIMARY KEY, usuario TEXT, nivel INTEGER)");
  db.exec("CREATE TABLE IF NOT EXISTS salas (id INTEGER PRIMARY KEY, sala TEXT)");
  db.exec("CREATE TABLE IF NOT EXISTS configuracoes (chave TEXT PRIMARY KEY, valor TEXT)");
  db.exec("CREATE TABLE IF NOT EXISTS agendamentos (id INTEGER PRIMARY KEY, ativo INTEGER)");
  db.exec("CREATE TABLE IF NOT EXISTS relatos (id INTEGER PRIMARY KEY)");
  db.exec("CREATE TABLE IF NOT EXISTS sessoes (id INTEGER PRIMARY KEY, usuarioId INTEGER, logout TEXT)");
  for (let i = 0; i < usuarios; i += 1) {
    db.prepare("INSERT INTO usuarios (usuario, nivel) VALUES (?, ?)").run(`u${i}`, 3);
  }
  db.close();
}

test("a corrupted candidate is refused before touching the current database", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());

  const backupService = require(path.join(ajuda.RAIZ, "..", "remoteifes-server", "src", "services", "backupService"));
  const dir = ajuda.dirTemporario("console-bkp-");
  const ruim = path.join(dir, "remoteifes-20260101-010101-abcdef.db");
  fs.writeFileSync(ruim, "isto não é um banco SQLite");

  assert.throws(() => backupService.verificarArquivoBackup(ruim), /.+/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a backup without users is refused (an empty database indicates corruption)", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());

  const backupService = require(path.join(ajuda.RAIZ, "..", "remoteifes-server", "src", "services", "backupService"));
  const dir = ajuda.dirTemporario("console-bkp-");
  const vazio = path.join(dir, "remoteifes-20260101-010101-abcdef.db");
  criarBancoDeTeste(vazio, { usuarios: 0 });

  assert.throws(() => backupService.verificarArquivoBackup(vazio), /nenhum usuário/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the restore runner refuses a traversal identifier before any effect", (t) => {
  const checkout = checkoutComDados({ porta: 8188 });
  const amb = ajuda.ambiente({ checkout });
  t.after(() => {
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  const dados = path.join(checkout, "remoteifes-server", "data");
  criarBancoDeTeste(path.join(dados, "remoteifes.db"), { usuarios: 2 });
  const antes = fs.readFileSync(path.join(dados, "remoteifes.db"));

  const barra = String.fromCharCode(92);
  for (const ruim of ["../../../etc/passwd", "/etc/passwd", "remoteifes-x.db; rm -rf /", `..${barra}..${barra}x.db`]) {
    let saida = "";
    let codigo = 0;
    try {
      saida = execFileSync(process.execPath, [path.join(ajuda.RAIZ, "bin", "restaurar.js"), ruim], {
        encoding: "utf8",
        env: { ...process.env, CONSOLE_CHECKOUT_DIR: checkout, CONSOLE_ESTADO_DIR: amb.estadoDir, CONSOLE_SEM_PRIVILEGIO: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (erro) {
      saida = `${erro.stdout || ""}${erro.stderr || ""}`;
      codigo = erro.status;
    }
    assert.equal(codigo, 2, `should refuse ${ruim} as an invalid argument`);
    assert.match(saida, /recusado|não encontrado/i);
  }
  assert.deepEqual(fs.readFileSync(path.join(dados, "remoteifes.db")), antes, "nada pode ser tocado numa recusa de argumento");
});

test("restore requires quiescence: with the application running it installs nothing", async (t) => {
  const app = await aplicacaoFalsa({ dispositivos: { conectados: 0, canaisDeComando: 0, salas: [] }, ota: { ativos: 0, porFase: {}, salas: [] }, rollout: null });
  const checkout = checkoutComDados({ porta: app.porta });
  const amb = ajuda.ambiente({ checkout });
  t.after(async () => {
    await app.fechar();
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  const dados = path.join(checkout, "remoteifes-server", "data");
  const banco = path.join(dados, "remoteifes.db");
  criarBancoDeTeste(banco, { usuarios: 2 });
  const antes = fs.readFileSync(banco);

  criarBancoDeTeste(path.join(dados, "backups", "remoteifes-20260101-010101-abcdef.db"), { usuarios: 1 });

  const { codigo, saida } = await rodarRunner("restaurar.js", ["remoteifes-20260101-010101-abcdef.db"], {
    CONSOLE_CHECKOUT_DIR: checkout,
    CONSOLE_ESTADO_DIR: amb.estadoDir,
    CONSOLE_SEM_PRIVILEGIO: "1",
  });

  assert.equal(codigo, 1, `without being able to stop the application, restore must fail. Output:\n${saida}`);
  // Without lifecycle control on this platform and with the application answering, restore refuses
  // instead of assuming that /health silence proves there is no writer.
  assert.match(saida, /continua respondendo e o console não tem como pará-la/);
  assert.ok(!/Instalando o backup/.test(saida), "nothing may be installed without proven quiescence");
  assert.deepEqual(fs.readFileSync(banco), antes, "the current database must not be touched when quiescence fails");
  assert.ok(!fs.existsSync(`${banco}.incoming-`), "no intermediate file may remain");
});

test("observing the database neither creates nor changes files in the data directory", (t) => {
  const checkout = checkoutComDados({ porta: 8188 });
  const amb = ajuda.ambiente({ checkout });
  t.after(() => {
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  const dados = path.join(checkout, "remoteifes-server", "data");

  // No database: observing must not create it.
  const semBanco = amb.coleta.espiarBanco();
  assert.equal(semBanco.existe, false);
  assert.ok(!fs.existsSync(path.join(dados, "remoteifes.db")), "observing must not create the database");

  criarBancoDeTeste(path.join(dados, "remoteifes.db"), { usuarios: 3 });
  // The creator closed the connection; -shm and -wal are not left behind.
  const antes = fs.readdirSync(dados).sort();

  // With the application stopped (default), content reads are refused on purpose: opening a WAL
  // database would create -shm/-wal from a process that should only observe.
  const espiada = amb.coleta.espiarBanco();
  assert.equal(espiada.existe, true);
  assert.equal(espiada.lido, false);
  assert.match(espiada.erro, /criaria arquivos auxiliares/);
  assert.equal(espiada.bytes > 0, true, "the file metadata stays available");
  assert.deepEqual(fs.readdirSync(dados).sort(), antes, "nenhum arquivo novo pode aparecer");

  // With the application running the Console reads content: the database is already open by another
  // process.
  const comPermissao = amb.coleta.espiarBanco({ permitirLeitura: true });
  assert.equal(comPermissao.lido, true);
  assert.equal(comPermissao.usuarios, 3);
});

test("the backup scope is declared honestly", async (t) => {
  const checkout = checkoutComDados({ porta: 8188 });
  const amb = ajuda.ambiente({ checkout });
  const s = await ajuda.subir(amb);
  t.after(async () => {
    await s.fechar();
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  const sessao = await ajuda.autenticar(amb, s.porta);
  const r = await ajuda.pedir(s.porta, "/api/backups", { cookie: sessao.cookie, origem: s.base });
  assert.equal(r.status, 200);
  assert.match(r.json.escopo, /Não incluem \.env/);
  assert.match(r.json.escopo, /credenciais de dispositivo/);
});

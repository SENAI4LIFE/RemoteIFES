// Ciclo de vida do processo do servidor: startup, encerramento gracioso por sinal e porta ocupada.
// A entrega de sinais POSIX não existe no Windows, então o teste dispara o mesmo handler
// dentro do processo filho (process.emit) — o caminho de encerramento exercitado é o real.
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const RAIZ = path.join(__dirname, "..");
const PRELOAD = path.join(os.tmpdir(), `remoteifes-lifecycle-preload-${process.pid}.js`);

fs.writeFileSync(
  PRELOAD,
  `process.on("message", (m) => { if (m && m.encerrar) process.emit(m.encerrar); });\n`
);

test.after(() => {
  try {
    fs.rmSync(PRELOAD, { force: true });
  } catch (erro) {
    /* arquivo temporário já removido */
  }
});

function portaLivre() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "0.0.0.0", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function ocupar(porta) {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(porta, "0.0.0.0", () => resolve(s));
  });
}

function iniciar(porta, extras = {}) {
  const filho = spawn(process.execPath, ["-r", PRELOAD, "server.js"], {
    cwd: RAIZ,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: {
      ...process.env,
      PORTA: String(porta),
      NODE_ENV: "development",
      SERVIR_FRONTEND: "false",
      REMOTEIFES_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "remoteifes-lifecycle-")),
      ...extras,
    },
  });
  let saida = "";
  filho.stdout.on("data", (d) => { saida += d; });
  filho.stderr.on("data", (d) => { saida += d; });
  const encerrado = new Promise((resolve) => filho.on("exit", (code) => resolve(code)));
  return { filho, encerrado, texto: () => saida };
}

async function esperar(condicao, ms = 20000) {
  const limite = Date.now() + ms;
  while (Date.now() < limite) {
    if (await condicao()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function saudavel(porta) {
  try {
    const resp = await fetch(`http://127.0.0.1:${porta}/health`);
    return resp.ok && (await resp.json()).ok === true;
  } catch (erro) {
    return false;
  }
}

for (const sinal of ["SIGINT", "SIGTERM"]) {
  test(`${sinal} encerra o servidor com graciosidade e devolve a porta`, async () => {
    const porta = await portaLivre();
    const servidor = iniciar(porta);

    assert.ok(await esperar(() => saudavel(porta)), "o servidor deveria responder em /health");

    servidor.filho.send({ encerrar: sinal });
    const codigo = await servidor.encerrado;
    assert.equal(codigo, 0, `saída limpa após ${sinal}: ${servidor.texto()}`);
    assert.ok(
      servidor.texto().includes(`[shutdown] {"sinal":"${sinal}"}`),
      `o encerramento gracioso deveria ser registrado: ${servidor.texto()}`
    );
    assert.doesNotMatch(servidor.texto(), /uncaught-exception/);

    // A porta precisa estar realmente liberada para um novo startup imediato.
    const liberada = await ocupar(porta);
    await new Promise((r) => liberada.close(r));

    const reinicio = iniciar(porta);
    assert.ok(await esperar(() => saudavel(porta)), "o servidor deveria subir de novo na mesma porta");
    reinicio.filho.send({ encerrar: "SIGTERM" });
    assert.equal(await reinicio.encerrado, 0);
  });
}

test("porta ocupada produz erro objetivo, sem stack de exceção não tratada", async () => {
  const porta = await portaLivre();
  const bloqueio = await ocupar(porta);
  try {
    const servidor = iniciar(porta);
    const codigo = await servidor.encerrado;
    assert.equal(codigo, 1);
    const texto = servidor.texto();
    assert.match(texto, new RegExp(`Porta ${porta} já está em uso`));
    assert.doesNotMatch(texto, /at Server\.|Error: listen EADDRINUSE/);
  } finally {
    await new Promise((r) => bloqueio.close(r));
  }
});

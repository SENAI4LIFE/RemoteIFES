// Server process lifecycle: startup, graceful shutdown on signal and port in use. POSIX signal
// delivery does not exist on Windows, so the test triggers the same handler inside the child
// process (process.emit); the shutdown path exercised is the real one.
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
    /* temporary file already removed */
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
  test(`${sinal} shuts the server down gracefully and releases the port`, async () => {
    const porta = await portaLivre();
    const servidor = iniciar(porta);

    assert.ok(await esperar(() => saudavel(porta)), "the server should answer on /health");

    servidor.filho.send({ encerrar: sinal });
    const codigo = await servidor.encerrado;
    assert.equal(codigo, 0, `clean exit after ${sinal}: ${servidor.texto()}`);
    assert.ok(
      servidor.texto().includes(`[shutdown] {"sinal":"${sinal}"}`),
      `the graceful shutdown should be logged: ${servidor.texto()}`
    );
    assert.doesNotMatch(servidor.texto(), /uncaught-exception/);

    // The port must actually be released for an immediate new startup.
    const liberada = await ocupar(porta);
    await new Promise((r) => liberada.close(r));

    const reinicio = iniciar(porta);
    assert.ok(await esperar(() => saudavel(porta)), "the server should start again on the same port");
    reinicio.filho.send({ encerrar: "SIGTERM" });
    assert.equal(await reinicio.encerrado, 0);
  });
}

test("a port in use produces a clear error, without an unhandled exception stack", async () => {
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

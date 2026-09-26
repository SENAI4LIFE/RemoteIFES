const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const net = require("net");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const ajuda = require("./helpers");

// The Console listens on loopback only; from another machine the way in is an SSH tunnel to the
// local port. These tests hold that in both listening modes: a direct TCP bind (CONSOLE_BIND) and
// the socket systemd passes under activation.

const CONSOLE = path.join(ajuda.RAIZ, "console.js");

function portaLivre() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function aceitaIpv6() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(0, "::1", () => s.close(() => resolve(true)));
  });
}

// An isolated state directory and a throwaway checkout: a starting Console writes its readiness
// token into the application's data directory.
function ambienteDoProcesso(porta, extra = {}) {
  const estado = ajuda.dirTemporario("console-bind-estado-");
  const checkout = ajuda.dirTemporario("console-bind-checkout-");
  fs.mkdirSync(path.join(checkout, "remoteifes-server"), { recursive: true });
  const env = {
    ...process.env,
    CONSOLE_ESTADO_DIR: estado,
    CONSOLE_CHECKOUT_DIR: checkout,
    CONSOLE_SEM_PRIVILEGIO: "1",
    CONSOLE_PORTA: String(porta),
    CONSOLE_OCIOSIDADE_S: "0",
  };
  for (const chave of ["LISTEN_FDS", "LISTEN_PID", "CONSOLE_BIND", "CONSOLE_HOSTS", "CONSOLE_INICIADO_PELO_LANCADOR"]) delete env[chave];
  return { estado, env: { ...env, ...extra } };
}

function iniciar(env, stdioExtra = []) {
  const filho = spawn(process.execPath, [CONSOLE], { env, stdio: ["ignore", "pipe", "pipe", ...stdioExtra] });
  filho.saida = "";
  filho.stdout.on("data", (d) => (filho.saida += d));
  filho.stderr.on("data", (d) => (filho.saida += d));
  filho.fim = new Promise((resolve) => filho.on("close", (codigo) => resolve(codigo)));
  return filho;
}

function comPrazo(promessa, ms, descricao) {
  let relogio;
  return Promise.race([
    promessa.finally(() => clearTimeout(relogio)),
    new Promise((_, reject) => (relogio = setTimeout(() => reject(new Error(`timed out: ${descricao}`)), ms))),
  ]);
}

function pedir(host, porta, cabecalhoHost) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port: porta, path: "/api/sessao", method: "GET", headers: { Host: cabecalhoHost }, timeout: 3000 }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

// Waits until the Console answers, or fails as soon as the process exits.
async function aguardarResposta(filho, host, porta, cabecalhoHost) {
  const limite = Date.now() + 20_000;
  for (;;) {
    if (filho.exitCode !== null) throw new Error(`the Console exited (${filho.exitCode}) before answering:\n${filho.saida}`);
    try {
      return await pedir(host, porta, cabecalhoHost);
    } catch {}
    if (Date.now() > limite) throw new Error(`no answer from ${host}:${porta}:\n${filho.saida}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function encerrar(filho) {
  if (filho.exitCode === null) filho.kill();
  await comPrazo(filho.fim, 10_000, "Console exit");
}

function conectaEm(porta) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port: porta });
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
}

test("the default bind is IPv4 loopback", () => {
  const amb = ajuda.ambiente({ env: { CONSOLE_BIND: undefined } });
  try {
    assert.equal(amb.config.ENDERECO, "127.0.0.1");
    assert.equal(amb.config.enderecoLoopback(amb.config.ENDERECO), true);
  } finally {
    amb.restaurar();
  }
});

test("only loopback addresses pass; wildcard, LAN, public addresses and hostnames do not", () => {
  const amb = ajuda.ambiente();
  try {
    const { enderecoLoopback } = amb.config;
    for (const aceito of ["127.0.0.1", "127.0.0.2", "::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1"]) {
      assert.equal(enderecoLoopback(aceito), true, `${aceito} is loopback`);
    }
    for (const recusado of [
      "0.0.0.0", "::", "0:0:0:0:0:0:0:0",
      "192.168.1.10", "10.20.30.40", "172.16.0.5", "169.254.1.1", "::ffff:192.168.1.10", "fe80::1", "fd00::1",
      "203.0.113.7", "8.8.8.8", "2001:db8::1",
      "localhost", "console.example", "", " 127.0.0.1", "127.0.0.1:8099", undefined, null,
    ]) {
      assert.equal(enderecoLoopback(recusado), false, `${JSON.stringify(recusado)} must be refused`);
    }
  } finally {
    amb.restaurar();
  }
});

test("a non-loopback CONSOLE_BIND is refused before anything listens or is written", async () => {
  for (const endereco of ["0.0.0.0", "::", "192.168.1.10", "203.0.113.7", "localhost"]) {
    const porta = await portaLivre();
    // A Host list naming the address does not make the bind acceptable.
    const { estado, env } = ambienteDoProcesso(porta, { CONSOLE_BIND: endereco, CONSOLE_HOSTS: `${endereco}:${porta}` });
    const filho = iniciar(env);
    const codigo = await comPrazo(filho.fim, 15_000, `refusal of ${endereco}`);
    assert.notEqual(codigo, 0, `${endereco}: the Console must exit with an error\n${filho.saida}`);
    assert.deepEqual(fs.readdirSync(estado), [], `${endereco}: the refusal must come before any state or identity contract`);
    assert.equal(await conectaEm(porta), false, `${endereco}: nothing may be listening on the port`);
  }
});

test("a loopback bind serves on the local port an SSH tunnel forwards to", async () => {
  const porta = await portaLivre();
  const { estado, env } = ambienteDoProcesso(porta, { CONSOLE_BIND: "127.0.0.1" });
  const filho = iniciar(env);
  try {
    const status = await aguardarResposta(filho, "127.0.0.1", porta, `127.0.0.1:${porta}`);
    assert.ok(status < 500 && status !== 421, `unexpected status ${status}`);
    // Host header protection is unchanged: another name is still refused.
    assert.equal(await pedir("127.0.0.1", porta, `console.example:${porta}`), 421);
    assert.ok(fs.existsSync(path.join(estado, "endereco.json")), "the identity contract the launcher checks is published");
  } finally {
    await encerrar(filho);
  }
});

test("IPv6 loopback is accepted where the host has it", async (t) => {
  if (!(await aceitaIpv6())) return t.skip("this host cannot bind ::1");
  const porta = await portaLivre();
  const { env } = ambienteDoProcesso(porta, { CONSOLE_BIND: "::1" });
  const filho = iniciar(env);
  try {
    const status = await aguardarResposta(filho, "::1", porta, `[::1]:${porta}`);
    assert.ok(status < 500 && status !== 421, `unexpected status ${status}`);
  } finally {
    await encerrar(filho);
  }
});

test("the installed systemd socket listens on loopback only", () => {
  const amb = ajuda.ambiente();
  try {
    const modelo = fs.readFileSync(path.join(ajuda.RAIZ, "systemd", "remoteifes-console.socket.modelo"), "utf8");
    // The installer substitutes only the validated port (instalar.js refuses anything else).
    const unidade = modelo.split("__PORTA__").join("8099");
    const escutas = [...unidade.matchAll(/^\s*(Listen\w+)\s*=\s*(.*?)\s*$/gm)];
    assert.equal(escutas.length, 1, "exactly one listening directive");
    const [, diretiva, valor] = escutas[0];
    assert.equal(diretiva, "ListenStream");
    // A bare port would listen on every interface, so the address must be explicit.
    const partes = valor.match(/^(?:\[([^\]]+)\]|([^:\s]+)):(\d+)$/);
    assert.ok(partes, `ListenStream must name an address and a port: ${valor}`);
    assert.ok(amb.config.enderecoLoopback(partes[1] || partes[2]), `ListenStream is not loopback: ${valor}`);
    assert.equal(partes[3], "8099");
    assert.doesNotMatch(unidade, /^\s*(FreeBind|BindToDevice)\s*=/m);
    const servico = fs.readFileSync(path.join(ajuda.RAIZ, "systemd", "remoteifes-console.service.modelo"), "utf8");
    assert.doesNotMatch(servico, /CONSOLE_BIND/, "the service must not override the address systemd listens on");
  } finally {
    amb.restaurar();
  }
});

test(
  "under socket activation a non-loopback inherited socket is refused before any request",
  { skip: process.platform === "win32" && "listen({ fd }) is not available on Windows" },
  async () => {
    for (const [endereco, aceito] of [["0.0.0.0", false], ["127.0.0.1", true]]) {
      const socket = net.createServer();
      await new Promise((resolve, reject) => {
        socket.once("error", reject);
        socket.listen(0, endereco, resolve);
      });
      const porta = socket.address().port;
      // As systemd does: the listening socket arrives as descriptor 3 with LISTEN_FDS=1.
      const { estado, env } = ambienteDoProcesso(porta, { LISTEN_FDS: "1" });
      const filho = iniciar(env, [socket._handle.fd]);
      socket.close(); // the child holds its own copy of the listening socket
      try {
        if (aceito) {
          const status = await aguardarResposta(filho, "127.0.0.1", porta, `127.0.0.1:${porta}`);
          assert.ok(status < 500 && status !== 421, `unexpected status ${status}`);
        } else {
          const codigo = await comPrazo(filho.fim, 15_000, "refusal of the inherited socket");
          assert.notEqual(codigo, 0, filho.saida);
          assert.equal(fs.existsSync(path.join(estado, "endereco.json")), false, "no identity contract for a refused socket");
        }
      } finally {
        await encerrar(filho);
      }
    }
  }
);

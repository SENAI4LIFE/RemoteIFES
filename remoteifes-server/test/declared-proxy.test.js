process.env.REMOTEIFES_DB_PATH = ":memory:";
process.env.NODE_ENV = "production";
process.env.SENHA_ADMIN_INICIAL = "proxy-declarado-123";
process.env.TRUST_PROXY = "1";
delete process.env.CORS_ORIGIN;

const http = require("http");
const test = require("node:test");
const assert = require("node:assert/strict");
const WebSocket = require("ws");

const app = require("../src/app");
const statusHub = require("../src/services/statusHub");
const configuracoesService = require("../src/services/configuracoesService");

// The canonical proxy setup (lan-setup.sh / https-setup.sh: one nginx, TRUST_PROXY=1): the client is
// the address the proxy forwards, for the HTTP API and for the browser WebSocket alike.

let server;
let base;
let porta;

test.before(async () => {
  configuracoesService.validarEAtualizar({ redesAutorizadas: ["10.0.0.0/8"] }, { id: "test", nivel: 3 }, { infraestrutura: true });
  server = http.createServer(app);
  statusHub.iniciar(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  porta = server.address().port;
  base = `http://127.0.0.1:${porta}`;
});

test.after(async () => {
  statusHub.encerrar();
  await new Promise((resolve) => server.close(resolve));
});

const login = (cliente) =>
  fetch(`${base}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": cliente },
    body: JSON.stringify({ usuario: "superadmin", senha: "senha-errada-qualquer" }),
  });

function abrirWs(cliente) {
  const ws = new WebSocket(`ws://127.0.0.1:${porta}/ws`, { headers: { "X-Forwarded-For": cliente } });
  return new Promise((resolve) => {
    ws.once("message", () => {
      ws.close();
      resolve("aceito");
    });
    ws.once("close", (codigo) => resolve(codigo));
    ws.once("error", (erro) => resolve(`error:${erro.message}`));
  });
}

test("behind a declared proxy, a forwarded client inside the ranges is admitted over HTTP and WebSocket", async () => {
  assert.equal((await login("10.1.2.3")).status, 401, "reaches the login (wrong password), not the network refusal");
  assert.equal(await abrirWs("10.1.2.3"), "aceito");
});

test("behind a declared proxy, a forwarded client outside the ranges is refused over HTTP and WebSocket", async () => {
  assert.equal((await login("203.0.113.10")).status, 403);
  assert.equal(await abrirWs("203.0.113.10"), 4003);
});

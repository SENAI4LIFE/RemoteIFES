process.env.REMOTEIFES_DB_PATH = ":memory:";
process.env.NODE_ENV = "production";
process.env.SENHA_ADMIN_INICIAL = "proxy-nao-declarado-123";
process.env.TRUST_PROXY = "0";
delete process.env.CORS_ORIGIN;

const http = require("http");
const test = require("node:test");
const assert = require("node:assert/strict");
const WebSocket = require("ws");

const app = require("../src/app");
const statusHub = require("../src/services/statusHub");
const configuracoesService = require("../src/services/configuracoesService");
const { proxyLocalNaoDeclarado } = require("../src/utils/rede");
const { saltosDeProxy } = require("../src/config/proxy");

// A reverse proxy on the same host with TRUST_PROXY left at 0 makes every client look like
// 127.0.0.1, which the network restriction always admits. Such requests (loopback peer carrying a
// forwarding header) are judged by the authorized ranges alone; plain loopback (SSH tunnel, watchdog,
// Operations Console) keeps its exemption.

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

const login = (cabecalhos = {}) =>
  fetch(`${base}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...cabecalhos },
    body: JSON.stringify({ usuario: "superadmin", senha: "senha-errada-qualquer" }),
  });

function abrirWs(cabecalhos = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${porta}/ws`, { headers: cabecalhos });
  return new Promise((resolve) => {
    ws.once("message", () => {
      ws.close();
      resolve("aceito");
    });
    ws.once("close", (codigo) => resolve(codigo));
    ws.once("error", (erro) => resolve(`error:${erro.message}`));
  });
}

test("plain loopback keeps its exemption from the network restriction", async () => {
  assert.equal((await login()).status, 401, "reaches the login (wrong password), not the network refusal");
  assert.equal(await abrirWs(), "aceito");
});

test("a loopback peer carrying forwarding headers while TRUST_PROXY declares no proxy is refused, even claiming an authorized address", async () => {
  for (const cabecalhos of [
    { "X-Forwarded-For": "203.0.113.10" },
    { "X-Forwarded-For": "10.1.2.3" },
    { Forwarded: "for=10.1.2.3" },
    { "X-Real-IP": "10.1.2.3" },
  ]) {
    const resposta = await login(cabecalhos);
    assert.equal(resposta.status, 403, JSON.stringify(cabecalhos));
    assert.equal(await abrirWs(cabecalhos), 4003, JSON.stringify(cabecalhos));
  }
});

test("TRUST_PROXY is a hop count, and when a request counts as coming through an undeclared local proxy", () => {
  for (const [valor, saltos] of [[undefined, 0], ["", 0], ["0", 0], [" 1 ", 1], ["2", 2]]) assert.equal(saltosDeProxy(valor), saltos, String(valor));
  // Values outside the documented contract fall back to 0 (with a warning) everywhere at once,
  // instead of meaning one thing to Express and another to the WebSocket.
  for (const valor of ["loopback", "true", "false", "10.0.0.0/8", "-1", "1.5", "33", "99999999999999999999"]) assert.equal(saltosDeProxy(valor), 0, valor);
  assert.equal(saltosDeProxy("32"), 32);

  const xff = { "x-forwarded-for": "10.1.2.3" };
  assert.equal(proxyLocalNaoDeclarado(xff, "127.0.0.1", 0), true);
  assert.equal(proxyLocalNaoDeclarado(xff, "::ffff:127.0.0.1", 0), true);
  assert.equal(proxyLocalNaoDeclarado(xff, "::1", 0), true);
  assert.equal(proxyLocalNaoDeclarado({}, "127.0.0.1", 0), false, "no forwarding header: a local client");
  assert.equal(proxyLocalNaoDeclarado(xff, "10.9.9.9", 0), false, "a remote peer is judged by its own address; the header is ignored");
  assert.equal(proxyLocalNaoDeclarado(xff, "127.0.0.1", 1), false, "a declared proxy is resolved by Express as before");
});

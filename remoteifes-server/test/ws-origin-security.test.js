process.env.REMOTEIFES_DB_PATH = ":memory:";
process.env.NODE_ENV = "production";
process.env.SENHA_ADMIN_INICIAL = "ws-origin-test-pass-123";
delete process.env.CORS_ORIGIN;

const http = require("http");
const test = require("node:test");
const assert = require("node:assert/strict");
const WebSocket = require("ws");

const app = require("../src/app");
const statusHub = require("../src/services/statusHub");
const configuracoesService = require("../src/services/configuracoesService");

let server;
let port;

test.before(async () => {
  configuracoesService.validarEAtualizar({ redesAutorizadas: ["10.0.0.0/8"] }, { id: "test", nivel: 3 });
  server = http.createServer(app);
  statusHub.iniciar(server);
  await new Promise((resolve) => server.listen(0, resolve));
  port = server.address().port;
});

test.after(async () => {
  statusHub.encerrar();
  await new Promise((resolve) => server.close(resolve));
});

test("WebSocket rejeita origem de outro site quando CORS_ORIGIN não foi configurado", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: "https://origem-nao-autorizada.example" });
  const codigo = await new Promise((resolve, reject) => {
    ws.once("error", reject);
    ws.once("close", resolve);
  });
  assert.equal(codigo, 4003);
});

test("WebSocket aceita conexão da mesma origem sem CORS_ORIGIN (operação same-origin)", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: `http://127.0.0.1:${port}` });
  const resultado = await new Promise((resolve) => {
    ws.once("open", () => resolve("open"));
    ws.once("close", (c) => resolve(`close:${c}`));
    ws.once("error", (e) => resolve(`error:${e.message}`));
  });
  ws.close();
  assert.equal(resultado, "open");
});

test("WebSocket rejeita origem com o mesmo host, mas outro protocolo", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: `https://127.0.0.1:${port}` });
  const codigo = await new Promise((resolve, reject) => {
    ws.once("error", reject);
    ws.once("close", resolve);
  });
  assert.equal(codigo, 4003);
});

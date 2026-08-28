process.env.REMOTEIFES_DB_PATH = ":memory:";
process.env.NODE_ENV = "production";
delete process.env.CORS_ORIGIN;

const http = require("http");
const test = require("node:test");
const assert = require("node:assert/strict");
const WebSocket = require("ws");

const app = require("../src/app");
const statusHub = require("../src/services/statusHub");

let server;
let baseWsUrl;

test.before(async () => {
  server = http.createServer(app);
  statusHub.iniciar(server);
  await new Promise((resolve) => server.listen(0, resolve));
  baseWsUrl = `ws://127.0.0.1:${server.address().port}/ws`;
});

test.after(async () => {
  statusHub.encerrar();
  await new Promise((resolve) => server.close(resolve));
});

test("WebSocket rejeita origem não autorizada quando CORS_ORIGIN não foi configurado", async () => {
  const ws = new WebSocket(baseWsUrl, { origin: "https://origem-nao-autorizada.example" });
  const codigo = await new Promise((resolve, reject) => {
    ws.once("error", reject);
    ws.once("close", resolve);
  });
  assert.equal(codigo, 4003);
});

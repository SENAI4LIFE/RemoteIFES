process.env.REMOTEIFES_DB_PATH = ":memory:";
process.env.NODE_ENV = "test";

const http = require("http");
const test = require("node:test");
const assert = require("node:assert/strict");

const app = require("../src/app");

let server;
let baseUrl;

test.before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test("/health responde 200 com o estado do banco e do processo", async () => {
  const resp = await fetch(`${baseUrl}/health`);
  assert.equal(resp.status, 200);
  assert.equal(resp.headers.get("content-type").split(";")[0], "application/json");
  const corpo = await resp.json();
  assert.equal(corpo.ok, true);
  assert.equal(corpo.banco, "ok");
  assert.equal(corpo.servico, "RemoteIFES API");
  assert.equal(typeof corpo.uptimeSegundos, "number");
  assert.ok(corpo.uptimeSegundos >= 0);
});

test("/health não depende de nenhum ESP32 e não exige autenticação", async () => {
  const resp = await fetch(`${baseUrl}/health`, { headers: { Authorization: "" } });
  assert.equal(resp.status, 200);
  const corpo = await resp.json();
  assert.equal(corpo.ok, true);
  assert.ok(!("esp32" in corpo) && !("dispositivos" in corpo));
});

test("/health reporta 503 quando o banco está indisponível", async () => {
  const db = require("../src/config/database");
  db.close();
  const resp = await fetch(`${baseUrl}/health`);
  assert.equal(resp.status, 503);
  const corpo = await resp.json();
  assert.equal(corpo.ok, false);
  assert.equal(corpo.banco, "erro");
});

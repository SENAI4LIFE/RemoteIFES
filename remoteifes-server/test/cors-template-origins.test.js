process.env.REMOTEIFES_DB_PATH = ":memory:";
process.env.NODE_ENV = "production";
process.env.SENHA_ADMIN_INICIAL = "cors-template-test-pass-123";
// The line the old .env.example shipped, as an installation created from it still has it, plus one
// origin the operator really configured.
process.env.CORS_ORIGIN = "https://exemplo.com,https://outro-exemplo.com, https://frontend.example";

const fs = require("fs");
const path = require("path");
const http = require("http");
const test = require("node:test");
const assert = require("node:assert/strict");
const WebSocket = require("ws");

const app = require("../src/app");
const statusHub = require("../src/services/statusHub");

let server;
let base;
let porta;

test.before(async () => {
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

// A refused socket is closed after the upgrade, so "open" fires either way: an accepted one is told
// the server status first, a refused one only gets the close code.
function abrirWs(origem) {
  const ws = new WebSocket(`ws://127.0.0.1:${porta}/ws`, { origin: origem });
  return new Promise((resolve) => {
    ws.once("message", () => {
      ws.close();
      resolve("aceito");
    });
    ws.once("close", (codigo) => resolve(codigo));
    ws.once("error", (erro) => resolve(`error:${erro.message}`));
  });
}

test("the origins the old .env.example shipped are refused even while CORS_ORIGIN still lists them", async () => {
  for (const origem of ["https://exemplo.com", "https://outro-exemplo.com"]) {
    const resposta = await fetch(`${base}/health`, { headers: { Origin: origem } });
    assert.equal(resposta.status, 403, origem);
    assert.equal(resposta.headers.get("access-control-allow-origin"), null, origem);
    assert.equal(await abrirWs(origem), 4003, origem);
  }
});

test("an origin the operator configured keeps working over HTTP and WebSocket", async () => {
  const resposta = await fetch(`${base}/health`, { headers: { Origin: "https://frontend.example" } });
  assert.equal(resposta.status, 200);
  assert.ok(resposta.headers.get("access-control-allow-origin"));
  assert.equal(await abrirWs("https://frontend.example"), "aceito");
});

test("the .env.example template carries no active CORS_ORIGIN and none of the old example domains", () => {
  const modelo = fs.readFileSync(path.join(__dirname, "..", ".env.example"), "utf8");
  assert.doesNotMatch(modelo, /^\s*CORS_ORIGIN\s*=/m);
  assert.doesNotMatch(modelo, /exemplo\.com/);
});

test("responses ended early by CORS or by the body parser carry the security headers", async () => {
  const respostas = [
    await fetch(`${base}/health`, { headers: { Origin: "https://origem-alheia.example" } }),
    await fetch(`${base}/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{ isto não é json" }),
    await fetch(`${base}/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ usuario: "x".repeat(200 * 1024) }) }),
  ];
  assert.deepEqual(respostas.map((r) => r.status), [403, 400, 413]);
  for (const resposta of respostas) {
    assert.equal(resposta.headers.get("x-content-type-options"), "nosniff", String(resposta.status));
    assert.equal(resposta.headers.get("x-frame-options"), "DENY", String(resposta.status));
    assert.equal(resposta.headers.get("referrer-policy"), "same-origin", String(resposta.status));
    assert.ok(resposta.headers.get("content-security-policy"), String(resposta.status));
    assert.ok(resposta.headers.get("permissions-policy"), String(resposta.status));
  }
});

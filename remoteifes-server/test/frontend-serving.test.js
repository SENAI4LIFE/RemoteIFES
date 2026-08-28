process.env.REMOTEIFES_DB_PATH = ":memory:";
process.env.NODE_ENV = "production";
process.env.SERVIR_FRONTEND = "true";
process.env.FRONTEND_DIR = require("path").join(__dirname, "..", "..", "remoteifes-web");

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

test("GET / entrega o index.html do frontend na mesma origem", async () => {
  const resp = await fetch(`${baseUrl}/`);
  assert.equal(resp.status, 200);
  assert.match(resp.headers.get("content-type"), /text\/html/);
  const html = await resp.text();
  assert.match(html, /<title>RemoteIFES<\/title>/);
  assert.match(html, /src="js\/app\.js"/);
});

test("ativos estáticos do frontend são servidos com o tipo correto", async () => {
  const js = await fetch(`${baseUrl}/js/config.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type"), /javascript/);

  const manifest = await fetch(`${baseUrl}/manifest.webmanifest`);
  assert.equal(manifest.status, 200);
  assert.match(manifest.headers.get("content-type"), /manifest\+json/);
});

test("a CSP no modo frontend permite a própria origem para script, estilo e conexão", async () => {
  const resp = await fetch(`${baseUrl}/`);
  const csp = resp.headers.get("content-security-policy");
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /connect-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /default-src 'none'/);
});

test("HSTS não é enviado pela operação HTTP local", async () => {
  const resp = await fetch(`${baseUrl}/`);
  assert.equal(resp.headers.get("strict-transport-security"), null);
});

test("as rotas de API e /health continuam respondendo com o frontend ativo", async () => {
  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);

  const dispositivo = await fetch(`${baseUrl}/dispositivo/identificar`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.notEqual(dispositivo.status, 404);
});

test("CORS de produção aceita requisição da mesma origem sem CORS_ORIGIN configurado", async () => {
  const resp = await fetch(`${baseUrl}/health`, { headers: { Origin: baseUrl } });
  assert.equal(resp.status, 200);
  assert.equal((await resp.json()).ok, true);
});

test("CORS de produção bloqueia uma Origin de outro site", async () => {
  const resp = await fetch(`${baseUrl}/health`, { headers: { Origin: "https://site-externo.example" } });
  assert.equal(resp.status, 403);
});

test("CORS de produção rejeita origem com o mesmo host, mas outro protocolo", async () => {
  const resp = await fetch(`${baseUrl}/health`, { headers: { Origin: baseUrl.replace("http:", "https:") } });
  assert.equal(resp.status, 403);
});

test("o frontend carrega mesmo quando a API está bloqueada pela restrição de rede", async () => {
  const pagina = await fetch(`${baseUrl}/`);
  assert.equal(pagina.status, 200);

  const login = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usuario: "admin", senha: "x" }),
  });
  assert.equal(login.status, 403);
});

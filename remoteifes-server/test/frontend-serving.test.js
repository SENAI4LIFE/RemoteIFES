process.env.REMOTEIFES_DB_PATH = ":memory:";
process.env.NODE_ENV = "production";
process.env.SENHA_ADMIN_INICIAL = "frontend-test-pass-123";
process.env.SERVIR_FRONTEND = "true";
process.env.TRUST_PROXY = "1";
process.env.FRONTEND_DIR = require("path").join(__dirname, "..", "..", "remoteifes-web");

const http = require("http");
const test = require("node:test");
const assert = require("node:assert/strict");

const app = require("../src/app");
const db = require("../src/config/database");

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

test("a CSP nao permite JavaScript inline", async () => {
  const resposta = await fetch(baseUrl);
  const csp = resposta.headers.get("content-security-policy");
  assert.ok(csp.includes("script-src 'self'"));
  assert.equal(csp.includes("script-src 'self' 'unsafe-inline'"), false);
});

test("GET / entrega o index.html do frontend na mesma origem", async () => {
  const resp = await fetch(`${baseUrl}/`);
  assert.equal(resp.status, 200);
  assert.equal(resp.headers.get("x-powered-by"), null);
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

test("endpoints exclusivos do harness E2E não existem no servidor de produção", async () => {
  db.prepare("INSERT INTO configuracoes (chave, valor) VALUES ('modoTeste', 'true') ON CONFLICT(chave) DO UPDATE SET valor = 'true'").run();
  try {
    for (const rota of ["/__e2e/publicar-apk", "/__e2e/despublicar-apk", "/__e2e/encerrar"]) {
      const resp = await fetch(`${baseUrl}${rota}`, { method: "POST" });
      assert.equal(resp.status, 404, rota);
    }
  } finally {
    db.prepare("UPDATE configuracoes SET valor = 'false' WHERE chave = 'modoTeste'").run();
  }
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
    headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.10" },
    body: JSON.stringify({ usuario: "superadmin", senha: "x" }),
  });
  assert.equal(login.status, 403);
});

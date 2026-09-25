process.env.REMOTEIFES_DB_PATH = ":memory:";
process.env.NODE_ENV = "test";

const http = require("http");
const test = require("node:test");
const assert = require("node:assert/strict");

const db = require("../src/config/database");
const app = require("../src/app");
const usuariosService = require("../src/services/usuariosService");
const tokenService = require("../src/services/tokenService");
const { criarLimitador } = require("../src/utils/rateLimiter");

let server;
let baseUrl;
const SUPER = { nivel: 3 };

async function post(caminho, body, token) {
  return fetch(`${baseUrl}${caminho}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

function requisicaoFalsa(ip, extras = {}) {
  return { ip, headers: {}, ...extras };
}

function respostaFalsa() {
  const cabecalhos = {};
  const ouvintes = {};
  return {
    statusCode: 200,
    codigo: null,
    set(k, v) { cabecalhos[k] = v; },
    status(c) { this.codigo = c; this.statusCode = c; return this; },
    json() { return this; },
    on(evento, fn) { ouvintes[evento] = fn; },
    terminar(status) { this.statusCode = status; if (ouvintes.finish) ouvintes.finish(); },
    cabecalhos,
  };
}

function passa(limitar, req) {
  const res = respostaFalsa();
  let seguiu = false;
  limitar(req, res, () => { seguiu = true; });
  return { seguiu, res };
}

test.before(async () => {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((r) => server.close(r));
});

test("distinct users behind the same IP each have their own command budget; a single user stays limited", () => {
  const limitar = criarLimitador({ janelaMs: 60000, maxTentativas: 5, chave: (req) => req.usuario.id });
  for (let usuario = 1; usuario <= 19; usuario += 1) {
    for (let i = 0; i < 5; i += 1) {
      assert.equal(passa(limitar, requisicaoFalsa("10.0.0.1", { usuario: { id: usuario } })).seguiu, true, `usuário ${usuario} pedido ${i + 1}`);
    }
  }
  const excedido = passa(limitar, requisicaoFalsa("10.0.0.1", { usuario: { id: 1 } }));
  assert.equal(excedido.seguiu, false, "o sexto comando do mesmo usuário é recusado");
  assert.equal(excedido.res.codigo, 429);
  assert.ok(Number(excedido.res.cabecalhos["Retry-After"]) >= 1);
  assert.equal(passa(limitar, requisicaoFalsa("10.0.0.1", { usuario: { id: 21 } })).seguiu, true, "outro usuário do mesmo IP segue livre");
});

test("a single IP presenting itself as many principals hits the per-IP ceiling", () => {
  const limitar = criarLimitador({ janelaMs: 60000, maxTentativas: 5, tetoPorIp: 30, chave: (req) => req.usuario.id });
  let aceitos = 0;
  for (let usuario = 1; usuario <= 100; usuario += 1) {
    if (passa(limitar, requisicaoFalsa("10.0.0.2", { usuario: { id: usuario } })).seguiu) aceitos += 1;
  }
  assert.equal(aceitos, 30, "teto de abuso por IP independente do número de principais");
  assert.equal(passa(limitar, requisicaoFalsa("10.0.0.3", { usuario: { id: 1 } })).seguiu, true, "outro IP não é afetado");
});

test("without an identified principal the limit falls on the IP, as before", () => {
  const limitar = criarLimitador({ janelaMs: 60000, maxTentativas: 3, chave: () => null });
  assert.equal(passa(limitar, requisicaoFalsa("10.0.0.4")).seguiu, true);
  assert.equal(passa(limitar, requisicaoFalsa("10.0.0.4")).seguiu, true);
  assert.equal(passa(limitar, requisicaoFalsa("10.0.0.4")).seguiu, true);
  assert.equal(passa(limitar, requisicaoFalsa("10.0.0.4")).seguiu, false);
});

test("the login limit counts failures per IP: successful logins from a whole campus do not exhaust the budget, but 20 failures block", async () => {
  usuariosService.criar({ usuario: "nat-ok", senha: "SenhaNat12345", nome: "Nat", podeControlar: true }, SUPER);
  for (let i = 0; i < 30; i += 1) {
    const resp = await post("/login", { usuario: "nat-ok", senha: "SenhaNat12345" });
    assert.equal(resp.status, 200, `login legítimo ${i + 1} de um mesmo IP`);
  }
  for (let i = 0; i < 20; i += 1) {
    const resp = await post("/login", { usuario: "nat-ok", senha: "errada-errada" });
    assert.equal(resp.status, 401, `falha ${i + 1}`);
  }
  const bloqueado = await post("/login", { usuario: "nat-ok", senha: "SenhaNat12345" });
  assert.equal(bloqueado.status, 429, "após 20 falhas o IP fica bloqueado mesmo com a senha certa");
  assert.ok(Number(bloqueado.headers.get("retry-after")) > 0);
});

test("the command limit applies per authenticated user: 60 commands from each of two users on the same IP pass", async () => {
  const a = usuariosService.criar({ usuario: "nat-cmd-a", senha: "SenhaNat12345", nome: "A", podeControlar: true }, SUPER);
  const b = usuariosService.criar({ usuario: "nat-cmd-b", senha: "SenhaNat12345", nome: "B", podeControlar: true }, SUPER);
  const tokenA = tokenService.gerarToken(a.id);
  const tokenB = tokenService.gerarToken(b.id);
  for (let i = 0; i < 60; i += 1) {
    assert.equal((await post("/comando", { sala: "A-108", cmd: "temperatura", valor: 23 + (i % 3) }, tokenA)).status, 200);
    assert.equal((await post("/comando", { sala: "A-108", cmd: "temperatura", valor: 23 + (i % 3) }, tokenB)).status, 200);
  }
  assert.equal((await post("/comando", { sala: "A-108", cmd: "ligar" }, tokenA)).status, 429);
  assert.equal((await post("/comando", { sala: "A-108", cmd: "ligar" }, tokenB)).status, 429);
  const c = usuariosService.criar({ usuario: "nat-cmd-c", senha: "SenhaNat12345", nome: "C", podeControlar: true }, SUPER);
  assert.equal((await post("/comando", { sala: "A-108", cmd: "ligar" }, tokenService.gerarToken(c.id))).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM comandos_log WHERE sala = 'A-108'").get().n >= 121, true);
});

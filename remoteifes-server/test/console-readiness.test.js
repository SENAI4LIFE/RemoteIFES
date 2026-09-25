const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Readiness contract consumed by the Operations Console.
//
// Invariants:
//  - without the secret file the route does not exist (404), so installations without the Console
//    pay nothing and gain no surface;
//  - answers only on loopback, using the socket IP: TRUST_PROXY must not turn a remote client into
//    "local" through a header;
//  - requires the secret, compared in constant time;
//  - counts OTA in every active phase, including `validando`, which monitoramentoService leaves out
//    of otaEmAndamento.

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "remoteifes-prontidao-"));
process.env.REMOTEIFES_DATA_DIR = DIR;
process.env.REMOTEIFES_DB_PATH = path.join(DIR, "teste.db");
process.env.NODE_ENV = "test";

const CAMINHO_TOKEN = path.join(DIR, ".console-token");

function carregarRota() {
  for (const modulo of Object.keys(require.cache)) {
    if (modulo.includes("prontidaoRoutes")) delete require.cache[modulo];
  }
  return require("../src/routes/prontidaoRoutes");
}

function requisicaoFalsa({ autorizacao, endereco = "127.0.0.1" } = {}) {
  return {
    method: "GET",
    url: "/manutencao/prontidao",
    headers: autorizacao ? { authorization: autorizacao } : {},
    socket: { remoteAddress: endereco },
    id: "teste",
  };
}

function respostaFalsa() {
  const r = {
    statusCode: null,
    corpo: null,
    cabecalhos: {},
    status(c) {
      r.statusCode = c;
      return r;
    },
    json(v) {
      r.corpo = v;
      return r;
    },
    set(k, v) {
      r.cabecalhos[k] = v;
      return r;
    },
  };
  return r;
}

function chamar(router, req) {
  const res = respostaFalsa();
  return new Promise((resolve) => {
    router.handle(req, res, () => resolve({ res, seguiu: true }));
    // All responses of this router are synchronous.
    setImmediate(() => resolve({ res, seguiu: false }));
  });
}

test("without the secret file the route answers 404 and exposes nothing", async () => {
  fs.rmSync(CAMINHO_TOKEN, { force: true });
  const router = carregarRota();
  const { res } = await chamar(router, requisicaoFalsa({ autorizacao: "Bearer qualquer" }));
  assert.equal(res.statusCode, 404);
  assert.equal(res.corpo.ok, false);
  assert.equal(res.corpo.dispositivos, undefined);
});

test("a request from outside loopback is refused even with the right secret", async () => {
  fs.writeFileSync(CAMINHO_TOKEN, "um-segredo-de-teste-bem-comprido\n", { mode: 0o600 });
  const router = carregarRota();
  const { res } = await chamar(
    router,
    requisicaoFalsa({ autorizacao: "Bearer um-segredo-de-teste-bem-comprido", endereco: "10.0.0.5" })
  );
  assert.equal(res.statusCode, 403);
  assert.match(res.corpo.erro, /apenas no host/);
});

test("a missing or wrong secret is refused with 401", async () => {
  fs.writeFileSync(CAMINHO_TOKEN, "um-segredo-de-teste-bem-comprido\n", { mode: 0o600 });
  const router = carregarRota();

  const sem = await chamar(router, requisicaoFalsa());
  assert.equal(sem.res.statusCode, 401);

  const errado = await chamar(router, requisicaoFalsa({ autorizacao: "Bearer outro-valor-qualquer-aqui" }));
  assert.equal(errado.res.statusCode, 401);

  const tipoErrado = await chamar(router, requisicaoFalsa({ autorizacao: "Basic um-segredo-de-teste-bem-comprido" }));
  assert.equal(tipoErrado.res.statusCode, 401);
});

test("with secret and loopback it returns the readiness snapshot", async () => {
  fs.writeFileSync(CAMINHO_TOKEN, "um-segredo-de-teste-bem-comprido\n", { mode: 0o600 });
  const router = carregarRota();
  const { res } = await chamar(router, requisicaoFalsa({ autorizacao: "Bearer um-segredo-de-teste-bem-comprido" }));

  assert.equal(res.statusCode, null, "a success response uses res.json without an explicit status");
  assert.equal(res.corpo.ok, true);
  assert.equal(typeof res.corpo.dispositivos.conectados, "number");
  assert.equal(typeof res.corpo.dispositivos.canaisDeComando, "number");
  assert.equal(typeof res.corpo.ota.ativos, "number");
  assert.equal(res.cabecalhos["Cache-Control"], "no-store");
});

test("every active OTA phase counts, including validando", async () => {
  fs.writeFileSync(CAMINHO_TOKEN, "um-segredo-de-teste-bem-comprido\n", { mode: 0o600 });
  const router = carregarRota();
  const { res } = await chamar(router, requisicaoFalsa({ autorizacao: "Bearer um-segredo-de-teste-bem-comprido" }));

  const fases = Object.keys(res.corpo.ota.porFase).sort();
  assert.deepEqual(fases, ["baixando", "gravado", "ofertado", "reiniciando", "validando"]);

  // The same phases otaService considers active. If a phase is added there and not here, the
  // Console would interrupt the service during an OTA.
  const otaService = require("../src/services/otaService");
  assert.ok(otaService.listarEstados, "otaService must expose listarEstados for this contract");
});

test("the response body includes neither the secret nor device credentials", async () => {
  fs.writeFileSync(CAMINHO_TOKEN, "um-segredo-de-teste-bem-comprido\n", { mode: 0o600 });
  const router = carregarRota();
  const { res } = await chamar(router, requisicaoFalsa({ autorizacao: "Bearer um-segredo-de-teste-bem-comprido" }));
  const texto = JSON.stringify(res.corpo);
  assert.ok(!texto.includes("um-segredo-de-teste"));
  assert.ok(!/senha|credencial|token/i.test(texto));
});

test.after(() => {
  try {
    require("../src/config/database").close();
  } catch {}
  fs.rmSync(DIR, { recursive: true, force: true });
});

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const ajuda = require("./helpers");

// First operator creation without retrieving the installation secret by hand. Authorization is
// local: whoever can read the secret file. The launcher trades it for a single-use invitation that
// reaches the browser through a private page, never through a process argument; the terminal path
// reads name and password from a prompt or stdin, never from arguments.

const SEGREDO = "segredo-de-instalacao-para-teste-123";

async function consoleSemOperador(t) {
  const amb = ajuda.ambiente();
  const s = await ajuda.subir(amb);
  t.after(async () => {
    await s.fechar();
    amb.restaurar();
  });
  fs.writeFileSync(path.join(amb.estadoDir, "bootstrap-token"), `${SEGREDO}\n`, { mode: 0o600 });
  require(path.join(ajuda.RAIZ, "src", "identidade.js")).publicarContrato({ porta: s.porta, modo: "teste" });
  return { amb, s };
}

function pedirConvite(s, segredo = SEGREDO) {
  return ajuda.pedir(s.porta, "/api/bootstrap/convite", { metodo: "POST", corpo: { segredo }, origem: s.base });
}

function criar(s, corpo) {
  return ajuda.pedir(s.porta, "/api/bootstrap", { metodo: "POST", corpo, origem: s.base });
}

test("an invitation creates exactly one operator and then everything stops working", async (t) => {
  const { amb, s } = await consoleSemOperador(t);

  assert.equal((await pedirConvite(s, "chute")).status, 403);
  const emitido = await pedirConvite(s);
  assert.equal(emitido.status, 201);
  assert.match(emitido.json.convite, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(emitido.json.expiraEmS <= 600, "the invitation is short-lived");
  assert.ok(!emitido.texto.includes(SEGREDO));

  const fraca = await criar(s, { convite: emitido.json.convite, nome: "operador", senha: "curta" });
  assert.equal(fraca.status, 400, "a refused password does not burn the invitation");
  const criado = await criar(s, { convite: emitido.json.convite, nome: "operador", senha: "senha-bem-longa-123" });
  assert.equal(criado.status, 201);

  assert.ok(!fs.existsSync(path.join(amb.estadoDir, "bootstrap-token")), "the installation secret is invalidated");
  assert.equal((await criar(s, { convite: emitido.json.convite, nome: "outro", senha: "senha-bem-longa-456" })).status, 409);
  assert.equal((await pedirConvite(s)).status, 409);
  const auditoria = amb.estado.lerAuditoria(50).map((e) => e.evento);
  assert.ok(auditoria.includes("bootstrap-convite-emitido") && auditoria.includes("bootstrap-concluido"));
  assert.ok(!JSON.stringify(amb.estado.lerAuditoria(50)).includes(emitido.json.convite), "the invitation is not audited");
});

test("an expired or unknown invitation is refused", async (t) => {
  const { s } = await consoleSemOperador(t);
  const emitido = await pedirConvite(s);
  assert.equal((await criar(s, { convite: "x".repeat(43), nome: "operador", senha: "senha-bem-longa-123" })).status, 403);

  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 11 * 60 * 1000 });
  const vencido = await criar(s, { convite: emitido.json.convite, nome: "operador", senha: "senha-bem-longa-123" });
  assert.equal(vencido.status, 403);
  assert.match(vencido.json.erro, /inválido ou vencido/);
});

test("guessing the secret or an invitation is rate limited", async (t) => {
  const { s } = await consoleSemOperador(t);
  let ultimo;
  for (let i = 0; i < 10; i += 1) ultimo = await pedirConvite(s, `chute-${i}`);
  assert.equal(ultimo.status, 429);
  assert.equal((await pedirConvite(s)).status, 429, "even the right secret waits once the limit is reached");
});

test("the launcher opens the first access through a private page and never puts the invitation in an argument", { skip: process.platform === "win32" && "POSIX file modes" }, async (t) => {
  const { s } = await consoleSemOperador(t);
  const lancador = require(path.join(ajuda.RAIZ, "launcher.js"));
  const contrato = lancador.lerContrato();

  let aberto = null;
  let conteudo = null;
  let modo = null;
  const r = await lancador.abrirPrimeiroAcesso(contrato, {
    esperaMs: 0,
    abrirNavegador: async (url) => {
      aberto = url;
      const arquivo = require("url").fileURLToPath(url);
      conteudo = fs.readFileSync(arquivo, "utf8");
      modo = fs.statSync(arquivo).mode & 0o777;
      return { disponivel: true };
    },
  });
  assert.equal(r.ok, true);
  assert.match(aberto, /^file:\/\//, "the browser receives a file path, not the Console URL");
  assert.ok(!/primeiro-acesso=/.test(aberto), "the invitation is not in the opener's argument");
  assert.equal(modo, 0o600, "only the local user reads the page");
  const convite = /#primeiro-acesso=([A-Za-z0-9_-]+)/.exec(conteudo)[1];
  assert.ok(!conteudo.includes(SEGREDO), "the installation secret never leaves the state file");
  assert.ok(!fs.existsSync(require("url").fileURLToPath(aberto)), "the private page is deleted afterwards");

  const criado = await criar(s, { convite, nome: "operador", senha: "senha-bem-longa-123" });
  assert.equal(criado.status, 201);
});

test("without read access to the secret the launcher opens the ordinary page", async (t) => {
  const { amb } = await consoleSemOperador(t);
  fs.rmSync(path.join(amb.estadoDir, "bootstrap-token"));
  const lancador = require(path.join(ajuda.RAIZ, "launcher.js"));
  let aberto = null;
  const plataforma = require(path.join(ajuda.RAIZ, "src", "plataforma"));
  const original = plataforma.abrirNavegador;
  plataforma.abrirNavegador = async (url) => {
    aberto = url;
    return { disponivel: true };
  };
  t.after(() => {
    plataforma.abrirNavegador = original;
  });
  const r = await lancador.abrirPrimeiroAcesso(lancador.lerContrato(), { esperaMs: 0 });
  assert.equal(r.ok, true);
  assert.match(aberto, /^http:\/\/127\.0\.0\.1:\d+\/$/);
});

test("the terminal path creates the operator from stdin, never from arguments", async (t) => {
  const { amb, s } = await consoleSemOperador(t);
  const lancador = require(path.join(ajuda.RAIZ, "launcher.js"));

  const codigo = await lancador.criarOperadorPeloTerminal({ entrada: Readable.from(["operador.cli\nsenha-bem-longa-789\n"]) });
  assert.equal(codigo, 0);
  assert.equal(amb.auth.existeOperador(), true);
  const login = await ajuda.pedir(s.porta, "/api/sessao", { metodo: "POST", corpo: { nome: "operador.cli", senha: "senha-bem-longa-789" }, origem: s.base });
  assert.equal(login.status, 200);

  assert.equal(await lancador.criarOperadorPeloTerminal({ entrada: Readable.from(["outro\nsenha-bem-longa-000\n"]) }), 1, "only while there is no operator");
});

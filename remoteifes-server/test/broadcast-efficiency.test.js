process.env.REMOTEIFES_DB_PATH = ":memory:";
process.env.NODE_ENV = "test";

const http = require("http");
const test = require("node:test");
const assert = require("node:assert/strict");
const WebSocket = require("ws");

const db = require("../src/config/database");
const app = require("../src/app");
const statusHub = require("../src/services/statusHub");
const deviceHub = require("../src/services/deviceHub");
const salasService = require("../src/services/salasService");
const usuariosService = require("../src/services/usuariosService");
const tokenService = require("../src/services/tokenService");

let server;
let porta;
const abertos = new Set();
const SUPER = { nivel: 3 };

function esperar(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function ate(condicao, limiteMs = 3000) {
  const inicio = Date.now();
  while (!condicao() && Date.now() - inicio < limiteMs) await esperar(10);
  return condicao();
}

async function cliente(token, sala) {
  const ws = new WebSocket(`ws://127.0.0.1:${porta}/ws`, [token]);
  const mensagens = [];
  let codigoFechamento = null;
  ws.on("message", (d) => mensagens.push(JSON.parse(d.toString())));
  ws.on("close", (codigo) => { codigoFechamento = codigo; abertos.delete(ws); });
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  abertos.add(ws);
  if (sala) ws.send(JSON.stringify({ tipo: "observar", sala }));
  await ate(() => mensagens.some((m) => m.tipo === "salas"));
  return { ws, mensagens, fechamento: () => codigoFechamento, ultimaLista: () => mensagens.filter((m) => m.tipo === "salas").at(-1) };
}

function contarConsultas(fn) {
  const preparar = db.prepare.bind(db);
  let n = 0;
  db.prepare = (...a) => { n += 1; return preparar(...a); };
  try {
    fn();
  } finally {
    db.prepare = preparar;
  }
  return n;
}

function superadmin() {
  const registro = usuariosService.buscarPorId(db.prepare("SELECT id FROM usuarios WHERE nivel = 3").get().id);
  return { ...registro, isAdmin: true };
}

test.before(async () => {
  server = http.createServer(app);
  statusHub.iniciar(server);
  deviceHub.iniciar(server);
  await new Promise((r) => server.listen(0, r));
  porta = server.address().port;
  db.prepare("UPDATE salas SET acessoRestrito = 1 WHERE sala IN ('A-108', 'A-106')").run();
});

test.after(async () => {
  for (const ws of abertos) {
    try { ws.terminate(); } catch (erro) {}
  }
  deviceHub.encerrar();
  statusHub.encerrar();
  await new Promise((r) => server.close(r));
});

test("the query cost of a rebroadcast does not grow with the number of connected browsers", async () => {
  const conexoes = [];
  for (let i = 0; i < 12; i += 1) {
    const u = usuariosService.criar({ usuario: `fanout-${i}`, senha: "SenhaFanout123", nome: `Fanout ${i}`, podeControlar: true }, SUPER);
    salasService.concederAcesso("A-108", u.id);
    conexoes.push(await cliente(tokenService.gerarToken(u.id), i % 2 ? "A-108" : "A-106"));
  }
  const supervisor = await cliente(tokenService.gerarToken(superadmin().id), "A-108");
  const contexto = { usuario: superadmin(), origem: "manual" };

  const comUm = contarConsultas(() => salasService.aplicarComando("A-108", "temperatura", 23, contexto));
  const comTodos = contarConsultas(() => salasService.aplicarComando("A-108", "temperatura", 24, contexto));
  assert.ok(comTodos <= 20, `retransmissão para 13 clientes custou ${comTodos} consultas`);
  assert.ok(Math.abs(comTodos - comUm) <= 2, `o custo deve ser independente do número de clientes (${comUm} vs ${comTodos})`);
  assert.ok(await ate(() => conexoes.every((c) => c.ultimaLista() && c.ultimaLista().salas.length > 0)));
  for (const c of conexoes) {
    const lista = c.ultimaLista().salas;
    assert.equal(lista.find((s) => s.sala === "A-108").podeControlarEsta, true, "quem tem acesso à sala restrita pode controlá-la");
    assert.equal(lista.find((s) => s.sala === "A-106").podeControlarEsta, false, "sala restrita sem acesso concedido");
    assert.equal(lista.find((s) => s.sala === "A-201a").podeControlarEsta, true, "sala livre para quem pode controlar");
  }
  assert.equal(supervisor.ultimaLista().salas.every((s) => s.podeControlarEsta), true);
});

test("authorization stays fresh: revoking access or disabling the account takes effect on the next rebroadcast, without a cache", async () => {
  const u = usuariosService.criar({ usuario: "fanout-fresco", senha: "SenhaFanout123", nome: "Fresco", podeControlar: true }, SUPER);
  salasService.concederAcesso("A-108", u.id);
  const c = await cliente(tokenService.gerarToken(u.id), "A-108");
  assert.ok(await ate(() => c.mensagens.some((m) => m.tipo === "status")));
  assert.equal(c.ultimaLista().salas.find((s) => s.sala === "A-108").podeControlarEsta, true);
  assert.equal(c.mensagens.filter((m) => m.tipo === "status").at(-1).status.podeControlarEsta, true);

  salasService.revogarAcesso("A-108", u.id);
  c.mensagens.length = 0;
  salasService.eventos.emit("mudanca");
  assert.ok(await ate(() => c.ultimaLista() && c.mensagens.some((m) => m.tipo === "status")));
  assert.equal(c.ultimaLista().salas.find((s) => s.sala === "A-108").podeControlarEsta, false);
  assert.equal(c.mensagens.filter((m) => m.tipo === "status").at(-1).status.podeControlarEsta, false);

  usuariosService.atualizarPermissoes(u.id, { ativo: false }, { id: 0, nivel: 3 });
  salasService.eventos.emit("mudanca");
  assert.ok(await ate(() => c.fechamento() !== null));
  assert.equal(c.fechamento(), 4001, "sessão de conta desativada é encerrada na validação em lote");
});

test("a session ended elsewhere is dropped by batch validation and the others keep receiving", async () => {
  const a = usuariosService.criar({ usuario: "fanout-a", senha: "SenhaFanout123", nome: "A", podeControlar: true }, SUPER);
  const b = usuariosService.criar({ usuario: "fanout-b", senha: "SenhaFanout123", nome: "B", podeControlar: true }, SUPER);
  const tokenA = tokenService.gerarToken(a.id);
  const ca = await cliente(tokenA, "A-201a");
  const cb = await cliente(tokenService.gerarToken(b.id), "A-201a");
  tokenService.removerToken(tokenA);
  cb.mensagens.length = 0;
  salasService.eventos.emit("mudanca");
  assert.ok(await ate(() => ca.fechamento() === 4001));
  assert.ok(await ate(() => cb.ultimaLista()));
  assert.equal(cb.fechamento(), null);
});

test("the IR state goes to the board before the rebroadcast to browsers", (t) => {
  const ordem = [];
  t.mock.method(deviceHub, "enviarComando", () => { ordem.push("esp32"); return true; });
  const ouvinte = () => ordem.push("navegadores");
  salasService.eventos.on("mudanca", ouvinte);
  t.after(() => salasService.eventos.removeListener("mudanca", ouvinte));
  db.prepare("UPDATE salas SET irProtocolo = 16 WHERE sala = 'A-108'").run();
  salasService.aplicarComando("A-108", "ligar", undefined, { usuario: superadmin(), origem: "manual" });
  assert.deepEqual(ordem, ["esp32", "navegadores"]);
});

test("session use is written at most every 30 s per session, without changing idle expiry", () => {
  const u = usuariosService.criar({ usuario: "fanout-uso", senha: "SenhaFanout123", nome: "Uso" }, SUPER);
  const token = tokenService.gerarToken(u.id);
  db.prepare("UPDATE sessoes SET ultimoUso = datetime('now', '-120 seconds') WHERE usuarioId = ?").run(u.id);
  const preparar = db.prepare.bind(db);
  let escritas = 0;
  db.prepare = (sql, ...r) => { if (/UPDATE sessoes SET ultimoUso/.test(sql)) escritas += 1; return preparar(sql, ...r); };
  try {
    tokenService.validarToken(token);
    tokenService.validarToken(token);
    tokenService.validarToken(token);
  } finally {
    db.prepare = preparar;
  }
  assert.equal(escritas, 1, "a primeira validação após 2 min grava; as seguintes no mesmo instante não");
  db.prepare("UPDATE sessoes SET ultimoUso = datetime('now', '-61 minutes') WHERE usuarioId = ?").run(u.id);
  assert.equal(tokenService.validarToken(token), null, "a inatividade continua sendo avaliada pelo valor persistido");
});

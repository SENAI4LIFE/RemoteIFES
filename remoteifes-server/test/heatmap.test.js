process.env.REMOTEIFES_DB_PATH = ":memory:";
process.env.NODE_ENV = "test";

const http = require("http");
const test = require("node:test");
const assert = require("node:assert/strict");

const db = require("../src/config/database");
const app = require("../src/app");
const heatmapService = require("../src/services/heatmapService");
const usuariosService = require("../src/services/usuariosService");

const SALA_COM_ESP = "A-103a";
const SALA_SEM_ESP = "A-103b";

let server;
let baseUrl;
let superToken;
let adminToken;
let userToken;

async function request(caminho, { token, method = "GET" } = {}) {
  return fetch(`${baseUrl}${caminho}`, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

async function login(usuario, senha) {
  const resp = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usuario, senha }),
  });
  return (await resp.json()).token;
}

function horasAtras(h) {
  return db.prepare("SELECT datetime('now', ?) t").get(`-${h} hours`).t;
}

test.before(async () => {
  usuariosService.criar({ usuario: "heat-admin", senha: "SenhaAdmin123", nome: "Admin", isAdmin: true }, { nivel: 3 });
  usuariosService.criar({ usuario: "heat-user", senha: "SenhaUser123", nome: "User" }, { nivel: 3 });
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  superToken = await login("superadmin", "admin");
  adminToken = await login("heat-admin", "SenhaAdmin123");
  userToken = await login("heat-user", "SenhaUser123");

  // Only the room with a MAC has a device: the other must fall into "sem dados".
  db.prepare("UPDATE salas SET mac = NULL").run();
  db.prepare("UPDATE salas SET mac = 'AA:BB:CC:DD:EE:01' WHERE sala = ?").run(SALA_COM_ESP);

  // 2 h offline within the last 24 h and 1 h offline between 20 and 25 days ago.
  const inserir = db.prepare("INSERT INTO esp_indisponibilidades (sala, offlineEm, onlineEm, duracaoSegundos) VALUES (?, ?, ?, ?)");
  inserir.run(SALA_COM_ESP, horasAtras(5), horasAtras(3), 7200);
  inserir.run(SALA_COM_ESP, horasAtras(24 * 20), horasAtras(24 * 20 - 1), 3600);

  // Comandos: um durante a queda recente, dois fora dela.
  const comando = db.prepare("INSERT INTO comandos_log (usuario, sala, cmd, valor, origem, criadoEm) VALUES (NULL, ?, 'ligar', NULL, 'teste', ?)");
  comando.run(SALA_COM_ESP, horasAtras(4));
  comando.run(SALA_COM_ESP, horasAtras(2));
  comando.run(SALA_SEM_ESP, horasAtras(2));
  comando.run(SALA_COM_ESP, horasAtras(24 * 10));

  // Relatos: um pendente e um resolvido, ambos nas ultimas 24 h.
  const relato = db.prepare(
    "INSERT INTO relatos (usuarioId, titulo, descricao, categoria, sala, status, criadoEm, atualizadoEm) VALUES (NULL, ?, 'd', 'outro', ?, ?, ?, ?)"
  );
  relato.run("pendente", SALA_COM_ESP, "novo", horasAtras(6), horasAtras(6));
  relato.run("resolvido", SALA_COM_ESP, "resolvido", horasAtras(6), horasAtras(6));

  heatmapService.limparCache();
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test("the heatmap is superadministrator-only", async () => {
  for (const [token, status] of [[null, 401], [userToken, 403], [adminToken, 403], [superToken, 200]]) {
    assert.equal((await request("/admin/heatmap?metrica=comandos&periodo=24h", { token })).status, status);
  }
});

test("per-room aggregation uses the requested time windows", async () => {
  const em = (dados, sala) => dados.salas.find((s) => s.sala === sala);

  const comandos24h = heatmapService.calcular("comandos", "24h");
  assert.equal(em(comandos24h, SALA_COM_ESP).valor, 2);
  assert.equal(em(comandos24h, SALA_SEM_ESP).valor, 1);

  // The 30-day window includes the command from 10 days ago; the 24 h window does not.
  const comandos30d = heatmapService.calcular("comandos", "30d");
  assert.equal(em(comandos30d, SALA_COM_ESP).valor, 3);

  const offline = heatmapService.calcular("indisponibilidade", "24h");
  assert.equal(em(offline, SALA_COM_ESP).valor, 120);

  const disponibilidade = heatmapService.calcular("disponibilidade", "24h");
  assert.equal(em(disponibilidade, SALA_COM_ESP).valor, 91.7);
  assert.equal(em(disponibilidade, SALA_COM_ESP).quedas, 1);

  const quedas30d = heatmapService.calcular("quedas", "30d");
  assert.equal(em(quedas30d, SALA_COM_ESP).valor, 2);

  const comandosOffline = heatmapService.calcular("comandosOffline", "24h");
  assert.equal(em(comandosOffline, SALA_COM_ESP).valor, 1);

  const relatos = heatmapService.calcular("relatos", "24h");
  assert.equal(em(relatos, SALA_COM_ESP).valor, 2);
  const pendentes = heatmapService.calcular("relatosPendentes", "24h");
  assert.equal(em(pendentes, SALA_COM_ESP).valor, 1);
});

test("a room without a device has no data in connectivity metrics, not zero", async () => {
  const disponibilidade = heatmapService.calcular("disponibilidade", "7d");
  const semEsp = disponibilidade.salas.find((s) => s.sala === SALA_SEM_ESP);
  assert.equal(semEsp.valor, null);
  assert.equal(semEsp.quedas, undefined);

  // The same room has a real value in a metric that does not depend on the device.
  const comandos = heatmapService.calcular("comandos", "7d");
  assert.equal(comandos.salas.find((s) => s.sala === SALA_SEM_ESP).valor, 1);
});

test("the response is compact, covers every room and does not leak raw history", async () => {
  const resp = await request("/admin/heatmap?metrica=disponibilidade&periodo=7d", { token: superToken });
  assert.equal(resp.status, 200);
  const corpo = await resp.json();

  const totalSalas = db.prepare("SELECT COUNT(*) n FROM salas").get().n;
  assert.equal(corpo.salas.length, totalSalas);
  assert.equal(corpo.total, totalSalas);
  assert.equal(corpo.maiorEhPior, false);
  assert.ok(corpo.metricas.length >= 9);
  assert.deepEqual(corpo.periodos.map((p) => p.id), ["24h", "7d", "30d"]);

  // One item per room carries only the summary, never individual events.
  const chaves = new Set(corpo.salas.flatMap((s) => Object.keys(s)));
  assert.deepEqual([...chaves].sort(), ["minutosOffline", "nome", "quedas", "sala", "valor"]);
  assert.ok(JSON.stringify(corpo.salas).length < 24 * 1024, "the per-room payload should stay compact");
});

test("invalid metric and period fall back to the default instead of failing", async () => {
  const dados = heatmapService.calcular("nao-existe", "sempre");
  assert.equal(dados.metrica, "disponibilidade");
  assert.equal(dados.periodo, "7d");
  assert.equal(dados.janela.horas, 24 * 7);
});

test("the short cache returns the same object without recomputing and disappears when cleared", () => {
  heatmapService.limparCache();
  const primeira = heatmapService.obter("comandos", "24h");
  assert.equal(heatmapService.obter("comandos", "24h"), primeira);
  heatmapService.limparCache();
  assert.notEqual(heatmapService.obter("comandos", "24h"), primeira);
});

test("the retention warning appears when the period exceeds the connectivity history", () => {
  const curto = heatmapService.calcular("disponibilidade", "24h");
  assert.equal(curto.avisoRetencao, null);
  const longo = heatmapService.calcular("disponibilidade", "30d");
  assert.match(longo.avisoRetencao, /histórico de conectividade/);
  // A metric without connectivity dependency does not carry the warning.
  assert.equal(heatmapService.calcular("comandos", "30d").avisoRetencao, null);
});

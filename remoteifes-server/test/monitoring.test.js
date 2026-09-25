process.env.REMOTEIFES_DB_PATH = ":memory:";
process.env.NODE_ENV = "test";

const http = require("http");
const test = require("node:test");
const assert = require("node:assert/strict");

const db = require("../src/config/database");
const app = require("../src/app");
const monitoramentoService = require("../src/services/monitoramentoService");
const notificacoesService = require("../src/services/notificacoesService");
const usuariosService = require("../src/services/usuariosService");

let server;
let baseUrl;

async function login(usuario, senha) {
  const resp = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usuario, senha }),
  });
  return (await resp.json()).token;
}

function authGet(caminho, token) {
  return fetch(`${baseUrl}${caminho}`, { headers: { Authorization: token ? `Bearer ${token}` : undefined } });
}

test.before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test("/admin/monitoramento requires the superadministrator", async () => {
  usuariosService.criar(
    { usuario: "mon-comum", senha: "senhaSegura123", nome: "Comum", podeControlar: true },
    { nivel: 3 }
  );
  usuariosService.criar(
    { usuario: "mon-admin", senha: "senhaSegura123", nome: "Admin", isAdmin: true },
    { nivel: 3 }
  );

  assert.equal((await authGet("/admin/monitoramento", null)).status, 401);
  assert.equal((await authGet("/admin/monitoramento", await login("mon-comum", "senhaSegura123"))).status, 403);
  assert.equal((await authGet("/admin/monitoramento", await login("mon-admin", "senhaSegura123"))).status, 403);
  assert.equal((await authGet("/admin/monitoramento", await login("superadmin", "admin"))).status, 200);
});

test("the payload carries database, storage, backup, esp32, service and failures, without secrets", async () => {
  const token = await login("superadmin", "admin");
  const corpo = await (await authGet("/admin/monitoramento", token)).json();
  const m = corpo.monitoramento;

  assert.equal(m.banco.ok, true);
  assert.equal(typeof m.banco.respostaMs, "number");
  assert.equal(typeof m.banco.reutilizavelBytes, "number");
  assert.ok(m.banco.tabelas.auditoria_eventos);
  assert.ok(m.banco.tabelas.esp_indisponibilidades);
  assert.ok(m.armazenamento.caminho);
  assert.ok("livreBytes" in m.armazenamento || "erro" in m.armazenamento);
  assert.ok("automatico" in m.backup);
  assert.equal(typeof m.esp32.comMac, "number");
  assert.equal(typeof m.esp32.conectadosWs, "number");
  assert.equal(typeof m.servico.uptimeSegundos, "number");
  assert.ok(m.servico.uptimeSegundos >= 0);
  assert.ok(m.falhas.contadores && typeof m.falhas.contadores === "object");
  assert.ok(Array.isArray(m.alertas));

  const bruto = JSON.stringify(m);
  assert.ok(!bruto.includes("senhaHash"));
  assert.ok(!bruto.includes("segredoHash"));
});

test("registrar() increments counters and appears in the payload", async () => {
  const token = await login("superadmin", "admin");
  const antes = (await (await authGet("/admin/monitoramento", token)).json()).monitoramento.falhas.contadores.telemetriaFalha;
  monitoramentoService.registrar("telemetriaFalha", { sala: "X-1" });
  monitoramentoService.registrar("telemetriaFalha", { sala: "X-1" });
  const depois = (await (await authGet("/admin/monitoramento", token)).json()).monitoramento.falhas.contadores.telemetriaFalha;
  assert.equal(depois, antes + 2);
});

test("close reconnections count as abnormal reconnection", () => {
  const antes = monitoramentoService.coletar().falhas.contadores.reconexaoAnormal;
  monitoramentoService.registrarConexaoDispositivo("flap-sala");
  monitoramentoService.registrarConexaoDispositivo("flap-sala");
  const depois = monitoramentoService.coletar().falhas.contadores.reconexaoAnormal;
  assert.equal(depois, antes + 1);
});

test("an ESP32 with a MAC but offline enters offlineInesperado", async () => {
  db.prepare(`INSERT INTO salas (sala, nome, bloco, andar, mac, online) VALUES ('MON-OFF', 'x', 'A', 1, 'AA:00:00:00:0F:01', 0)`).run();
  const token = await login("superadmin", "admin");
  const m = (await (await authGet("/admin/monitoramento", token)).json()).monitoramento;
  assert.ok(m.esp32.comMac >= 1);
  assert.ok(m.esp32.offlineInesperado >= 1);
});

test("avaliar() creates a monitoring notification for an alert and does not duplicate it within 6h", () => {
  db.prepare(`INSERT INTO salas (sala, nome, bloco, andar) VALUES ('MON-FLAP', 'x', 'A', 1)`).run();
  for (let i = 0; i < 5; i += 1) {
    db.prepare(`INSERT INTO esp_eventos (sala, status, criadoEm) VALUES ('MON-FLAP', 'online', datetime('now', '-10 minutes'))`).run();
  }
  const antes = notificacoesService.listar().filter((n) => n.tipo === "monitoramento").length;
  monitoramentoService.avaliar();
  const meio = notificacoesService.listar().filter((n) => n.tipo === "monitoramento");
  assert.ok(meio.length > antes);
  assert.ok(meio.some((n) => /MON-FLAP/.test(n.mensagem)));

  db.prepare(`INSERT INTO esp_eventos (sala, status) VALUES ('MON-FLAP', 'online')`).run();
  monitoramentoService.avaliar();
  const depois = notificacoesService.listar().filter((n) => n.tipo === "monitoramento").length;
  assert.equal(depois, meio.length, "a counter change must not duplicate the same alert");
});

test("comandoNaoEntregue counts only what the server could not deliver to the ESP32 socket", () => {
  const salasService = require("../src/services/salasService");
  db.prepare("INSERT OR IGNORE INTO salas (sala, nome, bloco, andar, irProtocolo, temperaturaAlvo) VALUES ('MON-CMD', 'Mon', 'A', 1, 16, 23)").run();
  const contador = () => monitoramentoService.coletar().falhas.contadores.comandoNaoEntregue;
  assert.equal(typeof contador(), "number");
  assert.equal("comandoFalha" in monitoramentoService.coletar().falhas.contadores, false, "the old metric, never incremented, no longer exists");
  const antes = contador();
  salasService.aplicarComando("MON-CMD", "ligar", undefined, { usuario: { id: 1, usuario: "superadmin", isAdmin: true, podeControlar: true }, origem: "manual" });
  assert.equal(contador(), antes + 1, "without a connected device the command was not delivered");
  const deviceHub = require("../src/services/deviceHub");
  const original = deviceHub.enviarComando;
  deviceHub.enviarComando = () => true;
  try {
    salasService.aplicarComando("MON-CMD", "desligar", undefined, { usuario: { id: 1, usuario: "superadmin", isAdmin: true, podeControlar: true }, origem: "manual" });
  } finally {
    deviceHub.enviarComando = original;
  }
  assert.equal(contador(), antes + 1, "a successful delivery does not count, even without physical confirmation");
  const alertas = monitoramentoService.coletar().alertas;
  assert.ok(alertas.some((a) => a.startsWith("comandoNaoEntregue:")));
});

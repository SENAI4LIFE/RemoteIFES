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

test("/admin/monitoramento exige admin", async () => {
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
  assert.equal((await authGet("/admin/monitoramento", await login("mon-admin", "senhaSegura123"))).status, 200);
});

test("o payload traz banco, armazenamento, backup, esp32, serviço e falhas — sem segredos", async () => {
  const token = await login("mon-admin", "senhaSegura123");
  const corpo = await (await authGet("/admin/monitoramento", token)).json();
  const m = corpo.monitoramento;

  assert.equal(m.banco.ok, true);
  assert.equal(typeof m.banco.respostaMs, "number");
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

test("registrar() incrementa contadores e aparece no payload", async () => {
  const token = await login("mon-admin", "senhaSegura123");
  const antes = (await (await authGet("/admin/monitoramento", token)).json()).monitoramento.falhas.contadores.telemetriaFalha;
  monitoramentoService.registrar("telemetriaFalha", { sala: "X-1" });
  monitoramentoService.registrar("telemetriaFalha", { sala: "X-1" });
  const depois = (await (await authGet("/admin/monitoramento", token)).json()).monitoramento.falhas.contadores.telemetriaFalha;
  assert.equal(depois, antes + 2);
});

test("reconexões próximas contam como reconexão anormal", () => {
  const antes = monitoramentoService.coletar().falhas.contadores.reconexaoAnormal;
  monitoramentoService.registrarConexaoDispositivo("flap-sala");
  monitoramentoService.registrarConexaoDispositivo("flap-sala");
  const depois = monitoramentoService.coletar().falhas.contadores.reconexaoAnormal;
  assert.equal(depois, antes + 1);
});

test("ESP32 com MAC porém offline entra em offlineInesperado", async () => {
  db.prepare(`INSERT INTO salas (sala, nome, bloco, andar, mac, online) VALUES ('MON-OFF', 'x', 'A', 1, 'AA:00:00:00:0F:01', 0)`).run();
  const token = await login("mon-admin", "senhaSegura123");
  const m = (await (await authGet("/admin/monitoramento", token)).json()).monitoramento;
  assert.ok(m.esp32.comMac >= 1);
  assert.ok(m.esp32.offlineInesperado >= 1);
});

test("avaliar() cria uma notificação de monitoramento para um alerta e não duplica em 6h", () => {
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
  assert.equal(depois, meio.length, "mudança no contador não deve duplicar o mesmo alerta");
});

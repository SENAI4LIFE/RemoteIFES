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
const credenciaisService = require("../src/services/esp32CredenciaisService");

const TOTAL = 12;
const salas = Array.from({ length: TOTAL }, (_, i) => `res-${String(i + 1).padStart(2, "0")}`);

let server;
let baseWsUrl;
const credenciais = new Map();
const clientes = new Set();

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

async function ate(condicao, ms = 5000, passo = 25) {
  const limite = Date.now() + ms;
  while (Date.now() < limite) {
    if (condicao()) return true;
    await espera(passo);
  }
  return false;
}

function conectar(sala) {
  const { deviceId, segredo } = credenciais.get(sala);
  const ws = new WebSocket(baseWsUrl, { headers: { "x-device-id": deviceId, "x-device-secret": segredo } });
  ws.fechamentos = [];
  ws.on("close", (codigo) => ws.fechamentos.push(codigo));
  ws.on("error", () => {});
  clientes.add(ws);
  return ws;
}

function abertos(lista) {
  return lista.filter((ws) => ws.readyState === WebSocket.OPEN).length;
}

test.before(async () => {
  server = http.createServer(app);
  statusHub.iniciar(server);
  deviceHub.iniciar(server);
  await new Promise((resolve) => server.listen(0, resolve));
  baseWsUrl = `ws://127.0.0.1:${server.address().port}/ws/dispositivo`;
  for (const sala of salas) {
    db.prepare(`INSERT OR IGNORE INTO salas (sala, nome, bloco, andar) VALUES (?, ?, 'A', 1)`).run(sala, sala);
    credenciais.set(sala, credenciaisService.provisionar(sala));
  }
});

test.after(async () => {
  for (const ws of clientes) {
    try {
      ws.terminate();
    } catch {}
  }
  deviceHub.encerrar();
  statusHub.encerrar();
  await new Promise((resolve) => server.close(resolve));
});

test("a reconnection storm converges to one session per room, with no duplicates or leftovers", async () => {
  const primeira = salas.map(conectar);
  assert.ok(await ate(() => abertos(primeira) === TOTAL), "every device should connect");
  assert.ok(
    await ate(() => salas.every((sala) => deviceHub.estadoPublico(sala).conectado)),
    "every room should be listed as connected"
  );

  for (const ws of primeira) ws._socket.destroy();
  assert.ok(await ate(() => salas.every((sala) => !deviceHub.estadoPublico(sala).conectado)), "the sessions should be released");

  const segunda = salas.map(conectar);
  assert.ok(await ate(() => abertos(segunda) === TOTAL), "everyone should reconnect after the drop");
  assert.ok(
    await ate(() => salas.every((sala) => deviceHub.estadoPublico(sala).conectado)),
    "the state should converge to connected after the storm"
  );

  const estados = deviceHub.listarEstados();
  assert.equal(Object.keys(estados).length, TOTAL, "no room session should remain");
  assert.equal(abertos(primeira), 0, "no old socket should stay open");

  for (const ws of segunda) ws.close();
  assert.ok(await ate(() => salas.every((sala) => !deviceHub.estadoPublico(sala).conectado)), "encerramento limpo");
});

test("a duplicate connection for the same room drops the previous one with 4002 and keeps a single session", async () => {
  const sala = salas[0];
  const antiga = conectar(sala);
  assert.ok(await ate(() => antiga.readyState === WebSocket.OPEN));
  assert.ok(await ate(() => deviceHub.estadoPublico(sala).conectado));

  const nova = conectar(sala);
  assert.ok(await ate(() => nova.readyState === WebSocket.OPEN));
  assert.ok(await ate(() => antiga.fechamentos.includes(4002)), "the previous connection should receive code 4002");
  assert.equal(deviceHub.estadoPublico(sala).conectado, true, "the room should keep exactly one active session");

  nova.close();
  assert.ok(await ate(() => !deviceHub.estadoPublico(sala).conectado));
});

test("telemetry from an unknown device creates neither session nor state", async () => {
  const ws = new WebSocket(baseWsUrl, { headers: { "x-device-id": "esp_0000000000000000", "x-device-secret": "invalido" } });
  ws.fechamentos = [];
  ws.on("close", (codigo) => ws.fechamentos.push(codigo));
  ws.on("error", () => {});
  clientes.add(ws);
  assert.ok(await ate(() => ws.fechamentos.length > 0), "the connection should be refused");
  assert.equal(ws.fechamentos[0], 4001);
  assert.equal(Object.keys(deviceHub.listarEstados()).length, 0, "an invalid credential should not register a session");
});

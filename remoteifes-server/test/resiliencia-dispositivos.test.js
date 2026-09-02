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

test("tempestade de reconexão converge para uma sessão por sala, sem duplicatas nem sobras", async () => {
  const primeira = salas.map(conectar);
  assert.ok(await ate(() => abertos(primeira) === TOTAL), "todos os dispositivos deveriam conectar");
  assert.ok(
    await ate(() => salas.every((sala) => deviceHub.estadoPublico(sala).conectado)),
    "todas as salas deveriam constar como conectadas"
  );

  for (const ws of primeira) ws._socket.destroy();
  assert.ok(await ate(() => salas.every((sala) => !deviceHub.estadoPublico(sala).conectado)), "as sessões deveriam ser liberadas");

  const segunda = salas.map(conectar);
  assert.ok(await ate(() => abertos(segunda) === TOTAL), "todos deveriam reconectar após a queda");
  assert.ok(
    await ate(() => salas.every((sala) => deviceHub.estadoPublico(sala).conectado)),
    "o estado deveria convergir para conectado após a tempestade"
  );

  const estados = deviceHub.listarEstados();
  assert.equal(Object.keys(estados).length, TOTAL, "não deveria sobrar sessão de sala alguma");
  assert.equal(abertos(primeira), 0, "nenhum socket antigo deveria continuar aberto");

  for (const ws of segunda) ws.close();
  assert.ok(await ate(() => salas.every((sala) => !deviceHub.estadoPublico(sala).conectado)), "encerramento limpo");
});

test("conexão duplicada da mesma sala derruba a anterior com 4002 e mantém uma só sessão", async () => {
  const sala = salas[0];
  const antiga = conectar(sala);
  assert.ok(await ate(() => antiga.readyState === WebSocket.OPEN));
  assert.ok(await ate(() => deviceHub.estadoPublico(sala).conectado));

  const nova = conectar(sala);
  assert.ok(await ate(() => nova.readyState === WebSocket.OPEN));
  assert.ok(await ate(() => antiga.fechamentos.includes(4002)), "a conexão anterior deveria receber o código 4002");
  assert.equal(deviceHub.estadoPublico(sala).conectado, true, "a sala deveria seguir com exatamente uma sessão ativa");

  nova.close();
  assert.ok(await ate(() => !deviceHub.estadoPublico(sala).conectado));
});

test("telemetria de dispositivo desconhecido não cria sessão nem estado", async () => {
  const ws = new WebSocket(baseWsUrl, { headers: { "x-device-id": "esp_0000000000000000", "x-device-secret": "invalido" } });
  ws.fechamentos = [];
  ws.on("close", (codigo) => ws.fechamentos.push(codigo));
  ws.on("error", () => {});
  clientes.add(ws);
  assert.ok(await ate(() => ws.fechamentos.length > 0), "a conexão deveria ser recusada");
  assert.equal(ws.fechamentos[0], 4001);
  assert.equal(Object.keys(deviceHub.listarEstados()).length, 0, "uma credencial inválida não deveria registrar sessão");
});

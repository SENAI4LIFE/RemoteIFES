process.env.REMOTEIFES_DB_PATH = ":memory:";
process.env.NODE_ENV = "test";

const http = require("http");
const test = require("node:test");
const assert = require("node:assert/strict");
const WebSocket = require("ws");

const db = require("../src/config/database");
const app = require("../src/app");
const deviceHub = require("../src/services/deviceHub");
const credenciaisService = require("../src/services/esp32CredenciaisService");
const logger = require("../src/utils/logger");

const SALA = "diag-01";
let server;
let baseWsUrl;
let credencial;
const capturado = [];
const infoOriginal = logger.info;

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

async function ate(condicao, ms = 5000, passo = 25) {
  const limite = Date.now() + ms;
  while (Date.now() < limite) {
    if (condicao()) return true;
    await espera(passo);
  }
  return false;
}

test.before(async () => {
  logger.info = (categoria, detalhes) => {
    capturado.push({ categoria, detalhes });
  };
  server = http.createServer(app);
  deviceHub.iniciar(server);
  await new Promise((resolve) => server.listen(0, resolve));
  baseWsUrl = `ws://127.0.0.1:${server.address().port}/ws/dispositivo`;
  db.prepare(`INSERT OR IGNORE INTO salas (sala, nome, bloco, andar) VALUES (?, ?, 'A', 1)`).run(SALA, SALA);
  credencial = credenciaisService.provisionar(SALA);
});

test.after(async () => {
  logger.info = infoOriginal;
  deviceHub.encerrar();
  await new Promise((resolve) => server.close(resolve));
});

test("the board's reset reason, uptime, heap and drop counters are logged once per info, without unexpected fields", async () => {
  const ws = new WebSocket(baseWsUrl, { headers: { "x-device-id": credencial.deviceId, "x-device-secret": credencial.segredo } });
  ws.on("error", () => {});
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  ws.send(JSON.stringify({
    tipo: "info",
    fw: "4.5.1",
    diagnostico: {
      reinicio: "brownout",
      uptimeS: 3600,
      heapLivre: 151000,
      heapMinimo: 98000,
      heapMaiorBloco: 69000,
      quedasWifi: 2,
      motivoWifi: 200,
      quedasWs: 3,
      segredo: "nao-deve-aparecer",
      heapExtra: -1,
    },
  }));

  assert.ok(await ate(() => capturado.some((l) => l.categoria === "device-ws-diagnostico")), "the diagnostic is logged");
  const linha = capturado.find((l) => l.categoria === "device-ws-diagnostico");
  assert.deepEqual(linha.detalhes, {
    sala: SALA,
    reinicio: "brownout",
    uptimeS: 3600,
    heapLivre: 151000,
    heapMinimo: 98000,
    heapMaiorBloco: 69000,
    quedasWifi: 2,
    motivoWifi: 200,
    quedasWs: 3,
  });

  capturado.length = 0;
  ws.send(JSON.stringify({ tipo: "info", fw: "4.5.0" }));
  ws.send(JSON.stringify({ tipo: "info", fw: "4.5.1", diagnostico: { reinicio: "texto livre <script>", uptimeS: 1.5, heapLivre: "100" } }));
  await espera(200);
  assert.equal(capturado.filter((l) => l.categoria === "device-ws-diagnostico").length, 0, "an older firmware or invalid values log nothing");

  ws.terminate();
});

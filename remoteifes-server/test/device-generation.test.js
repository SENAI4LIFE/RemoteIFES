process.env.NODE_ENV = "test";
process.env.REMOTEIFES_DB_PATH = ":memory:";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { WebSocketServer } = require("ws");
require("../src/app");
const db = require("../src/config/database");
const hub = require("../src/services/deviceHub");

test("frames pendentes do socket substituido nao alteram telemetria nem logs", (t) => {
  let servidorWs;
  t.mock.method(WebSocketServer.prototype, "on", function (evento, listener) {
    servidorWs = this;
    return EventEmitter.prototype.on.call(this, evento, listener);
  });
  hub.iniciar(new EventEmitter());
  t.after(() => hub.encerrar());
  const mac = "AA:BB:CC:00:00:01";
  db.prepare("UPDATE salas SET mac = ?, temperatura = 24 WHERE sala = 'A-108'").run(mac);
  const req = { headers: { "x-device-sala": "A-108", "x-device-mac": mac }, socket: { remoteAddress: "127.0.0.1" } };
  function conectar() {
    const ws = new EventEmitter();
    Object.assign(ws, { OPEN: 1, readyState: 1, send() {}, close() { this.readyState = 2; } });
    servidorWs.emit("connection", ws, req);
    return ws;
  }
  const antiga = conectar();
  const nova = conectar();
  nova.emit("message", Buffer.from(JSON.stringify({ tipo: "telemetria", temp: 25 })));
  const totalLogs = db.prepare("SELECT COUNT(*) n FROM comandos_log").get().n;
  antiga.emit("message", Buffer.from(JSON.stringify({ tipo: "telemetria", temp: 17 })));
  antiga.emit("message", Buffer.from(JSON.stringify({ tipo: "comando", cmd: "controle_nativo", valor: "atrasado" })));
  antiga.emit("close", 4002, Buffer.alloc(0));
  assert.equal(db.prepare("SELECT temperatura FROM salas WHERE sala = 'A-108'").get().temperatura, 25);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM comandos_log").get().n, totalLogs);
  assert.equal(hub.estadoPublico("A-108").ultimaTelemetria.temp, 25);
  assert.equal(hub.estadoPublico("A-108").conectado, true);
});

test.after(() => db.close());

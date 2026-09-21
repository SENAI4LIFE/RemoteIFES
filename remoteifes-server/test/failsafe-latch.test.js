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
const protocolos = require("../src/services/protocolosIrService");

let server;
let wsUrl;
const abertos = new Set();

function sala(codigo, mac, ligado) {
  db.prepare("INSERT OR IGNORE INTO salas (sala, nome, bloco, andar, mac, ligado, temperaturaAlvo, irProtocolo) VALUES (?, ?, 'A', 1, ?, ?, 23, 16)").run(codigo, codigo, mac, ligado ? 1 : 0);
}

function esperar(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function ate(condicao, limiteMs = 3000) {
  const inicio = Date.now();
  while (!condicao() && Date.now() - inicio < limiteMs) await esperar(10);
  return condicao();
}

async function conectar(codigo, mac) {
  const mensagens = [];
  const ws = new WebSocket(wsUrl, { headers: { "x-device-sala": codigo, "x-device-mac": mac } });
  abertos.add(ws);
  ws.on("message", (d) => mensagens.push(JSON.parse(d.toString())));
  ws.once("close", () => abertos.delete(ws));
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  return { ws, mensagens, enviar: (m) => ws.send(JSON.stringify(m)), estados: () => mensagens.filter((m) => m.tipo === "send_known_state") };
}

const INFO_BASE = { tipo: "info", fw: "4.2.0", failsafeConfigurado: true, failsafePulsos: 4, failsafeCarrierHz: 38000, failsafeProtocolRecordId: 1 };

test.before(async () => {
  server = http.createServer(app);
  statusHub.iniciar(server);
  deviceHub.iniciar(server);
  await new Promise((r) => server.listen(0, r));
  wsUrl = `ws://127.0.0.1:${server.address().port}/ws/dispositivo`;
});

test.after(async () => {
  for (const ws of abertos) {
    try { ws.terminate(); } catch (erro) {}
  }
  deviceHub.encerrar();
  statusHub.encerrar();
  await new Promise((r) => server.close(r));
});

test("um OFF local travado na placa não é desfeito pelo estado ligado que o servidor ainda guardava", async () => {
  sala("LATCH-1", "AA:BB:CC:F5:00:01", true);
  let mudancas = 0;
  const ouvinte = () => { mudancas += 1; };
  salasService.eventos.on("mudanca", ouvinte);
  const d = await conectar("LATCH-1", "AA:BB:CC:F5:00:01");
  await ate(() => d.mensagens.some((m) => m.tipo === "device_role"));
  assert.equal(d.estados().length, 0, "nenhum estado é empurrado antes da placa se apresentar");
  d.enviar({ ...INFO_BASE, failsafeLatched: true, ligado: false });
  await ate(() => deviceHub.estadoPublico("LATCH-1").failsafe?.latched === true);
  await esperar(150);
  assert.equal(d.estados().length, 0, "o servidor não reenvia power=true sobre um failsafe local");
  const row = salasService.buscar("LATCH-1");
  assert.equal(row.ligado, 0);
  assert.equal(row.turboAtivo, 0);
  assert.ok(db.prepare("SELECT 1 FROM comandos_log WHERE sala = 'LATCH-1' AND cmd = 'failsafe_off_local' AND valor = 'mantido_na_reconexao' AND origem = 'esp32_local'").get());
  assert.ok(mudancas >= 1, "os navegadores são avisados que a sala está desligada");
  salasService.eventos.removeListener("mudanca", ouvinte);

  d.enviar({ ...INFO_BASE, failsafeLatched: true, ligado: false });
  await esperar(100);
  assert.equal(d.estados().length, 0, "um segundo info não muda nada");

  salasService.aplicarComando("LATCH-1", "ligar", undefined, { usuario: { id: 1, usuario: "superadmin", isAdmin: true, podeControlar: true }, origem: "manual" });
  assert.ok(await ate(() => d.estados().length === 1), "um comando explícito continua chegando à placa");
  assert.equal(d.estados()[0].power, true);
  d.enviar({ tipo: "telemetria", fw: "4.2.0", modo: "operation", ligado: true, failsafeConfigurado: true, failsafePulsos: 4, failsafeCarrierHz: 38000, failsafeProtocolRecordId: 1, failsafeLatched: false });
  await ate(() => deviceHub.estadoPublico("LATCH-1").failsafe?.latched === false);
  assert.equal(deviceHub.estadoPublico("LATCH-1").failsafe.latched, false);
  d.ws.close();
});

test("firmware 4.1.0 (sem latch) recebe o estado do servidor logo depois do info, como antes", async () => {
  sala("LATCH-2", "AA:BB:CC:F5:00:02", true);
  const d = await conectar("LATCH-2", "AA:BB:CC:F5:00:02");
  await ate(() => d.mensagens.some((m) => m.tipo === "device_role"));
  assert.equal(d.estados().length, 0);
  d.enviar({ tipo: "info", fw: "4.1.0", failsafeConfigurado: false, failsafePulsos: 0, failsafeCarrierHz: 0, failsafeProtocolRecordId: -1 });
  assert.ok(await ate(() => d.estados().length === 1));
  assert.equal(d.estados()[0].power, true);
  assert.equal(d.estados()[0].protocol, 16);
  assert.equal(deviceHub.estadoPublico("LATCH-2").failsafe.latched, false);
  assert.equal(salasService.buscar("LATCH-2").ligado, 1);
  d.ws.close();
});

test("firmware que nunca envia info recebe o estado após a espera de segurança", async () => {
  sala("LATCH-3", "AA:BB:CC:F5:00:03", true);
  const d = await conectar("LATCH-3", "AA:BB:CC:F5:00:03");
  await esperar(1500);
  assert.equal(d.estados().length, 0, "ainda dentro da espera");
  assert.ok(await ate(() => d.estados().length === 1, 4000));
  assert.equal(d.estados()[0].power, true);
  d.ws.close();
});

test("a desconexão durante a espera cancela a sincronização pendente", async () => {
  sala("LATCH-4", "AA:BB:CC:F5:00:04", true);
  const d = await conectar("LATCH-4", "AA:BB:CC:F5:00:04");
  await ate(() => d.mensagens.some((m) => m.tipo === "device_role"));
  d.ws.close();
  await ate(() => !deviceHub.estadoPublico("LATCH-4").conectado);
  await esperar(3300);
  assert.equal(d.estados().length, 0);
});

test("um RAW cuja duração total passa de 2 s é recusado no servidor e nos testes de transmissão", () => {
  const longo = Array.from({ length: 40 }, () => 60000);
  assert.throws(() => protocolos.validarRaw(longo), /duração máxima/);
  assert.doesNotThrow(() => protocolos.validarRaw(Array.from({ length: 1024 }, () => 1900)));
});

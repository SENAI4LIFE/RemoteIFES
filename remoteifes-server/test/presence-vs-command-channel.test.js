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
const monitoramentoService = require("../src/services/monitoramentoService");

let server;
let baseUrl;
let wsUrl;
const abertos = new Set();
const ADMIN = { usuario: { id: 1, usuario: "superadmin", isAdmin: true, podeControlar: true, nivel: 3 }, origem: "manual" };

function sala(codigo, mac) {
  db.prepare("INSERT INTO salas (sala, nome, bloco, andar, mac, temperaturaAlvo, irProtocolo) VALUES (?, ?, 'A', 1, ?, 23, 16)").run(codigo, codigo, mac);
}

function esperar(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function ate(condicao, limiteMs = 3000) {
  const inicio = Date.now();
  while (!condicao() && Date.now() - inicio < limiteMs) await esperar(10);
  return condicao();
}

function status(codigo) {
  return salasService.statusCompleto(codigo, ADMIN.usuario);
}

function naoEntregues() {
  return monitoramentoService.coletar().falhas.contadores.comandoNaoEntregue;
}

async function conectarPlaca(codigo, mac) {
  const mensagens = [];
  const ws = new WebSocket(wsUrl, { headers: { "x-device-sala": codigo, "x-device-mac": mac } });
  abertos.add(ws);
  ws.on("message", (d) => mensagens.push(JSON.parse(d.toString())));
  ws.once("close", () => abertos.delete(ws));
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  await ate(() => mensagens.some((m) => m.tipo === "device_role"));
  return {
    ws,
    estados: () => mensagens.filter((m) => m.tipo === "send_known_state"),
    enviar: (m) => ws.send(JSON.stringify(m)),
    fechar: async () => { ws.close(); await ate(() => !deviceHub.estadoPublico(codigo).conectado); },
  };
}

async function conectarPainel(token, codigo) {
  const recebidas = [];
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`, token);
  abertos.add(ws);
  ws.on("message", (d) => recebidas.push(JSON.parse(d.toString())));
  ws.once("close", () => abertos.delete(ws));
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  ws.send(JSON.stringify({ tipo: "observar", sala: codigo }));
  await ate(() => recebidas.some((m) => m.tipo === "status" && m.status.sala === codigo));
  return { ws, statuses: () => recebidas.filter((m) => m.tipo === "status" && m.status.sala === codigo).map((m) => m.status) };
}

async function login() {
  const resp = await fetch(`${baseUrl}/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ usuario: "superadmin", senha: "admin" }) });
  return (await resp.json()).token;
}

test.before(async () => {
  server = http.createServer(app);
  statusHub.iniciar(server);
  deviceHub.iniciar(server);
  await new Promise((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  wsUrl = `${baseUrl.replace("http", "ws")}/ws/dispositivo`;
});

test.after(async () => {
  for (const ws of abertos) {
    try { ws.terminate(); } catch (erro) {}
  }
  deviceHub.encerrar();
  statusHub.encerrar();
  await new Promise((r) => server.close(r));
  db.close();
});

test("seen through an HTTP heartbeat without a socket: online but without a command channel, and the command is not submitted", async () => {
  sala("PC-1", "AA:BB:CC:F0:00:01");
  assert.equal(status("PC-1").online, false);
  assert.equal(status("PC-1").canalComandos, false);

  salasService.heartbeatDispositivo("PC-1", { temperatura: 24 }, "AA:BB:CC:F0:00:01", "127.0.0.1");
  const antes = status("PC-1");
  assert.equal(antes.online, true, "the HTTP heartbeat marks presence");
  assert.equal(antes.canalComandos, false, "but does not open a command channel");
  assert.equal(antes.dispositivoConfirmou, null);

  const contagem = naoEntregues();
  const resultado = salasService.aplicarComando("PC-1", "ligar", undefined, ADMIN);
  assert.equal(resultado.ligado, 1, "the desired state is persisted");
  assert.equal(resultado.online, 1);
  assert.equal(resultado.enviadoAoDispositivo, false, "nothing was submitted to the board");
  assert.equal(resultado.canalComandos, false, "the response says why: there is no command socket");
  assert.equal(resultado.avisoDispositivoOffline, false, "and it is not the offline case");
  assert.equal(naoEntregues(), contagem + 1);
  assert.equal(status("PC-1").dispositivoConfirmou, null, "without a board on the socket there is no confirmation to wait for");
});

test("the /comando route returns the same distinction to the panel", async () => {
  sala("PC-2", "AA:BB:CC:F0:00:02");
  salasService.heartbeatDispositivo("PC-2", { temperatura: 24 }, "AA:BB:CC:F0:00:02", "127.0.0.1");
  const token = await login();
  const resp = await fetch(`${baseUrl}/comando`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ sala: "PC-2", cmd: "ligar" }) });
  assert.equal(resp.status, 200);
  const corpo = await resp.json();
  assert.equal(corpo.ok, true);
  assert.equal(corpo.sala.online, 1);
  assert.equal(corpo.sala.canalComandos, false);
  assert.equal(corpo.sala.enviadoAoDispositivo, false);
  const st = await (await fetch(`${baseUrl}/status?sala=PC-2`, { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(st.online, true);
  assert.equal(st.canalComandos, false);
});

test("when the socket reconnects, the channel returns, the observing panel is notified and the next command is submitted", async () => {
  sala("PC-3", "AA:BB:CC:F0:00:03");
  salasService.heartbeatDispositivo("PC-3", { temperatura: 24 }, "AA:BB:CC:F0:00:03", "127.0.0.1");
  const token = await login();
  const painel = await conectarPainel(token, "PC-3");
  assert.equal(painel.statuses().at(-1).canalComandos, false);
  const pendente = salasService.aplicarComando("PC-3", "ligar", undefined, ADMIN);
  assert.equal(pendente.enviadoAoDispositivo, false);

  const placa = await conectarPlaca("PC-3", "AA:BB:CC:F0:00:03");
  assert.equal(status("PC-3").online, true);
  assert.equal(status("PC-3").canalComandos, true, "the open socket is the command channel");
  assert.ok(await ate(() => painel.statuses().at(-1).canalComandos === true), "the observer receives the status without waiting for the periodic rebroadcast");

  placa.enviar({ tipo: "info", fw: "4.3.0", failsafeConfigurado: false, failsafeLatched: false });
  assert.ok(await ate(() => placa.estados().length === 1));
  assert.equal(placa.estados()[0].power, true, "reconnection restores the intent persisted while there was no channel");
  assert.equal(placa.estados()[0].restauracao, true);

  const contagem = naoEntregues();
  const resultado = salasService.aplicarComando("PC-3", "temperatura", 25, ADMIN);
  assert.equal(resultado.enviadoAoDispositivo, true);
  assert.equal(resultado.canalComandos, true);
  assert.equal(naoEntregues(), contagem);
  assert.ok(await ate(() => placa.estados().length === 2));
  assert.equal(placa.estados()[1].temp, 25);
  assert.equal(status("PC-3").dispositivoConfirmou, false, "submitted is not confirmed");

  await placa.fechar();
  assert.equal(status("PC-3").online, false, "the socket close is authoritative");
  assert.equal(status("PC-3").canalComandos, false);
  assert.ok(await ate(() => painel.statuses().at(-1).canalComandos === false && painel.statuses().at(-1).online === false));
  painel.ws.close();
});

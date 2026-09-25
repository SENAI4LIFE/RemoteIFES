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
const configuracoesService = require("../src/services/configuracoesService");
const notificacoesService = require("../src/services/notificacoesService");

let server;
let baseWsDispositivoUrl;
const socketsAbertos = new Set();
const SUPERADMIN = { id: 1, nivel: 3 };

function novaSalaComMac(sala, mac) {
  db.prepare(`INSERT OR IGNORE INTO salas (sala, nome, bloco, andar, mac) VALUES (?, ?, 'A', 1, ?)`).run(sala, sala, mac);
}

function conectar(sala, mac) {
  const ws = new WebSocket(baseWsDispositivoUrl, { headers: { "x-device-mac": mac, "x-device-sala": sala } });
  socketsAbertos.add(ws);
  ws.once("close", () => socketsAbertos.delete(ws));
  return ws;
}

function aoAbrir(ws) {
  return new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
}

function online(sala) {
  return !!db.prepare(`SELECT online FROM salas WHERE sala = ?`).get(sala).online;
}

function eventos(sala) {
  return db.prepare(`SELECT status FROM esp_eventos WHERE sala = ? ORDER BY id`).all(sala).map((l) => l.status);
}

function notificacoesOffline(sala) {
  return db.prepare(`SELECT COUNT(*) n FROM notificacoes WHERE tipo = 'esp32_offline' AND sala = ?`).get(sala).n;
}

// Waits for the room to go offline, measuring how long the authoritative transition took.
async function esperarOffline(sala, limiteMs) {
  const inicio = Date.now();
  while (Date.now() - inicio < limiteMs) {
    if (!online(sala)) return Date.now() - inicio;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`sala ${sala} continuou online por mais de ${limiteMs}ms`);
}

test.before(async () => {
  server = http.createServer(app);
  statusHub.iniciar(server);
  deviceHub.iniciar(server);
  await new Promise((resolve) => server.listen(0, resolve));
  baseWsDispositivoUrl = `ws://127.0.0.1:${server.address().port}/ws/dispositivo`;
});

test.after(async () => {
  for (const ws of socketsAbertos) {
    try { ws.terminate(); } catch (erro) {}
  }
  deviceHub.encerrar();
  statusHub.encerrar();
  await new Promise((resolve) => server.close(resolve));
});

test("a clean WebSocket close takes the room offline immediately, without waiting for the heartbeat to expire", async () => {
  novaSalaComMac("OFF-1", "AA:BB:CC:00:00:01");
  const ws = conectar("OFF-1", "AA:BB:CC:00:00:01");
  await aoAbrir(ws);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(online("OFF-1"), true, "a sala deveria estar online após o handshake");

  const mudancas = [];
  const ouvinte = () => mudancas.push(Date.now());
  salasService.eventos.on("mudanca", ouvinte);
  ws.close();
  const decorrido = await esperarOffline("OFF-1", 1000);
  salasService.eventos.removeListener("mudanca", ouvinte);

  assert.ok(decorrido < 500, `esperava transição imediata, levou ${decorrido}ms`);
  assert.deepEqual(eventos("OFF-1"), ["online", "offline"]);
  assert.ok(mudancas.length >= 1, "a mudança de estado precisa ser difundida ao navegador");
});

test("the device notification follows the authoritative offline transition", async () => {
  novaSalaComMac("OFF-2", "AA:BB:CC:00:00:02");
  const ws = conectar("OFF-2", "AA:BB:CC:00:00:02");
  await aoAbrir(ws);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(notificacoesOffline("OFF-2"), 0);

  ws.close();
  await esperarOffline("OFF-2", 1000);
  assert.equal(notificacoesOffline("OFF-2"), 1, "a notificação sai junto com o estado offline");
});

test("a silent loss falls through the heartbeat timeout and produces a single transition", async () => {
  novaSalaComMac("OFF-3", "AA:BB:CC:00:00:03");
  const ws = conectar("OFF-3", "AA:BB:CC:00:00:03");
  await aoAbrir(ws);
  await new Promise((r) => setTimeout(r, 50));

  // Simulates a device that vanished without closing: the socket stays open but nothing arrives.
  db.prepare(`UPDATE salas SET ultimoHeartbeat = datetime('now', '-10 minutes') WHERE sala = ?`).run("OFF-3");
  salasService.verificarTimeouts();

  assert.equal(online("OFF-3"), false);
  assert.deepEqual(eventos("OFF-3"), ["online", "offline"]);
  assert.equal(notificacoesOffline("OFF-3"), 1);

  // A second sweep must not repeat the event or the notification.
  salasService.verificarTimeouts();
  assert.deepEqual(eventos("OFF-3"), ["online", "offline"]);
  assert.equal(notificacoesOffline("OFF-3"), 1);
});

test("reconnection restores the online state and a new drop produces a single notification per hour", async () => {
  novaSalaComMac("OFF-4", "AA:BB:CC:00:00:04");
  const primeira = conectar("OFF-4", "AA:BB:CC:00:00:04");
  await aoAbrir(primeira);
  await new Promise((r) => setTimeout(r, 50));
  primeira.close();
  await esperarOffline("OFF-4", 1000);
  assert.equal(notificacoesOffline("OFF-4"), 1);

  const segunda = conectar("OFF-4", "AA:BB:CC:00:00:04");
  await aoAbrir(segunda);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(online("OFF-4"), true, "reconectar precisa restaurar o estado online");

  segunda.close();
  await esperarOffline("OFF-4", 1000);
  assert.deepEqual(eventos("OFF-4"), ["online", "offline", "online", "offline"]);
  assert.equal(notificacoesOffline("OFF-4"), 1, "quedas seguidas não podem virar uma enxurrada de avisos");
});

test("marcarOffline is idempotent: a room already offline produces no event or notification", () => {
  novaSalaComMac("OFF-5", "AA:BB:CC:00:00:05");
  assert.equal(salasService.marcarOffline("OFF-5"), false);
  assert.deepEqual(eventos("OFF-5"), []);
  assert.equal(notificacoesOffline("OFF-5"), 0);
});

test("the access point policy ships disabled and the AP is open by default", () => {
  assert.equal(configuracoesService.PADROES.espApExigirCredencial, false);
  assert.equal(configuracoesService.obter().espApExigirCredencial, false);
  assert.deepEqual(configuracoesService.politicaApDispositivo(), { tipo: "config_ap", exigirCredencial: false });
});

test("the device receives the access point policy in the handshake and when it changes", async () => {
  novaSalaComMac("AP-1", "AA:BB:CC:00:00:11");
  const ws = conectar("AP-1", "AA:BB:CC:00:00:11");
  const recebidas = [];
  ws.on("message", (dados) => {
    const msg = JSON.parse(dados.toString());
    if (msg.tipo === "config_ap") recebidas.push(msg);
  });
  await aoAbrir(ws);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(recebidas, [{ tipo: "config_ap", exigirCredencial: false }], "o AP aberto é anunciado já na conexão");

  configuracoesService.validarEAtualizar({ espApExigirCredencial: true }, SUPERADMIN);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(configuracoesService.obter().espApExigirCredencial, true);
  assert.deepEqual(recebidas.at(-1), { tipo: "config_ap", exigirCredencial: true }, "ligar a exigência avisa quem já está conectado");

  configuracoesService.validarEAtualizar({ espApExigirCredencial: false }, SUPERADMIN);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(recebidas.at(-1), { tipo: "config_ap", exigirCredencial: false });
  ws.close();
});

test("the AP password does not interfere with device authentication on the server", async () => {
  const antes = configuracoesService.obter().espCredenciaisObrigatorias;
  configuracoesService.validarEAtualizar({ espApExigirCredencial: true }, SUPERADMIN);
  assert.equal(configuracoesService.obter().espCredenciaisObrigatorias, antes,
    "mexer na rede de configuração não pode alterar a exigência de credencial no servidor");

  novaSalaComMac("AP-2", "AA:BB:CC:00:00:12");
  const ws = conectar("AP-2", "AA:BB:CC:00:00:12");
  await aoAbrir(ws);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(online("AP-2"), true, "a conexão por MAC continua válida com o AP protegido");
  ws.close();
  configuracoesService.validarEAtualizar({ espApExigirCredencial: false }, SUPERADMIN);
});

test("only the superadministrator changes the access point policy", () => {
  assert.throws(
    () => configuracoesService.validarEAtualizar({ espApExigirCredencial: true }, { id: 2, nivel: 2 }),
    /superadministrador/
  );
  assert.equal(configuracoesService.obter().espApExigirCredencial, false);
});

test("the energy estimate no longer exists: no route, no service and no per-room configuration", async () => {
  const bcrypt = require("bcryptjs");
  db.prepare(`UPDATE usuarios SET senhaHash = ? WHERE usuario = 'superadmin'`).run(bcrypt.hashSync("superSenha123", 10));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usuario: "superadmin", senha: "superSenha123" }),
  });
  const { token } = await login.json();

  for (const [caminho, metodo] of [["/admin/energia", "GET"], ["/admin/energia/A-101", "PATCH"]]) {
    const resp = await fetch(`${baseUrl}${caminho}`, {
      method: metodo,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: metodo === "PATCH" ? JSON.stringify({ potenciaWatts: 1200 }) : undefined,
    });
    assert.equal(resp.status, 404, `${metodo} ${caminho} não deveria existir`);
  }

  assert.throws(() => require("../src/services/energiaService"), /Cannot find module/);
  assert.ok(!Object.keys(configuracoesService.PADROES).some((c) => /energia/i.test(c)));

  // Monitoring, which is independent, keeps answering.
  const monitoramento = await fetch(`${baseUrl}/admin/monitoramento`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(monitoramento.status, 200);
  const corpo = await monitoramento.json();
  assert.ok(corpo.ok && corpo.monitoramento && corpo.monitoramento.esp32, "o monitoramento operacional precisa continuar íntegro");
  assert.ok(!JSON.stringify(corpo).match(/energia/i), "nenhum resíduo de energia pode voltar no monitoramento");
});

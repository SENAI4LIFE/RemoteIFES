process.env.REMOTEIFES_DB_PATH = process.env.REMOTEIFES_DB_PATH || ":memory:";
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
const usuariosService = require("../src/services/usuariosService");
const tokenService = require("../src/services/tokenService");

let server;
let baseUrl;
let baseWsUrl;
let baseWsDispositivoUrl;

test.before(async () => {
  server = http.createServer(app);
  statusHub.iniciar(server);
  deviceHub.iniciar(server);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  baseWsUrl = `ws://127.0.0.1:${server.address().port}/ws`;
  baseWsDispositivoUrl = `ws://127.0.0.1:${server.address().port}/ws/dispositivo`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function novaSalaComMac(sala, mac) {
  db.prepare(
    `INSERT OR IGNORE INTO salas (sala, nome, bloco, andar, mac) VALUES (?, ?, 'A', 1, ?)`
  ).run(sala, sala, mac);
}

async function login(usuario, senha) {
  const resp = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usuario, senha }),
  });
  const corpo = await resp.json();
  return { status: resp.status, corpo };
}

function authFetch(path, token, opcoes = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...opcoes,
    headers: {
      ...(opcoes.headers || {}),
      "Content-Type": "application/json",
      Authorization: token ? `Bearer ${token}` : undefined,
    },
  });
}

async function tokenSuperAdmin() {
  const bcrypt = require("bcryptjs");
  db.prepare(`UPDATE usuarios SET senhaHash = ? WHERE usuario = 'superadmin'`).run(bcrypt.hashSync("superSenha123", 10));
  const resp = await login("superadmin", "superSenha123");
  return resp.corpo.token;
}

test("um admin comum (não superadmin) recebe 403 nas rotas /admin/esp32", async () => {
  usuariosService.criar(
    { usuario: "teste-esp32-admin-comum", senha: "senhaSegura123", nome: "Admin Comum", isAdmin: true },
    { nivel: 3 }
  );
  const { corpo } = await login("teste-esp32-admin-comum", "senhaSegura123");
  const resp = await authFetch("/admin/esp32/dispositivos", corpo.token);
  assert.equal(resp.status, 403);
});

test("comando para dispositivo desconectado retorna 409", async () => {
  novaSalaComMac("teste-esp32-offline", "AA:BB:CC:DD:EE:01");
  const token = await tokenSuperAdmin();
  const resp = await authFetch("/admin/esp32/teste-esp32-offline/captura/iniciar", token, { method: "POST" });
  assert.equal(resp.status, 409);
});

test("dispositivo conecta via WS, envia telemetria, e recebe comandos retransmitidos pelo servidor", async () => {
  novaSalaComMac("teste-esp32-online", "AA:BB:CC:DD:EE:02");

  const ws = new WebSocket(baseWsDispositivoUrl, {
    headers: {
      "x-device-sala": "teste-esp32-online",
      "x-device-mac": "AA:BB:CC:DD:EE:02",
    },
  });

  const mensagens = [];
  ws.on("message", (dados) => {
    mensagens.push(JSON.parse(dados.toString()));
  });

  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  ws.send(JSON.stringify({
    tipo: "telemetria",
    temp: 23.5,
    hum: 55,
    rssi: -60,
    modo: "operation",
    ligado: true,
    ultimoComando: { tipo: "known_state", protocol: 5, temp: 22, power: true },
  }));

  await new Promise((resolve) => setTimeout(resolve, 150));

  const sala = db.prepare(`SELECT * FROM salas WHERE sala = ?`).get("teste-esp32-online");
  assert.equal(sala.online, 1);
  assert.equal(sala.temperatura, 23.5);
  assert.equal(sala.ligado, 1);

  const estado = deviceHub.estadoPublico("teste-esp32-online");
  assert.equal(estado.conectado, true);
  assert.equal(estado.ultimaTelemetria.temp, 23.5);
  assert.equal(estado.ultimoComando.protocol, 5);

  const token = await tokenSuperAdmin();
  const respEntrarConfig = await authFetch("/admin/esp32/teste-esp32-online/entrar-config", token, {
    method: "POST",
  });
  assert.equal(respEntrarConfig.status, 200);

  await new Promise((resolve) => setTimeout(resolve, 100));
  const recebidoPeloDispositivo = mensagens.find((m) => m.tipo === "enter_config");
  assert.ok(recebidoPeloDispositivo, "o dispositivo deve receber o comando enter_config retransmitido");
  assert.equal(Object.prototype.hasOwnProperty.call(recebidoPeloDispositivo, "senha"), false);

  ws.close();
});

test("telemetria com valores fora de faixa não corrompe estado nem broadcast", async () => {
  novaSalaComMac("teste-esp32-telemetria-ruim", "AA:BB:CC:DD:EE:07");
  db.prepare(`UPDATE salas SET temperatura = 22 WHERE sala = ?`).run("teste-esp32-telemetria-ruim");

  const ws = new WebSocket(baseWsDispositivoUrl, {
    headers: {
      "x-device-sala": "teste-esp32-telemetria-ruim",
      "x-device-mac": "AA:BB:CC:DD:EE:07",
    },
  });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  ws.send(JSON.stringify({ tipo: "telemetria", temp: 9999, hum: -5, rssi: 40, modo: '<img src=x onerror=alert(1)>' }));
  await new Promise((resolve) => setTimeout(resolve, 120));

  const sala = db.prepare(`SELECT temperatura FROM salas WHERE sala = ?`).get("teste-esp32-telemetria-ruim");
  assert.equal(sala.temperatura, 22, "temperatura absurda não deve sobrescrever o banco");

  const estado = deviceHub.estadoPublico("teste-esp32-telemetria-ruim");
  assert.equal(estado.ultimaTelemetria.temp, null, "temp fora de faixa não deve ir para a telemetria pública");
  assert.equal(estado.ultimaTelemetria.hum, null, "umidade fora de faixa não deve ir para a telemetria pública");
  assert.equal(estado.modo, "operation", "modo desconhecido não deve chegar à interface administrativa");

  ws.close();
});

test("painel ESP32 observa mais de 20 salas sem acionar o limite de flood", async () => {
  const token = await tokenSuperAdmin();
  const ws = new WebSocket(baseWsUrl, [token]);
  const mensagens = [];
  ws.on("message", (dados) => mensagens.push(JSON.parse(dados.toString())));
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  const salasObservadas = Array.from({ length: 30 }, (_, i) => `sala-observada-${i + 1}`);
  ws.send(JSON.stringify({ tipo: "observar_dispositivos", salas: salasObservadas }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  mensagens.length = 0;

  deviceHub.eventos.emit("telemetria", { sala: "sala-observada-1", estado: { conectado: true } });
  deviceHub.eventos.emit("telemetria", { sala: "sala-observada-30", estado: { conectado: true } });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const salasRecebidas = mensagens
    .filter((m) => m.tipo === "dispositivo_status")
    .map((m) => m.sala)
    .sort();
  assert.deepEqual(salasRecebidas, ["sala-observada-1", "sala-observada-30"]);
  assert.equal(ws.readyState, WebSocket.OPEN);
  ws.close();
});

test("rota de entrar-config não exige senha do dispositivo", async () => {
  novaSalaComMac("teste-esp32-sem-senha", "AA:BB:CC:DD:EE:03");

  const ws = new WebSocket(baseWsDispositivoUrl, {
    headers: {
      "x-device-sala": "teste-esp32-sem-senha",
      "x-device-mac": "AA:BB:CC:DD:EE:03",
    },
  });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  const token = await tokenSuperAdmin();
  const resp = await authFetch("/admin/esp32/teste-esp32-sem-senha/entrar-config", token, {
    method: "POST",
    body: JSON.stringify({}),
  });
  assert.equal(resp.status, 200);
  ws.close();
});

test("início de agendamento envia um único estado IR final", async () => {
  novaSalaComMac("teste-agendamento-ir", "AA:BB:CC:DD:EE:04");
  db.prepare(`UPDATE salas SET irProtocolo = 5 WHERE sala = ?`).run("teste-agendamento-ir");
  const ws = new WebSocket(baseWsDispositivoUrl, {
    headers: {
      "x-device-sala": "teste-agendamento-ir",
      "x-device-mac": "AA:BB:CC:DD:EE:04",
    },
  });
  const mensagens = [];
  ws.on("message", (dados) => mensagens.push(JSON.parse(dados.toString())));
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const quantidadeAntes = mensagens.length;

  salasService.aplicarInicioAgendamento("teste-agendamento-ir", 24);
  await new Promise((resolve) => setTimeout(resolve, 50));

  const novosEstados = mensagens.slice(quantidadeAntes).filter((msg) => msg.tipo === "send_known_state");
  assert.equal(novosEstados.length, 1);
  assert.equal(novosEstados[0].power, true);
  assert.equal(novosEstados[0].temp, 24);
  ws.close();
});

test("alterar o vínculo MAC encerra a conexão antiga", async () => {
  novaSalaComMac("teste-mac-revogado", "AA:BB:CC:DD:EE:05");
  const ws = new WebSocket(baseWsDispositivoUrl, {
    headers: {
      "x-device-sala": "teste-mac-revogado",
      "x-device-mac": "AA:BB:CC:DD:EE:05",
    },
  });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const fechado = new Promise((resolve) => ws.once("close", resolve));
  salasService.cadastrarMac("teste-mac-revogado", "AA:BB:CC:DD:EE:06");
  await fechado;
  assert.equal(deviceHub.dispositivoConectado("teste-mac-revogado"), false);
});

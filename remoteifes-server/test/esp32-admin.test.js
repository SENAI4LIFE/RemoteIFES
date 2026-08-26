process.env.REMOTEIFES_DB_PATH = process.env.REMOTEIFES_DB_PATH || ":memory:";
process.env.DEVICE_TOKEN = process.env.DEVICE_TOKEN || "test-only-device-token";
process.env.NODE_ENV = "test";

const http = require("http");
const test = require("node:test");
const assert = require("node:assert/strict");
const WebSocket = require("ws");

const db = require("../src/config/database");
const app = require("../src/app");
const statusHub = require("../src/services/statusHub");
const deviceHub = require("../src/services/deviceHub");
const usuariosService = require("../src/services/usuariosService");
const tokenService = require("../src/services/tokenService");

let server;
let baseUrl;
let baseWsDispositivoUrl;

test.before(async () => {
  server = http.createServer(app);
  statusHub.iniciar(server);
  deviceHub.iniciar(server);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
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
  db.prepare(`UPDATE usuarios SET senhaHash = ? WHERE usuario = 'admin'`).run(bcrypt.hashSync("superSenha123", 10));
  const resp = await login("admin", "superSenha123");
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
      "x-device-token": "test-only-device-token",
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
    body: JSON.stringify({ senha: "admin1234" }),
  });
  assert.equal(respEntrarConfig.status, 200);

  await new Promise((resolve) => setTimeout(resolve, 100));
  const recebidoPeloDispositivo = mensagens.find((m) => m.tipo === "enter_config");
  assert.ok(recebidoPeloDispositivo, "o dispositivo deve receber o comando enter_config retransmitido");
  assert.equal(recebidoPeloDispositivo.senha, "admin1234");

  ws.close();
});

test("rota de entrar-config exige senha mesmo com dispositivo conectado", async () => {
  novaSalaComMac("teste-esp32-sem-senha", "AA:BB:CC:DD:EE:03");

  const ws = new WebSocket(baseWsDispositivoUrl, {
    headers: {
      "x-device-token": "test-only-device-token",
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
  assert.equal(resp.status, 400);
  ws.close();
});

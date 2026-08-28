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
const configuracoesService = require("../src/services/configuracoesService");
const logger = require("../src/utils/logger");

let server;
let baseUrl;
let baseWsDispositivoUrl;
const socketsAbertos = new Set();

function novaSalaComMac(sala, mac) {
  db.prepare(`INSERT OR IGNORE INTO salas (sala, nome, bloco, andar, mac) VALUES (?, ?, 'A', 1, ?)`).run(sala, sala, mac);
}

async function login(usuario, senha) {
  const resp = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usuario, senha }),
  });
  return (await resp.json()).token;
}

function authFetch(caminho, token, opcoes = {}) {
  return fetch(`${baseUrl}${caminho}`, {
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
  return login("admin", "superSenha123");
}

function abrirWs(headers) {
  const ws = new WebSocket(baseWsDispositivoUrl, { headers });
  socketsAbertos.add(ws);
  ws.once("close", () => socketsAbertos.delete(ws));
  return ws;
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

function assentar(ws, ms = 200) {
  return new Promise((resolve) => {
    let aberto = false;
    let fechado = false;
    let codigo = null;
    ws.once("open", () => {
      aberto = true;
    });
    ws.once("close", (code) => {
      fechado = true;
      codigo = code;
      resolve({ aberto, fechado, codigo });
    });
    ws.once("error", () => {});
    setTimeout(() => resolve({ aberto, fechado, codigo }), ms);
  });
}

async function esperaAceita(ws) {
  const r = await assentar(ws);
  assert.ok(r.aberto && !r.fechado, `esperava conexão aceita, obtive ${JSON.stringify(r)}`);
}

async function esperaRecusada(ws) {
  const r = await assentar(ws);
  assert.ok(r.fechado, `esperava conexão recusada, obtive ${JSON.stringify(r)}`);
}

test.before(async () => {
  server = http.createServer(app);
  statusHub.iniciar(server);
  deviceHub.iniciar(server);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  baseWsDispositivoUrl = `ws://127.0.0.1:${server.address().port}/ws/dispositivo`;
});

test.after(async () => {
  for (const ws of socketsAbertos) {
    try {
      ws.terminate();
    } catch {}
  }
  deviceHub.encerrar();
  statusHub.encerrar();
  await new Promise((resolve) => server.close(resolve));
});

test("provisionar entrega id + segredo uma vez; provisionar de novo é rejeitado", async () => {
  novaSalaComMac("cred-1", "AA:CC:00:00:00:01");
  const token = await tokenSuperAdmin();
  const resp = await authFetch("/admin/esp32/cred-1/credencial", token, { method: "POST" });
  assert.equal(resp.status, 200);
  const corpo = await resp.json();
  assert.match(corpo.deviceId, /^esp_[0-9a-f]{16}$/);
  assert.ok(corpo.segredo && corpo.segredo.length >= 40);

  const dupe = await authFetch("/admin/esp32/cred-1/credencial", token, { method: "POST" });
  assert.equal(dupe.status, 400);

  const estado = await (await authFetch("/admin/esp32/cred-1/estado", token)).json();
  const cred = estado.dispositivo.credencial;
  assert.equal(cred.provisionado, true);
  assert.equal("segredo" in cred, false);
  assert.equal("segredoHash" in cred, false);
});

test("dispositivo conecta por credencial mesmo sem MAC cadastrado para a sala", async () => {
  db.prepare(`INSERT OR IGNORE INTO salas (sala, nome, bloco, andar) VALUES ('cred-2', 'cred-2', 'A', 1)`).run();
  const { deviceId, segredo } = credenciaisService.provisionar("cred-2");

  const ws = abrirWs({ "x-device-id": deviceId, "x-device-secret": segredo });
  await esperaAceita(ws);
  assert.equal(deviceHub.dispositivoConectado("cred-2"), true);
  ws.close();
});

test("segredo incorreto derruba a conexão", async () => {
  db.prepare(`INSERT OR IGNORE INTO salas (sala, nome, bloco, andar) VALUES ('cred-3', 'cred-3', 'A', 1)`).run();
  const { deviceId } = credenciaisService.provisionar("cred-3");
  const ws = abrirWs({ "x-device-id": deviceId, "x-device-secret": "errado-errado-errado-errado-errado" });
  await esperaRecusada(ws);
});

test("revogar encerra a conexão ativa e recusa a reconexão", async () => {
  db.prepare(`INSERT OR IGNORE INTO salas (sala, nome, bloco, andar) VALUES ('cred-4', 'cred-4', 'A', 1)`).run();
  const { deviceId, segredo } = credenciaisService.provisionar("cred-4");
  const ws = abrirWs({ "x-device-id": deviceId, "x-device-secret": segredo });
  await esperaAceita(ws);

  const fechado = new Promise((resolve) => ws.once("close", resolve));
  credenciaisService.revogar("cred-4");
  await fechado;
  assert.equal(deviceHub.dispositivoConectado("cred-4"), false);

  const ws2 = abrirWs({ "x-device-id": deviceId, "x-device-secret": segredo });
  await esperaRecusada(ws2);
});

test("rotação: segredo antigo continua válido durante o período de tolerância", async () => {
  db.prepare(`INSERT OR IGNORE INTO salas (sala, nome, bloco, andar) VALUES ('cred-5', 'cred-5', 'A', 1)`).run();
  const antigo = credenciaisService.provisionar("cred-5");
  const novo = credenciaisService.rotacionar("cred-5");
  assert.notEqual(antigo.segredo, novo.segredo);
  assert.equal(antigo.deviceId, novo.deviceId);

  assert.ok(credenciaisService.verificar(novo.deviceId, novo.segredo));
  assert.ok(credenciaisService.verificar(antigo.deviceId, antigo.segredo), "segredo anterior aceito na janela de tolerância");
  assert.equal(credenciaisService.estado("cred-5").graceRotacaoAtivo, true);
});

test("modo brando: MAC-only continua funcionando quando não há credencial", async () => {
  novaSalaComMac("cred-6", "AA:CC:00:00:00:06");
  const ws = abrirWs({ "x-device-sala": "cred-6", "x-device-mac": "AA:CC:00:00:00:06" });
  await esperaAceita(ws);
  ws.close();
});

test("sala com credencial provisionada recusa MAC-only mesmo com a flag global desligada", async () => {
  novaSalaComMac("cred-7", "AA:CC:00:00:00:07");
  credenciaisService.provisionar("cred-7");
  const ws = abrirWs({ "x-device-sala": "cred-7", "x-device-mac": "AA:CC:00:00:00:07" });
  await esperaRecusada(ws);

  const heartbeat = await fetch(`${baseUrl}/dispositivo/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-device-mac": "AA:CC:00:00:00:07" },
    body: JSON.stringify({ sala: "cred-7", mac: "AA:CC:00:00:00:07" }),
  });
  assert.equal(heartbeat.status, 401);
});

test("flag espCredenciaisObrigatorias recusa MAC-only em qualquer sala", async () => {
  novaSalaComMac("cred-8", "AA:CC:00:00:00:08");
  configuracoesService.validarEAtualizar({ espCredenciaisObrigatorias: true }, { nivel: 3, id: "test" });
  try {
    const ws = abrirWs({ "x-device-sala": "cred-8", "x-device-mac": "AA:CC:00:00:00:08" });
    await esperaRecusada(ws);

    const hb = await fetch(`${baseUrl}/dispositivo/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-device-mac": "AA:CC:00:00:00:08" },
      body: JSON.stringify({ sala: "cred-8", mac: "AA:CC:00:00:00:08" }),
    });
    assert.equal(hb.status, 401);
  } finally {
    configuracoesService.validarEAtualizar({ espCredenciaisObrigatorias: false }, { nivel: 3, id: "test" });
  }
});

test("substituir gera novo deviceId e preserva o MAC cadastrado da sala", async () => {
  novaSalaComMac("cred-9", "AA:CC:00:00:00:09");
  const original = credenciaisService.provisionar("cred-9");
  const novo = credenciaisService.substituir("cred-9");
  assert.notEqual(original.deviceId, novo.deviceId);
  assert.equal(credenciaisService.verificar(original.deviceId, original.segredo), null);
  assert.ok(credenciaisService.verificar(novo.deviceId, novo.segredo));
  assert.equal(db.prepare(`SELECT mac FROM salas WHERE sala = 'cred-9'`).get().mac, "AA:CC:00:00:00:09");
});

test("heartbeat HTTP autentica por credencial e o segredo nunca aparece nos logs", async () => {
  novaSalaComMac("cred-10", "AA:CC:00:00:00:10");
  const { deviceId, segredo } = credenciaisService.provisionar("cred-10");

  const capturado = [];
  const originais = { info: logger.info, warn: logger.warn, error: logger.error };
  for (const nivel of Object.keys(originais)) {
    logger[nivel] = (cat, det) => capturado.push(JSON.stringify({ cat, det }));
  }
  try {
    const hb = await fetch(`${baseUrl}/dispositivo/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-device-id": deviceId, "x-device-secret": segredo },
      body: JSON.stringify({ sala: "cred-10", ligado: true }),
    });
    assert.equal(hb.status, 200);
    credenciaisService.rotacionar("cred-10");
  } finally {
    Object.assign(logger, originais);
  }
  assert.ok(capturado.length > 0);
  assert.ok(capturado.every((linha) => !linha.includes(segredo)), "nenhuma linha de log pode conter o segredo");
});

test("provisionar empurra a credencial para um dispositivo já conectado por MAC", async () => {
  novaSalaComMac("cred-11", "AA:CC:00:00:00:11");
  const ws = abrirWs({ "x-device-sala": "cred-11", "x-device-mac": "AA:CC:00:00:00:11" });
  const mensagens = [];
  ws.on("message", (d) => mensagens.push(JSON.parse(d.toString())));
  await esperaAceita(ws);
  await espera(50);

  const r = credenciaisService.provisionar("cred-11");
  assert.equal(r.enviadoAoDispositivo, true);
  await espera(50);
  const push = mensagens.find((m) => m.tipo === "credencial_provisionar");
  assert.ok(push);
  assert.equal(push.deviceId, r.deviceId);
  assert.equal(push.segredo, r.segredo);
  ws.close();
});

test("rotas de credencial exigem superadmin", async () => {
  const usuariosService = require("../src/services/usuariosService");
  usuariosService.criar(
    { usuario: "cred-admin-comum", senha: "senhaSegura123", nome: "Admin Comum", isAdmin: true },
    { nivel: 3 }
  );
  const token = await login("cred-admin-comum", "senhaSegura123");
  novaSalaComMac("cred-12", "AA:CC:00:00:00:12");
  const resp = await authFetch("/admin/esp32/cred-12/credencial", token, { method: "POST" });
  assert.equal(resp.status, 403);
});

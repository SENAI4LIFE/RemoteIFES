const fs = require("fs");
const os = require("os");
const path = require("path");

const RAIZ_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "remoteifes-ota-"));
process.env.REMOTEIFES_DB_PATH = ":memory:";
process.env.REMOTEIFES_FIRMWARE_DIR = path.join(RAIZ_TMP, "firmware");
process.env.NODE_ENV = "test";

const http = require("http");
const test = require("node:test");
const assert = require("node:assert/strict");
const WebSocket = require("ws");

const db = require("../src/config/database");
const app = require("../src/app");
const statusHub = require("../src/services/statusHub");
const deviceHub = require("../src/services/deviceHub");
const otaService = require("../src/services/otaService");
const notificacoesService = require("../src/services/notificacoesService");

let server;
let baseUrl;
let baseWsDispositivoUrl;
let binPath;
let manifesto;

const MAC_A = "AA:BB:CC:DD:0A:01";
const MAC_B = "AA:BB:CC:DD:0A:02";

function criarBinFake(versaoBytes = 128 * 1024) {
  const buf = Buffer.alloc(versaoBytes, 0);
  buf[0] = 0xe9;
  for (let i = 1; i < buf.length; i += 1) buf[i] = i % 251;
  const alvo = path.join(RAIZ_TMP, "firmware-fake.bin");
  fs.writeFileSync(alvo, buf);
  return alvo;
}

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

const socketsAbertos = new Set();

async function abrirDispositivo(sala, mac) {
  const ws = new WebSocket(baseWsDispositivoUrl, { headers: { "x-device-sala": sala, "x-device-mac": mac } });
  socketsAbertos.add(ws);
  ws.once("close", () => socketsAbertos.delete(ws));
  const mensagens = [];
  ws.on("message", (dados) => mensagens.push(JSON.parse(dados.toString())));
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return { ws, mensagens };
}

const espera = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test.before(async () => {
  binPath = criarBinFake();
  manifesto = otaService.publicarFirmware({ origem: binPath, versao: "4.0.0-test", notas: "teste" });

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
  fs.rmSync(RAIZ_TMP, { recursive: true, force: true });
});

test("publicarFirmware valida o byte mágico ESP e grava um manifesto verificável", () => {
  assert.equal(manifesto.versao, "4.0.0-test");
  assert.equal(manifesto.tamanho, fs.statSync(binPath).size);
  assert.match(manifesto.sha256, /^[0-9a-f]{64}$/);

  const semMagic = path.join(RAIZ_TMP, "ruim.bin");
  fs.writeFileSync(semMagic, Buffer.alloc(128 * 1024, 1));
  assert.throws(() => otaService.publicarFirmware({ origem: semMagic, versao: "9.9.9" }), /0xE9/);
  assert.throws(() => otaService.publicarFirmware({ origem: binPath, versao: "espaço inválido" }), /versão inválida/);
});

test("GET /admin/esp32/firmware expõe o manifesto ao superadmin", async () => {
  const token = await tokenSuperAdmin();
  const resp = await authFetch("/admin/esp32/firmware", token);
  assert.equal(resp.status, 200);
  const corpo = await resp.json();
  assert.equal(corpo.manifesto.versao, "4.0.0-test");
  assert.equal(corpo.manifesto.sha256, manifesto.sha256);
});

test("oferta de OTA chega ao dispositivo; oferta concorrente para a mesma sala é 409", async () => {
  novaSalaComMac("ota-sala-1", MAC_A);
  const token = await tokenSuperAdmin();
  const { ws, mensagens } = await abrirDispositivo("ota-sala-1", MAC_A);

  const resp = await authFetch("/admin/esp32/ota-sala-1/ota", token, { method: "POST" });
  assert.equal(resp.status, 200);
  await espera(80);

  const oferta = mensagens.find((m) => m.tipo === "ota_oferta");
  assert.ok(oferta, "o dispositivo deve receber ota_oferta");
  assert.equal(oferta.versao, "4.0.0-test");
  assert.equal(oferta.tamanho, manifesto.tamanho);
  assert.equal(oferta.sha256, manifesto.sha256);
  assert.equal(oferta.caminho, "/dispositivo/firmware");

  const concorrente = await authFetch("/admin/esp32/ota-sala-1/ota", token, { method: "POST" });
  assert.equal(concorrente.status, 409);

  ws.close();
});

test("progresso e resultado do dispositivo avançam o estado e concluem na reconexão com a nova versão", async () => {
  novaSalaComMac("ota-sala-2", MAC_B);
  const token = await tokenSuperAdmin();
  const { ws } = await abrirDispositivo("ota-sala-2", MAC_B);

  await authFetch("/admin/esp32/ota-sala-2/ota", token, { method: "POST" });
  await espera(50);

  ws.send(JSON.stringify({ tipo: "ota_progresso", recebido: 65536, total: manifesto.tamanho }));
  await espera(50);
  let estado = otaService.estadoDaSala("ota-sala-2");
  assert.equal(estado.fase, "baixando");
  assert.equal(estado.recebido, 65536);

  ws.send(JSON.stringify({ tipo: "ota_resultado", resultado: "ok" }));
  await espera(50);
  assert.equal(otaService.estadoDaSala("ota-sala-2").fase, "gravado");

  ws.send(JSON.stringify({ tipo: "info", fw: "4.0.0-test" }));
  await espera(50);
  estado = otaService.estadoDaSala("ota-sala-2");
  assert.equal(estado.fase, "concluido");

  const notifs = notificacoesService.listar();
  assert.ok(notifs.some((n) => n.sala === "ota-sala-2" && n.tipo === "esp32_ota_ok"));

  ws.close();
});

test("dispositivo que reverte para a versão anterior marca a OTA como falha (rollback)", async () => {
  novaSalaComMac("ota-sala-3", "AA:BB:CC:DD:0A:03");
  const token = await tokenSuperAdmin();
  const { ws } = await abrirDispositivo("ota-sala-3", "AA:BB:CC:DD:0A:03");

  await authFetch("/admin/esp32/ota-sala-3/ota", token, { method: "POST" });
  await espera(50);
  ws.send(JSON.stringify({ tipo: "ota_resultado", resultado: "ok" }));
  await espera(50);
  ws.send(JSON.stringify({ tipo: "info", fw: "3.0.0" }));
  await espera(50);

  const estado = otaService.estadoDaSala("ota-sala-3");
  assert.equal(estado.fase, "falhou");
  assert.match(estado.erro, /rollback|anterior/);

  const respReofertar = await authFetch("/admin/esp32/ota-sala-3/ota", token, { method: "POST" });
  assert.equal(respReofertar.status, 200, "re-oferta é permitida após uma falha");

  ws.close();
});

test("erro reportado pelo dispositivo marca falha e notifica", async () => {
  novaSalaComMac("ota-sala-4", "AA:BB:CC:DD:0A:04");
  const token = await tokenSuperAdmin();
  const { ws } = await abrirDispositivo("ota-sala-4", "AA:BB:CC:DD:0A:04");

  await authFetch("/admin/esp32/ota-sala-4/ota", token, { method: "POST" });
  await espera(50);
  ws.send(JSON.stringify({ tipo: "ota_resultado", resultado: "erro", erro: "sha256 divergente" }));
  await espera(50);

  const estado = otaService.estadoDaSala("ota-sala-4");
  assert.equal(estado.fase, "falhou");
  assert.match(estado.erro, /sha256/);
  assert.ok(notificacoesService.listar().some((n) => n.sala === "ota-sala-4" && n.tipo === "esp32_ota_falha"));

  ws.close();
});

test("download de firmware exige MAC correspondente e devolve os bytes exatos", async () => {
  novaSalaComMac("ota-sala-5", "AA:BB:CC:DD:0A:05");

  const semSala = await fetch(`${baseUrl}/dispositivo/firmware`);
  assert.equal(semSala.status, 400);

  const macErrado = await fetch(`${baseUrl}/dispositivo/firmware?sala=ota-sala-5`, {
    headers: { "x-device-mac": "00:00:00:00:00:00" },
  });
  assert.equal(macErrado.status, 403);

  const ok = await fetch(`${baseUrl}/dispositivo/firmware?sala=ota-sala-5`, {
    headers: { "x-device-mac": "AA:BB:CC:DD:0A:05" },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-length"), String(manifesto.tamanho));
  assert.equal(ok.headers.get("x-firmware-sha256"), manifesto.sha256);
  const corpo = Buffer.from(await ok.arrayBuffer());
  assert.equal(corpo.length, manifesto.tamanho);
  assert.equal(corpo[0], 0xe9);
});

test("oferta para dispositivo desconectado retorna 409", async () => {
  novaSalaComMac("ota-sala-6", "AA:BB:CC:DD:0A:06");
  const token = await tokenSuperAdmin();
  const resp = await authFetch("/admin/esp32/ota-sala-6/ota", token, { method: "POST" });
  assert.equal(resp.status, 409);
});

test("um admin comum não pode ofertar OTA", async () => {
  const usuariosService = require("../src/services/usuariosService");
  usuariosService.criar(
    { usuario: "ota-admin-comum", senha: "senhaSegura123", nome: "Admin Comum", isAdmin: true },
    { nivel: 3 }
  );
  const token = await login("ota-admin-comum", "senhaSegura123");
  novaSalaComMac("ota-sala-7", "AA:BB:CC:DD:0A:07");
  const resp = await authFetch("/admin/esp32/ota-sala-7/ota", token, { method: "POST" });
  assert.equal(resp.status, 403);
});

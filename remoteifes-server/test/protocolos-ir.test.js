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
const usuariosService = require("../src/services/usuariosService");
const credenciais = require("../src/services/esp32CredenciaisService");

let server;
let baseUrl;
let wsUrl;
let wsNavegadorUrl;
const abertos = new Set();
let credencialClonadora = null;

function sala(salaId, mac) {
  db.prepare(`INSERT OR IGNORE INTO salas (sala, nome, bloco, andar, mac) VALUES (?, ?, 'A', 1, ?)`).run(salaId, salaId, mac);
}

async function login(usuario, senha) {
  const resp = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usuario, senha }),
  });
  return (await resp.json()).token;
}

async function tokenSuperAdmin() {
  const bcrypt = require("bcryptjs");
  db.prepare(`UPDATE usuarios SET senhaHash = ? WHERE usuario = 'superadmin'`).run(bcrypt.hashSync("senhaProtocolos123", 10));
  return login("superadmin", "senhaProtocolos123");
}

function auth(path, token, opcoes = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...opcoes,
    headers: { ...(opcoes.headers || {}), "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  });
}

function esperar(ms = 40) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ate(condicao, limiteMs = 1500) {
  const inicio = Date.now();
  while (Date.now() - inicio < limiteMs) {
    if (condicao()) return true;
    await esperar(10);
  }
  return condicao();
}

function conectar(salaId, mac, { fw = "4.1.0", headers = {} } = {}) {
  const mensagens = [];
  const ws = new WebSocket(wsUrl, { headers: { "x-device-sala": salaId, "x-device-mac": mac, ...headers } });
  abertos.add(ws);
  ws.on("message", (dados) => mensagens.push(JSON.parse(dados.toString())));
  ws.once("close", () => abertos.delete(ws));
  return new Promise((resolve, reject) => {
    ws.once("open", () => {
      ws.send(JSON.stringify({ tipo: "info", fw, failsafeConfigurado: false, failsafePulsos: 0, failsafeCarrierHz: 0, failsafeProtocolRecordId: -1 }));
      setTimeout(() => resolve({ ws, mensagens }), 60);
    });
    ws.once("error", reject);
  });
}

function fecharEEsperar(ws) {
  return new Promise((resolve) => {
    ws.once("close", () => resolve());
    ws.close();
  });
}

const CAPTURA_LIGAR = { tipo: "captura", isKnown: true, protocolId: 5, protocol: "DAIKIN", hex: "0x1234", raw: [9000, 4500, 560, 560], carrierHz: 38000 };
const CAPTURA_OFF = { tipo: "captura", isKnown: false, protocolId: -1, protocol: "UNKNOWN", hex: "0x0", raw: [9100, 4450, 570, 550, 570, 1650], carrierHz: 38000 };

test.before(async () => {
  server = http.createServer(app);
  statusHub.iniciar(server);
  deviceHub.iniciar(server);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  wsUrl = `ws://127.0.0.1:${server.address().port}/ws/dispositivo`;
  wsNavegadorUrl = `ws://127.0.0.1:${server.address().port}/ws`;
  sala("CLONE-1", "AA:BB:CC:DD:EE:C1");
  sala("TX-1", "AA:BB:CC:DD:EE:D1");
  sala("TX-2", "AA:BB:CC:DD:EE:D2");
});

test.after(async () => {
  for (const ws of abertos) {
    try { ws.terminate(); } catch (erro) {}
  }
  deviceHub.encerrar();
  statusHub.encerrar();
  await new Promise((resolve) => server.close(resolve));
});

test("as rotas de Protocolos IR exigem superadministrador", async () => {
  usuariosService.criar({ usuario: "adm-protocolos", senha: "senhaSegura123", nome: "Admin", isAdmin: true }, { nivel: 3 });
  usuariosService.criar({ usuario: "user-protocolos", senha: "senhaSegura123", nome: "Comum", podeControlar: true }, { nivel: 3 });
  const admin = await login("adm-protocolos", "senhaSegura123");
  const comum = await login("user-protocolos", "senhaSegura123");
  for (const [caminho, metodo, corpo] of [
    ["/admin/protocolos-ir", "GET"],
    ["/admin/protocolos-ir/clonador", "PUT", { sala: "CLONE-1" }],
    ["/admin/protocolos-ir/clonador/modo-clone", "POST", { ativo: true }],
    ["/admin/protocolos-ir", "POST", { label: "x", capturaId: 1 }],
    ["/admin/protocolos-ir/1", "DELETE"],
  ]) {
    const respAdmin = await auth(caminho, admin, { method: metodo, body: corpo ? JSON.stringify(corpo) : undefined });
    assert.equal(respAdmin.status, 403, `${metodo} ${caminho} para admin comum`);
    const respComum = await auth(caminho, comum, { method: metodo, body: corpo ? JSON.stringify(corpo) : undefined });
    assert.equal(respComum.status, 403, `${metodo} ${caminho} para usuário comum`);
  }
  const anonimo = await fetch(`${baseUrl}/admin/protocolos-ir`);
  assert.equal(anonimo.status, 401);
});

test("fluxo completo: papel pelo servidor, capturas só da clonadora em modo clone, biblioteca, failsafe e aplicação", async () => {
  const token = await tokenSuperAdmin();

  let resp = await auth("/admin/protocolos-ir", token);
  let corpo = await resp.json();
  assert.equal(corpo.clonador.sala, null);
  assert.deepEqual(corpo.protocolos, []);

  const clonador = await conectar("CLONE-1", "AA:BB:CC:DD:EE:C1");
  const tx = await conectar("TX-1", "AA:BB:CC:DD:EE:D1");
  assert.ok(clonador.mensagens.some((m) => m.tipo === "device_role" && m.role === "transmitter"), "antes da definição toda placa é transmissora");
  assert.ok(clonador.mensagens.some((m) => m.tipo === "failsafe_raw_clear"), "sem protocolo vinculado o servidor manda limpar o failsafe ao conectar");
  assert.equal(deviceHub.estadoPublico("CLONE-1").role, "transmitter");

  clonador.ws.send(JSON.stringify({ tipo: "modo_alterado", modo: "config_clone" }));
  await esperar();
  clonador.ws.send(JSON.stringify(CAPTURA_LIGAR));
  await esperar();
  assert.equal(deviceHub.capturasRecentes("CLONE-1").length, 0, "captura de uma placa que não é a clonadora é descartada");

  resp = await auth("/admin/protocolos-ir/clonador", token, { method: "PUT", body: JSON.stringify({ sala: "NAO-EXISTE" }) });
  assert.equal(resp.status, 400);

  clonador.mensagens.length = 0;
  resp = await auth("/admin/protocolos-ir/clonador", token, { method: "PUT", body: JSON.stringify({ sala: "CLONE-1" }) });
  assert.equal(resp.status, 200);
  corpo = await resp.json();
  assert.equal(corpo.clonador.sala, "CLONE-1");
  assert.equal(corpo.clonador.mac, "AA:BB:CC:DD:EE:C1");
  assert.equal(corpo.clonador.vinculoValido, true);
  assert.equal(corpo.clonador.dispositivo.role, "cloner");
  assert.ok(await ate(() => clonador.mensagens.some((m) => m.tipo === "device_role" && m.role === "cloner")));
  assert.equal(deviceHub.estadoPublico("TX-1").role, "transmitter");

  resp = await auth("/admin/protocolos-ir/clonador/modo-clone", token, { method: "POST", body: JSON.stringify({ ativo: "sim" }) });
  assert.equal(resp.status, 400);

  clonador.ws.send(JSON.stringify({ tipo: "modo_alterado", modo: "operation" }));
  await esperar();
  clonador.ws.send(JSON.stringify(CAPTURA_LIGAR));
  await esperar();
  assert.equal(deviceHub.capturasRecentes("CLONE-1").length, 0, "fora do modo clone a captura é descartada mesmo vindo da clonadora");

  clonador.mensagens.length = 0;
  resp = await auth("/admin/protocolos-ir/clonador/modo-clone", token, { method: "POST", body: JSON.stringify({ ativo: true }) });
  assert.equal(resp.status, 200);
  assert.ok(await ate(() => clonador.mensagens.some((m) => m.tipo === "enter_clone")), "firmware 4.1.0 recebe enter_clone");
  assert.ok(!clonador.mensagens.some((m) => m.tipo === "enter_config"));
  clonador.ws.send(JSON.stringify({ tipo: "modo_alterado", modo: "config_clone" }));
  await esperar();
  assert.equal(deviceHub.estadoPublico("CLONE-1").modo, "config_clone");

  tx.ws.send(JSON.stringify({ tipo: "modo_alterado", modo: "config_clone" }));
  await esperar();
  tx.ws.send(JSON.stringify({ ...CAPTURA_LIGAR, hex: "0xBAD" }));
  await esperar();
  assert.equal(deviceHub.capturasRecentes("TX-1").length, 0, "um transmissor nunca alimenta a biblioteca");

  clonador.ws.send(JSON.stringify({ ...CAPTURA_LIGAR, raw: [] }));
  clonador.ws.send(JSON.stringify(CAPTURA_LIGAR));
  await esperar();
  const recentes = deviceHub.capturasRecentes("CLONE-1");
  assert.equal(recentes.length, 1, "captura sem RAW válido é descartada");
  const capturaLigar = recentes[0];
  assert.ok(Number.isInteger(capturaLigar.id));
  assert.equal(capturaLigar.sala, "CLONE-1");
  assert.equal(capturaLigar.protocolId, 5);
  assert.equal(capturaLigar.carrierHz, 38000);

  resp = await auth("/admin/protocolos-ir", token, { method: "POST", body: JSON.stringify({ label: "Ar lab", capturaId: 999 }) });
  assert.equal(resp.status, 404);
  resp = await auth("/admin/protocolos-ir", token, { method: "POST", body: JSON.stringify({ label: "A", capturaId: capturaLigar.id }) });
  assert.equal(resp.status, 400);
  resp = await auth("/admin/protocolos-ir", token, { method: "POST", body: JSON.stringify({ label: "Ar laboratório - ligar", capturaId: capturaLigar.id }) });
  assert.equal(resp.status, 201);
  const salvo = (await resp.json()).protocolo;
  assert.equal(salvo.label, "Ar laboratório - ligar");
  assert.deepEqual(salvo.raw, CAPTURA_LIGAR.raw);
  assert.equal(salvo.origemMac, "AA:BB:CC:DD:EE:C1");
  resp = await auth("/admin/protocolos-ir", token, { method: "POST", body: JSON.stringify({ label: "ar LABORATÓRIO - ligar", capturaId: capturaLigar.id }) });
  assert.equal(resp.status, 400);

  resp = await auth("/admin/protocolos-ir", token);
  corpo = await resp.json();
  assert.equal(corpo.protocolos.length, 1);
  assert.equal(corpo.capturas.length, 1);
  assert.equal(corpo.protocolos[0].failsafe, null);

  clonador.ws.send(JSON.stringify(CAPTURA_OFF));
  await esperar();
  const capturaOff = deviceHub.capturasRecentes("CLONE-1")[0];
  assert.deepEqual(capturaOff.raw, CAPTURA_OFF.raw);

  tx.mensagens.length = 0;
  resp = await auth(`/admin/protocolos-ir/${salvo.id}/aplicar/TX-1`, token, { method: "POST" });
  assert.equal(resp.status, 200);
  corpo = await resp.json();
  assert.equal(corpo.sala.irProtocolo, 5);
  assert.equal(corpo.sala.irProtocoloRegistroId, salvo.id);
  assert.equal(corpo.failsafeSincronizado, true);
  assert.ok(await ate(() => tx.mensagens.some((m) => m.tipo === "send_known_state" && m.protocol === 5)));
  const limpezaInicial = tx.mensagens.find((m) => m.tipo === "failsafe_raw_clear");
  assert.ok(limpezaInicial && limpezaInicial.protocolRecordId === salvo.id, "aplicar protocolo sem failsafe manda apagar um RAW antigo");

  tx.mensagens.length = 0;
  resp = await auth(`/admin/protocolos-ir/${salvo.id}/failsafe`, token, { method: "PUT", body: JSON.stringify({ capturaId: capturaOff.id }) });
  assert.equal(resp.status, 200);
  corpo = await resp.json();
  assert.deepEqual(corpo.protocolo.failsafe.raw, CAPTURA_OFF.raw);
  assert.equal(corpo.sincronizados, 1);
  assert.ok(await ate(() => tx.mensagens.some((m) => m.tipo === "failsafe_raw_set" && m.protocolRecordId === salvo.id)));
  const enviado = tx.mensagens.find((m) => m.tipo === "failsafe_raw_set");
  assert.deepEqual(enviado.raw, CAPTURA_OFF.raw);
  assert.equal(enviado.carrierHz, 38000);

  tx.ws.send(JSON.stringify({ tipo: "failsafe_status", failsafeConfigurado: true, failsafePulsos: 6, failsafeCarrierHz: 38000, failsafeProtocolRecordId: salvo.id }));
  await esperar();
  const failsafeReportado = deviceHub.estadoPublico("TX-1").failsafe;
  assert.equal(failsafeReportado.configurado, true);
  assert.equal(failsafeReportado.pulsos, 6);
  assert.equal(failsafeReportado.protocolRecordId, salvo.id);

  resp = await auth("/admin/esp32/dispositivos", token);
  const dispositivos = await resp.json();
  const linhaTx = dispositivos.find((d) => d.sala === "TX-1");
  assert.equal(linhaTx.irProtocoloRegistroId, salvo.id);
  assert.equal(linhaTx.dispositivo.failsafe.configurado, true);
  assert.equal(dispositivos.find((d) => d.sala === "CLONE-1").dispositivo.role, "cloner");

  tx.mensagens.length = 0;
  resp = await auth(`/admin/protocolos-ir/${salvo.id}/transmitir`, token, { method: "POST", body: JSON.stringify({ sala: "TX-1" }) });
  assert.equal(resp.status, 200);
  assert.ok(await ate(() => tx.mensagens.some((m) => m.tipo === "send_raw")));
  assert.deepEqual(tx.mensagens.find((m) => m.tipo === "send_raw").raw, CAPTURA_LIGAR.raw);
  resp = await auth(`/admin/protocolos-ir/${salvo.id}/transmitir`, token, { method: "POST", body: JSON.stringify({ sala: "TX-2" }) });
  assert.equal(resp.status, 409, "destino desconectado");

  resp = await auth("/admin/protocolos-ir", token, { method: "POST", body: JSON.stringify({ label: "Projetor", capturaId: capturaOff.id }) });
  assert.equal(resp.status, 201);
  const generico = (await resp.json()).protocolo;
  assert.equal(generico.isKnown, false);
  resp = await auth(`/admin/protocolos-ir/${generico.id}/aplicar/TX-2`, token, { method: "POST" });
  assert.equal(resp.status, 400, "RAW genérico não vira protocolo operacional");

  await fecharEEsperar(tx.ws);
  await ate(() => !deviceHub.dispositivoConectado("TX-1"));
  const txReconectado = await conectar("TX-1", "AA:BB:CC:DD:EE:D1");
  const reenviado = txReconectado.mensagens.find((m) => m.tipo === "failsafe_raw_set");
  assert.ok(reenviado, "ao reconectar o servidor sincroniza o failsafe persistido");
  assert.deepEqual(reenviado.raw, CAPTURA_OFF.raw);
  assert.equal(reenviado.protocolRecordId, salvo.id);
  const ordem = txReconectado.mensagens.map((m) => m.tipo);
  assert.ok(ordem.indexOf("device_role") < ordem.indexOf("failsafe_raw_set"));
  assert.ok(ordem.indexOf("failsafe_raw_set") < ordem.indexOf("send_known_state"));

  txReconectado.mensagens.length = 0;
  resp = await auth(`/admin/protocolos-ir/${salvo.id}/failsafe`, token, { method: "DELETE" });
  assert.equal(resp.status, 200);
  assert.ok(await ate(() => txReconectado.mensagens.some((m) => m.tipo === "failsafe_raw_clear" && m.protocolRecordId === salvo.id)));

  resp = await auth(`/admin/protocolos-ir/${salvo.id}/failsafe`, token, { method: "PUT", body: JSON.stringify({ capturaId: capturaOff.id }) });
  assert.equal(resp.status, 200);
  txReconectado.mensagens.length = 0;
  resp = await auth(`/admin/esp32/TX-1/protocolo-ir`, token, { method: "POST", body: JSON.stringify({ protocolo: 5 }) });
  assert.equal(resp.status, 200);
  assert.ok(await ate(() => txReconectado.mensagens.some((m) => m.tipo === "failsafe_raw_clear")), "trocar o protocolo da sala sem registro apaga o failsafe da placa");
  assert.equal(db.prepare("SELECT irProtocoloRegistroId FROM salas WHERE sala = 'TX-1'").get().irProtocoloRegistroId, null);

  resp = await auth(`/admin/protocolos-ir/${salvo.id}/aplicar/TX-1`, token, { method: "POST" });
  assert.equal(resp.status, 200);
  txReconectado.mensagens.length = 0;
  resp = await auth(`/admin/protocolos-ir/${salvo.id}`, token, { method: "PATCH", body: JSON.stringify({ label: "Ar lab 1" }) });
  assert.equal(resp.status, 200);
  assert.equal((await resp.json()).protocolo.label, "Ar lab 1");
  resp = await auth(`/admin/protocolos-ir/${salvo.id}`, token, { method: "DELETE" });
  assert.equal(resp.status, 200);
  assert.deepEqual((await resp.json()).salasAfetadas, ["TX-1"]);
  assert.ok(await ate(() => txReconectado.mensagens.some((m) => m.tipo === "failsafe_raw_clear")), "excluir o protocolo apaga o failsafe das salas que o usavam");
  assert.equal(db.prepare("SELECT irProtocolo, irProtocoloRegistroId FROM salas WHERE sala = 'TX-1'").get().irProtocolo, 5);
  resp = await auth(`/admin/protocolos-ir/${salvo.id}`, token, { method: "DELETE" });
  assert.equal(resp.status, 404);

  clonador.mensagens.length = 0;
  resp = await auth("/admin/protocolos-ir/clonador/modo-clone", token, { method: "POST", body: JSON.stringify({ ativo: false }) });
  assert.equal(resp.status, 200);
  assert.ok(await ate(() => clonador.mensagens.some((m) => m.tipo === "exit_operation")));

  const tipos = db.prepare("SELECT tipo FROM auditoria_eventos ORDER BY id").all().map((l) => l.tipo);
  for (const esperado of [
    "esp32_clonador_definido", "esp32_clonagem_ativada", "protocolo_ir_criado", "esp32_protocolo_alterado",
    "protocolo_ir_failsafe_definido", "protocolo_ir_transmitido", "protocolo_ir_failsafe_removido",
    "protocolo_ir_renomeado", "protocolo_ir_excluido", "esp32_clonagem_desativada",
  ]) assert.ok(tipos.includes(esperado), `auditoria sem ${esperado}`);

  await fecharEEsperar(txReconectado.ws);
  await fecharEEsperar(clonador.ws);
});

test("o painel do superadministrador recebe a captura em tempo real e um admin comum não", async () => {
  const token = await tokenSuperAdmin();
  const clonador = await conectar("CLONE-1", "AA:BB:CC:DD:EE:C1");
  clonador.ws.send(JSON.stringify({ tipo: "modo_alterado", modo: "config_clone" }));
  await esperar();

  const painel = new WebSocket(wsNavegadorUrl, [token]);
  const recebidas = [];
  painel.on("message", (dados) => recebidas.push(JSON.parse(dados.toString())));
  await new Promise((resolve, reject) => { painel.once("open", resolve); painel.once("error", reject); });
  painel.send(JSON.stringify({ tipo: "observar_dispositivos", salas: ["CLONE-1"] }));
  await esperar();

  clonador.ws.send(JSON.stringify({ ...CAPTURA_LIGAR, hex: "0xAB" }));
  assert.ok(await ate(() => recebidas.some((m) => m.tipo === "dispositivo_captura" && m.sala === "CLONE-1")));
  const evento = recebidas.find((m) => m.tipo === "dispositivo_captura");
  assert.equal(evento.captura.hex, "0xAB");
  assert.ok(Number.isInteger(evento.captura.id));
  painel.close();

  const admin = await login("adm-protocolos", "senhaSegura123");
  const painelAdmin = new WebSocket(wsNavegadorUrl, [admin]);
  const recebidasAdmin = [];
  painelAdmin.on("message", (dados) => recebidasAdmin.push(JSON.parse(dados.toString())));
  await new Promise((resolve, reject) => { painelAdmin.once("open", resolve); painelAdmin.once("error", reject); });
  painelAdmin.send(JSON.stringify({ tipo: "observar_dispositivos", salas: ["CLONE-1"] }));
  await esperar();
  clonador.ws.send(JSON.stringify({ ...CAPTURA_LIGAR, hex: "0xCD" }));
  await esperar(80);
  assert.ok(!recebidasAdmin.some((m) => m.tipo === "dispositivo_captura"));
  painelAdmin.close();
  await fecharEEsperar(clonador.ws);
});

test("o histórico de capturas é limitado e sobrevive à reconexão da clonadora", async () => {
  const token = await tokenSuperAdmin();
  const clonador = await conectar("CLONE-1", "AA:BB:CC:DD:EE:C1");
  clonador.ws.send(JSON.stringify({ tipo: "modo_alterado", modo: "config_clone" }));
  await esperar();
  for (let i = 0; i < 25; i += 1) clonador.ws.send(JSON.stringify({ ...CAPTURA_LIGAR, hex: `0x${i}` }));
  await ate(() => deviceHub.capturasRecentes("CLONE-1")[0]?.hex === "0x24");
  assert.equal(deviceHub.capturasRecentes("CLONE-1").length, 20);
  assert.equal(deviceHub.capturasRecentes("CLONE-1")[0].hex, "0x24");
  const maisAntiga = deviceHub.capturasRecentes("CLONE-1")[19];
  await fecharEEsperar(clonador.ws);
  await ate(() => !deviceHub.dispositivoConectado("CLONE-1"));
  assert.equal(deviceHub.capturasRecentes("CLONE-1").length, 20);
  const resp = await auth("/admin/protocolos-ir", token, { method: "POST", body: JSON.stringify({ label: "Após reconexão", capturaId: maisAntiga.id }) });
  assert.equal(resp.status, 201);
  assert.equal(deviceHub.capturaRecente("CLONE-1", "abc"), null);
});

test("firmware anterior a 4.1.0 recebe a sequência legada para entrar em modo clone", async () => {
  const token = await tokenSuperAdmin();
  const legado = await conectar("CLONE-1", "AA:BB:CC:DD:EE:C1", { fw: "4.0.0" });
  legado.mensagens.length = 0;
  const resp = await auth("/admin/protocolos-ir/clonador/modo-clone", token, { method: "POST", body: JSON.stringify({ ativo: true }) });
  assert.equal(resp.status, 200);
  assert.ok(await ate(() => legado.mensagens.some((m) => m.tipo === "start_capture")));
  assert.deepEqual(legado.mensagens.filter((m) => m.tipo !== "device_role").map((m) => m.tipo), ["enter_config", "set_mode", "start_capture"]);
  assert.ok(!legado.mensagens.some((m) => m.tipo === "enter_clone"));
  await fecharEEsperar(legado.ws);
});

test("a rota antiga de captura por sala continua exigindo a clonadora autorizada", async () => {
  const token = await tokenSuperAdmin();
  const tx = await conectar("TX-1", "AA:BB:CC:DD:EE:D1");
  let resp = await auth("/admin/esp32/TX-1/captura/iniciar", token, { method: "POST" });
  assert.equal(resp.status, 403);
  resp = await auth("/admin/esp32/TX-1/modo", token, { method: "POST", body: JSON.stringify({ modo: "clone" }) });
  assert.equal(resp.status, 403);
  resp = await auth("/admin/esp32/TX-1/modo", token, { method: "POST", body: JSON.stringify({ modo: "idle" }) });
  assert.equal(resp.status, 200);
  await fecharEEsperar(tx.ws);

  const clonador = await conectar("CLONE-1", "AA:BB:CC:DD:EE:C1");
  resp = await auth("/admin/esp32/CLONE-1/captura/iniciar", token, { method: "POST" });
  assert.equal(resp.status, 200);
  await fecharEEsperar(clonador.ws);
});

test("substituir a placa da sala clonadora derruba a autorização até nova confirmação", async () => {
  const token = await tokenSuperAdmin();
  const antiga = await conectar("CLONE-1", "AA:BB:CC:DD:EE:C1");
  const fechou = new Promise((resolve) => antiga.ws.once("close", resolve));
  salasService.cadastrarMac("CLONE-1", "AA:BB:CC:DD:EE:C9");
  await fechou;

  const nova = await conectar("CLONE-1", "AA:BB:CC:DD:EE:C9");
  assert.ok(nova.mensagens.some((m) => m.tipo === "device_role" && m.role === "transmitter"), "a placa nova não herda o papel de clonadora");
  assert.equal(deviceHub.estadoPublico("CLONE-1").role, "transmitter");
  nova.ws.send(JSON.stringify({ tipo: "modo_alterado", modo: "config_clone" }));
  await esperar();
  const antes = deviceHub.capturasRecentes("CLONE-1").length;
  nova.ws.send(JSON.stringify(CAPTURA_LIGAR));
  await esperar();
  assert.equal(deviceHub.capturasRecentes("CLONE-1").length, antes, "a placa substituída não consegue capturar");

  let resp = await auth("/admin/protocolos-ir/clonador/modo-clone", token, { method: "POST", body: JSON.stringify({ ativo: true }) });
  assert.equal(resp.status, 409);
  resp = await auth("/admin/protocolos-ir", token);
  let corpo = await resp.json();
  assert.equal(corpo.clonador.vinculoValido, false);
  assert.equal(corpo.clonador.motivo, "mac-alterado");

  nova.mensagens.length = 0;
  resp = await auth("/admin/protocolos-ir/clonador", token, { method: "PUT", body: JSON.stringify({ sala: "CLONE-1" }) });
  assert.equal(resp.status, 200);
  corpo = await resp.json();
  assert.equal(corpo.clonador.mac, "AA:BB:CC:DD:EE:C9");
  assert.equal(corpo.clonador.vinculoValido, true);
  assert.ok(await ate(() => nova.mensagens.some((m) => m.tipo === "device_role" && m.role === "cloner")));

  const { deviceId, segredo } = credenciais.provisionar("CLONE-1");
  await esperar(1200);
  await ate(() => !deviceHub.dispositivoConectado("CLONE-1"), 2000);
  const comCredencial = await conectar("CLONE-1", "AA:BB:CC:DD:EE:C9", { headers: { "x-device-id": deviceId, "x-device-secret": segredo } });
  assert.equal(deviceHub.estadoPublico("CLONE-1").role, "cloner", "provisionar credencial na mesma placa mantém o papel");
  resp = await auth("/admin/protocolos-ir/clonador", token, { method: "PUT", body: JSON.stringify({ sala: "CLONE-1" }) });
  corpo = await resp.json();
  assert.equal(corpo.clonador.deviceId, deviceId);

  const fechouCredencial = new Promise((resolve) => comCredencial.ws.once("close", resolve));
  const substituida = credenciais.substituir("CLONE-1");
  credencialClonadora = substituida;
  await fechouCredencial;
  const trocada = await conectar("CLONE-1", "AA:BB:CC:DD:EE:C9", { headers: { "x-device-id": substituida.deviceId, "x-device-secret": substituida.segredo } });
  assert.equal(deviceHub.estadoPublico("CLONE-1").role, "transmitter", "credencial substituída invalida o vínculo");
  resp = await auth("/admin/protocolos-ir", token);
  corpo = await resp.json();
  assert.equal(corpo.clonador.motivo, "credencial-alterada");
  assert.ok(db.prepare("SELECT 1 FROM auditoria_eventos WHERE tipo = 'esp32_clonador_definido' AND descricao LIKE '%AA:BB:CC:DD:EE:C9%'").get());
  await fecharEEsperar(trocada.ws);
});

test("trocar a clonadora devolve a antiga à operação e limpa o histórico de capturas dela", async () => {
  const token = await tokenSuperAdmin();
  let resp = await auth("/admin/protocolos-ir/clonador", token, { method: "PUT", body: JSON.stringify({ sala: "CLONE-1" }) });
  assert.equal(resp.status, 200);
  const antiga = await conectar("CLONE-1", "AA:BB:CC:DD:EE:C9", { headers: { "x-device-id": credencialClonadora.deviceId, "x-device-secret": credencialClonadora.segredo } });
  assert.equal(deviceHub.dispositivoConectado("CLONE-1"), true);
  assert.equal(deviceHub.estadoPublico("CLONE-1").role, "cloner");
  antiga.ws.send(JSON.stringify({ tipo: "modo_alterado", modo: "config_clone" }));
  await esperar();
  antiga.ws.send(JSON.stringify(CAPTURA_LIGAR));
  await ate(() => deviceHub.capturasRecentes("CLONE-1").length > 0);

  const nova = await conectar("TX-2", "AA:BB:CC:DD:EE:D2");
  antiga.mensagens.length = 0;
  nova.mensagens.length = 0;
  resp = await auth("/admin/protocolos-ir/clonador", token, { method: "PUT", body: JSON.stringify({ sala: "TX-2" }) });
  assert.equal(resp.status, 200);
  assert.ok(await ate(() => antiga.mensagens.some((m) => m.tipo === "exit_operation")));
  assert.ok(antiga.mensagens.some((m) => m.tipo === "device_role" && m.role === "transmitter"));
  assert.ok(await ate(() => nova.mensagens.some((m) => m.tipo === "device_role" && m.role === "cloner")));
  assert.deepEqual(deviceHub.capturasRecentes("CLONE-1"), []);
  assert.equal(deviceHub.estadoPublico("CLONE-1").role, "transmitter");
  assert.equal(deviceHub.estadoPublico("TX-2").role, "cloner");

  resp = await auth("/admin/protocolos-ir/clonador", token, { method: "PUT", body: JSON.stringify({ sala: null }) });
  assert.equal(resp.status, 200);
  assert.equal((await resp.json()).clonador.sala, null);
  assert.ok(await ate(() => nova.mensagens.some((m) => m.tipo === "device_role" && m.role === "transmitter")));
  assert.ok(db.prepare("SELECT 1 FROM auditoria_eventos WHERE tipo = 'esp32_clonador_removido'").get());
  await fecharEEsperar(antiga.ws);
  await fecharEEsperar(nova.ws);
});

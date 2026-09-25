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
const meshService = require("../src/services/meshService");
const credenciais = require("../src/services/esp32CredenciaisService");
const { NoDeReferencia } = require("./support/mesh-reference");

// Optional mesh transport, driven by a simulated gateway and a reference implementation of the
// board side (test/support/mesh-reference.js). No radio is involved: this proves the server's
// protocol, authorization and bounds, not range or reliability on real ESP32 hardware.

let server;
let porta;
let sequencia = 0;

function criarSala(sala, mac) {
  db.prepare("INSERT INTO salas (sala, nome, bloco, andar, ligado, temperaturaAlvo, turboAtivo, mac, irProtocolo) VALUES (?, ?, 'M', 1, 0, 24, 0, ?, 3)")
    .run(sala, `Sala ${sala}`, mac);
  return credenciais.provisionar(sala);
}

function ate(condicao, limiteMs = 4000) {
  return new Promise((resolve) => {
    const inicio = Date.now();
    const passo = () => {
      const v = condicao();
      if (v || Date.now() - inicio > limiteMs) return resolve(v);
      setTimeout(passo, 20);
    };
    passo();
  });
}

/**
 * A gateway board: its own credential, a direct WebSocket, and a relay loop that hands each frame
 * addressed to a node to that node's reference implementation.
 */
async function abrirGateway({ headers, rota = { pai: "gateway", saltos: 1, rssi: -58 } }) {
  const ws = new WebSocket(`ws://127.0.0.1:${porta}/ws/dispositivo`, { headers });
  const recebidas = [];
  const nosAtendidos = new Map();
  ws.on("message", (dados) => {
    const msg = JSON.parse(dados.toString());
    recebidas.push(msg);
    if (msg.tipo === "mesh_recusado") {
      const no = nosAtendidos.get(msg.no);
      if (no) no.recusado = msg.motivo;
      return;
    }
    if (msg.tipo !== "mesh") return;
    const no = nosAtendidos.get(msg.no);
    if (!no || no.mudo) return;
    for (const quadro of no.receber(msg.quadro)) ws.send(JSON.stringify({ tipo: "mesh", no: msg.no, quadro, rota: no.rota || rota }));
  });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.send(JSON.stringify({ tipo: "info", fw: "4.4.0", gateway: true }));
  return {
    ws,
    recebidas,
    anunciar(no, extra = {}) {
      nosAtendidos.set(no.deviceId, no);
      ws.send(JSON.stringify({ tipo: "mesh_evento", evento: "entrou", no: no.deviceId, rota: no.rota || rota, ...extra }));
    },
    enviar(no, payload) {
      ws.send(JSON.stringify({ tipo: "mesh", no: no.deviceId, quadro: no.selar(payload), rota: no.rota || rota }));
    },
    bruto(msg) {
      ws.send(JSON.stringify(msg));
    },
    fechar: () => new Promise((resolve) => {
      ws.once("close", resolve);
      ws.close();
    }),
  };
}

async function cenario() {
  sequencia += 1;
  const gw = criarSala(`GW-${sequencia}`, `AA:EE:00:00:${String(sequencia).padStart(2, "0")}:01`);
  const alvo = criarSala(`NO-${sequencia}`, `AA:EE:00:00:${String(sequencia).padStart(2, "0")}:02`);
  const gateway = await abrirGateway({ headers: { "x-device-id": gw.deviceId, "x-device-secret": gw.segredo } });
  const no = new NoDeReferencia({ deviceId: alvo.deviceId, segredo: alvo.segredo, gatewayDeviceId: gw.deviceId });
  return { gw, alvo, gateway, no, salaNo: `NO-${sequencia}`, salaGw: `GW-${sequencia}` };
}

test.before(async () => {
  server = http.createServer(app);
  statusHub.iniciar(server);
  deviceHub.iniciar(server);
  await new Promise((resolve) => server.listen(0, resolve));
  porta = server.address().port;
});

test.after(async () => {
  deviceHub.encerrar();
  statusHub.encerrar && statusHub.encerrar();
  await new Promise((resolve) => server.close(resolve));
});

test("a direct-only installation reports the mesh as unused, not failed", () => {
  const t = meshService.topologia();
  assert.equal(t.meshEmUso, false);
  assert.deepEqual(t.nos, []);
});

test("a board behind a gateway authenticates with its own credential and becomes its room's device", async (t) => {
  const c = await cenario();
  t.after(() => c.gateway.fechar());

  c.gateway.anunciar(c.no);
  assert.ok(await ate(() => deviceHub.canalDeComandos(c.salaNo)), "the node's room gets a command channel");
  const estado = deviceHub.estadoPublico(c.salaNo);
  assert.equal(estado.transporte, "mesh");
  assert.equal(estado.mesh.gateway, c.salaGw);
  assert.equal(estado.mesh.saltos, 1);
  assert.equal(deviceHub.estadoPublico(c.salaGw).transporte, "direto");

  // What the server sends at connection arrives decrypted at the node, never in clear at the gateway.
  assert.ok(await ate(() => c.no.recebidos.some((m) => m.tipo === "device_role")));
  const paraONo = c.gateway.recebidas.filter((m) => m.tipo === "mesh" && m.no === c.alvo.deviceId);
  assert.ok(paraONo.length > 0);
  for (const m of paraONo) {
    const chaves = Object.keys(m.quadro).sort().join(",");
    assert.ok(["ns,t", "prova,t", "dados,seq,t,tag"].includes(chaves), `frame for the node exposes only its envelope (${chaves})`);
  }
  assert.ok(!JSON.stringify(paraONo).includes("device_role"), "room traffic never reaches the gateway in clear");

  // Desired state: a command reaches the node sealed; the node's echo confirms it.
  const versao = db.prepare("SELECT estadoVersao FROM salas WHERE sala = ?").get(c.salaNo).estadoVersao;
  assert.equal(deviceHub.enviarComando(c.salaNo, { tipo: "send_known_state", versao, ligado: true }), true);
  assert.ok(await ate(() => c.no.recebidos.some((m) => m.tipo === "send_known_state" && m.versao === versao)));
  c.gateway.enviar(c.no, { tipo: "info", fw: "4.4.0", versao, failsafeConfigurado: false, failsafeLatched: false });
  assert.ok(await ate(() => deviceHub.estadoPublico(c.salaNo).estadoConfirmado === true), "the node's own report confirms the desired state");
  assert.equal(deviceHub.estadoPublico(c.salaNo).fwVersao, "4.4.0");

  const topo = meshService.topologia();
  assert.equal(topo.meshEmUso, true);
  const no = topo.nos.find((n) => n.deviceId === c.alvo.deviceId);
  assert.equal(no.estado, "conectado");
  assert.equal(no.sala, c.salaNo);
  assert.equal(no.canalComandos, true);
  assert.ok(no.entregas.confirmados >= 1, "downlink frames are acknowledged by the node");
  assert.equal(topo.gateways.find((g) => g.sala === c.salaGw).nos, 1);
});

test("the gateway cannot impersonate a board: a wrong key is refused and nothing connects", async (t) => {
  const c = await cenario();
  t.after(() => c.gateway.fechar());
  const impostor = new NoDeReferencia({ deviceId: c.alvo.deviceId, segredo: "segredo-inventado-pelo-gateway-000000", gatewayDeviceId: c.gw.deviceId });

  c.gateway.anunciar(impostor);
  assert.ok(await ate(() => impostor.recusado === "credencial"));
  assert.equal(deviceHub.canalDeComandos(c.salaNo), false);
  assert.equal(meshService.topologia().nos.find((n) => n.deviceId === c.alvo.deviceId).estado, "recusado");
});

test("credential rotation travels sealed through the gateway and the new secret works", async (t) => {
  const c = await cenario();
  t.after(() => c.gateway.fechar());
  c.gateway.anunciar(c.no);
  assert.ok(await ate(() => deviceHub.canalDeComandos(c.salaNo)));

  const rotacao = credenciais.rotacionar(c.salaNo);
  assert.equal(rotacao.enviadoAoDispositivo, true);
  assert.ok(await ate(() => c.no.novoSegredo === rotacao.segredo), "the node receives the new secret");
  assert.ok(!JSON.stringify(c.gateway.recebidas).includes(rotacao.segredo), "the gateway never sees the secret");

  // The board stores the secret and reconnects with it: the pending generation is activated.
  c.no.trocarSegredo(rotacao.segredo);
  c.gateway.anunciar(c.no);
  assert.ok(await ate(() => credenciais.estado(c.salaNo).pendente === false || !db.prepare("SELECT segredoHashPendente FROM esp_credenciais WHERE sala = ?").get(c.salaNo).segredoHashPendente));
  assert.ok(await ate(() => deviceHub.canalDeComandos(c.salaNo)));
});

test("tampered, replayed and out-of-session frames are rejected and processed at most once", async (t) => {
  const c = await cenario();
  t.after(() => c.gateway.fechar());
  c.gateway.anunciar(c.no);
  assert.ok(await ate(() => deviceHub.canalDeComandos(c.salaNo)));

  const quadro = c.no.selar({ tipo: "comando", cmd: "ligar", valor: 1 });
  c.gateway.bruto({ tipo: "mesh", no: c.no.deviceId, quadro });
  c.gateway.bruto({ tipo: "mesh", no: c.no.deviceId, quadro });
  const adulterado = c.no.selar({ tipo: "comando", cmd: "desligar", valor: 0 });
  adulterado.dados = adulterado.dados.slice(0, -2) + (adulterado.dados.endsWith("A") ? "BB" : "AA");
  c.gateway.bruto({ tipo: "mesh", no: c.no.deviceId, quadro: adulterado });

  const no = await ate(() => {
    const n = meshService.topologia().nos.find((x) => x.deviceId === c.alvo.deviceId);
    return n && n.duplicados >= 1 && n.rejeitados >= 1 ? n : null;
  });
  assert.ok(no, "the replay counts as a duplicate and the tampered frame as rejected");
  const registros = db.prepare("SELECT cmd FROM comandos_log WHERE sala = ? AND origem = 'esp32_local'").all(c.salaNo);
  assert.equal(registros.filter((r) => r.cmd === "ligar").length, 1, "the replayed frame is not processed twice");
  assert.equal(registros.filter((r) => r.cmd === "desligar").length, 0, "the tampered frame is not processed");
});

test("a board that is only announced is never online, and losing the gateway takes its boards offline", async (t) => {
  const c = await cenario();
  c.no.mudo = true;
  c.gateway.anunciar(c.no);
  await ate(() => meshService.topologia().nos.some((n) => n.deviceId === c.alvo.deviceId));
  assert.equal(deviceHub.canalDeComandos(c.salaNo), false, "gateway availability does not prove the board");

  c.no.mudo = false;
  c.gateway.anunciar(c.no);
  assert.ok(await ate(() => deviceHub.canalDeComandos(c.salaNo)));
  await c.gateway.fechar();
  assert.ok(await ate(() => !deviceHub.canalDeComandos(c.salaNo)), "the room is offline once its gateway is gone");
  assert.ok(await ate(() => meshService.topologia().nos.find((n) => n.deviceId === c.alvo.deviceId).estado === "inalcancavel"));
  t.after(() => {});
});

test("route changes are observed and downlink frames stay bounded without acknowledgement", async (t) => {
  const c = await cenario();
  t.after(() => c.gateway.fechar());
  c.gateway.anunciar(c.no);
  assert.ok(await ate(() => deviceHub.canalDeComandos(c.salaNo)));

  c.no.rota = { pai: "esp_00000000000000ff", saltos: 2, rssi: -71 };
  c.gateway.enviar(c.no, { tipo: "telemetria", temperatura: 25 });
  assert.ok(await ate(() => meshService.topologia().nos.find((n) => n.deviceId === c.alvo.deviceId).mudancasDeRota === 1));
  assert.equal(deviceHub.estadoPublico(c.salaNo).mesh.saltos, 2);

  c.no.semAck = true;
  for (let i = 0; i < 20; i += 1) deviceHub.enviarComando(c.salaNo, { tipo: "send_raw", indice: i });
  for (let i = 0; i < 3; i += 1) deviceHub.enviarComando(c.salaNo, { tipo: "send_known_state", versao: 100 + i });
  const no = meshService.topologia().nos.find((n) => n.deviceId === c.alvo.deviceId);
  assert.ok(no.entregas.pendentes <= meshService.topologia().limites.filaPorNo, `bounded queue (${no.entregas.pendentes})`);
  assert.ok(no.entregas.falhas > 0, "overflow is counted as failed delivery, not kept");
});

test("OTA is refused over the mesh with an explicit reason; direct OTA is unaffected", async (t) => {
  const c = await cenario();
  t.after(() => c.gateway.fechar());
  c.gateway.anunciar(c.no);
  assert.ok(await ate(() => deviceHub.canalDeComandos(c.salaNo)));
  const ota = require("../src/services/otaService");
  assert.throws(() => ota.ofertar(c.salaNo), (erro) => erro.conflito === true && erro.transporte === "mesh" && /malha/.test(erro.message));
  // The gateway itself is a direct board: its OTA is refused only for the usual reasons.
  assert.throws(() => ota.ofertar(c.salaGw), (erro) => !/malha/.test(erro.message));
});

test("a board authenticated only by MAC cannot relay for others", async (t) => {
  sequencia += 1;
  const sala = `LEG-${sequencia}`;
  const mac = `AA:EE:00:01:${String(sequencia).padStart(2, "0")}:01`;
  db.prepare("INSERT INTO salas (sala, nome, bloco, andar, ligado, temperaturaAlvo, turboAtivo, mac) VALUES (?, ?, 'M', 1, 0, 24, 0, ?)").run(sala, sala, mac);
  const alvo = criarSala(`NOL-${sequencia}`, `AA:EE:00:01:${String(sequencia).padStart(2, "0")}:02`);
  const gateway = await abrirGateway({ headers: { "x-device-sala": sala, "x-device-mac": mac } });
  t.after(() => gateway.fechar());
  const no = new NoDeReferencia({ deviceId: alvo.deviceId, segredo: alvo.segredo, gatewayDeviceId: "legado" });
  gateway.anunciar(no);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!gateway.recebidas.some((m) => m.tipo === "mesh"), "no challenge is sent through a MAC-only board");
  assert.equal(deviceHub.canalDeComandos(`NOL-${sequencia}`), false);
});

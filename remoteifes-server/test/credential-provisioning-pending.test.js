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
const credenciais = require("../src/services/esp32CredenciaisService");
const configuracoesService = require("../src/services/configuracoesService");
const { NoDeReferencia } = require("./support/mesh-reference");

let server;
let baseUrl;
let wsUrl;
const abertos = new Set();
const VINTE_E_QUATRO_HORAS_MS = 24 * 60 * 60 * 1000;

function sala(codigo, mac) {
  db.prepare("INSERT OR IGNORE INTO salas (sala, nome, bloco, andar, mac) VALUES (?, ?, 'A', 1, ?)").run(codigo, codigo, mac);
}

function esperar(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function ate(condicao, limiteMs = 3000) {
  const inicio = Date.now();
  while (!condicao() && Date.now() - inicio < limiteMs) await esperar(10);
  return condicao();
}

function linha(codigo) {
  return db.prepare("SELECT * FROM esp_credenciais WHERE sala = ?").get(codigo);
}

function instante(texto) {
  return new Date(texto.replace(" ", "T") + "Z").getTime();
}

function sqlEm(ms) {
  return new Date(Date.now() + ms).toISOString().slice(0, 19).replace("T", " ");
}

async function abrir(headers) {
  const ws = new WebSocket(wsUrl, { headers });
  abertos.add(ws);
  const mensagens = [];
  let fechamento = null;
  ws.on("message", (d) => mensagens.push(JSON.parse(d.toString())));
  ws.on("close", (codigo, motivo) => { fechamento = { codigo, motivo: motivo.toString() }; abertos.delete(ws); });
  ws.on("error", () => {});
  const abriu = await new Promise((resolve) => {
    ws.once("open", () => resolve(true));
    ws.once("close", () => resolve(false));
    ws.once("error", () => resolve(false));
  });
  if (abriu) await esperar(200);
  return {
    ws,
    aberto: abriu && fechamento === null,
    fechamento: () => fechamento,
    provisionamentos: () => mensagens.filter((m) => m.tipo === "credencial_provisionar"),
  };
}

const porMac = (codigo, mac) => abrir({ "x-device-sala": codigo, "x-device-mac": mac });
const porCredencial = (c) => abrir({ "x-device-id": c.deviceId, "x-device-secret": c.segredo });

function heartbeatPorMac(codigo, mac) {
  return fetch(`${baseUrl}/dispositivo/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-device-mac": mac },
    body: JSON.stringify({ sala: codigo, mac, ligado: false }),
  });
}

function heartbeatPorCredencial(c, codigo) {
  return fetch(`${baseUrl}/dispositivo/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-device-id": c.deviceId, "x-device-secret": c.segredo },
    body: JSON.stringify({ sala: codigo, ligado: false }),
  });
}

async function provisionarPorMac(codigo, mac) {
  const sessao = await porMac(codigo, mac);
  assert.equal(sessao.aberto, true, "the MAC-only board is connected");
  const cred = credenciais.provisionar(codigo);
  assert.equal(cred.enviadoAoDispositivo, true);
  assert.ok(await ate(() => sessao.provisionamentos().length === 1));
  assert.deepEqual(sessao.provisionamentos()[0], { tipo: "credencial_provisionar", deviceId: cred.deviceId, segredo: cred.segredo });
  assert.ok(await ate(() => sessao.fechamento() !== null), "the MAC session that received the credential is closed so the board reconnects with it");
  return cred;
}

test.before(async () => {
  server = http.createServer(app);
  statusHub.iniciar(server);
  deviceHub.iniciar(server);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  wsUrl = `ws://127.0.0.1:${server.address().port}/ws/dispositivo`;
});

test.after(async () => {
  for (const ws of abertos) {
    try {
      ws.terminate();
    } catch {}
  }
  deviceHub.encerrar();
  statusHub.encerrar();
  await new Promise((resolve) => server.close(resolve));
});

test("a credential provisioned over a MAC-only connection keeps that MAC accepted, and redelivers the credential, until the board presents it", async () => {
  const mac = "AA:CC:22:00:00:01";
  sala("PROV-1", mac);
  const antes = Date.now();
  const cred = await provisionarPorMac("PROV-1", mac);

  const estado = credenciais.estado("PROV-1");
  assert.equal(estado.provisionamentoPendente, true);
  assert.equal(estado.provisionamentoReentregavel, true);
  const prazo = instante(linha("PROV-1").provisionamentoPendenteAte);
  assert.ok(prazo >= antes + VINTE_E_QUATRO_HORAS_MS - 2000 && prazo <= Date.now() + VINTE_E_QUATRO_HORAS_MS + 2000, "the MAC is accepted for at most 24 hours");

  const volta = await porMac("PROV-1", mac);
  assert.equal(volta.aberto, true, "a board that lost power before storing the credential comes back by MAC");
  assert.ok(await ate(() => volta.provisionamentos().length === 1));
  assert.deepEqual(volta.provisionamentos()[0], { tipo: "credencial_provisionar", deviceId: cred.deviceId, segredo: cred.segredo });
  assert.equal(instante(linha("PROV-1").provisionamentoPendenteAte), prazo, "redelivery does not extend the deadline");
  assert.equal((await heartbeatPorMac("PROV-1", mac)).status, 200);

  const outroMac = await porMac("PROV-1", "AA:CC:22:00:00:99");
  assert.equal(outroMac.aberto, false, "only the room's registered MAC is accepted");
  assert.equal((await heartbeatPorMac("PROV-1", "AA:CC:22:00:00:99")).status, 403);

  const autenticada = await porCredencial(cred);
  assert.equal(autenticada.aberto, true);
  assert.equal(credenciais.estado("PROV-1").provisionamentoPendente, false);
  assert.equal(linha("PROV-1").provisionamentoPendenteAte, null);

  const depois = await porMac("PROV-1", mac);
  assert.equal(depois.aberto, false, "once the board presented the credential the MAC alone is refused");
  assert.equal((await heartbeatPorMac("PROV-1", mac)).status, 401);
  assert.equal(autenticada.fechamento(), null, "the confirmed session stays");
  autenticada.ws.close();
});

test("confirming by HTTP heartbeat closes the MAC-only session at once", async () => {
  const mac = "AA:CC:22:00:00:02";
  sala("PROV-2", mac);
  const cred = await provisionarPorMac("PROV-2", mac);
  const sessao = await porMac("PROV-2", mac);
  assert.equal(sessao.aberto, true);
  assert.equal((await heartbeatPorCredencial(cred, "PROV-2")).status, 200);
  assert.ok(await ate(() => sessao.fechamento() !== null));
  assert.equal(sessao.fechamento().codigo, 4001);
  assert.match(sessao.fechamento().motivo, /confirmou a credencial/);
  assert.equal(credenciais.estado("PROV-2").provisionamentoPendente, false);
  assert.equal((await heartbeatPorMac("PROV-2", mac)).status, 401);
});

async function abrirGateway(cred) {
  const ws = new WebSocket(wsUrl, { headers: { "x-device-id": cred.deviceId, "x-device-secret": cred.segredo } });
  abertos.add(ws);
  ws.once("close", () => abertos.delete(ws));
  const nos = new Map();
  const rota = { pai: "gateway", saltos: 1, rssi: -58 };
  ws.on("message", (dados) => {
    const msg = JSON.parse(dados.toString());
    if (msg.tipo !== "mesh") return;
    const no = nos.get(msg.no);
    if (!no) return;
    for (const quadro of no.receber(msg.quadro)) ws.send(JSON.stringify({ tipo: "mesh", no: msg.no, quadro, rota }));
  });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.send(JSON.stringify({ tipo: "info", fw: "4.4.0", gateway: true }));
  return {
    ws,
    anunciar(no) {
      nos.set(no.deviceId, no);
      ws.send(JSON.stringify({ tipo: "mesh_evento", evento: "entrou", no: no.deviceId, rota }));
    },
  };
}

test("a mesh session proven with the provisioned credential confirms it and closes the MAC-only session", async () => {
  sala("PROV-GW", "AA:CC:22:00:00:30");
  const gateway = await abrirGateway(credenciais.provisionar("PROV-GW"));
  const mac = "AA:CC:22:00:00:03";
  sala("PROV-3", mac);
  const cred = await provisionarPorMac("PROV-3", mac);
  const sessao = await porMac("PROV-3", mac);
  assert.equal(sessao.aberto, true);

  const errado = new NoDeReferencia({ deviceId: cred.deviceId, segredo: "outro-outro-outro-outro-outro-outro-12", gatewayDeviceId: linha("PROV-GW").deviceId });
  gateway.anunciar(errado);
  await esperar(300);
  assert.equal(credenciais.estado("PROV-3").provisionamentoPendente, true, "a node that cannot prove the credential confirms nothing");

  const no = new NoDeReferencia({ deviceId: cred.deviceId, segredo: cred.segredo, gatewayDeviceId: linha("PROV-GW").deviceId });
  gateway.anunciar(no);
  assert.ok(await ate(() => credenciais.estado("PROV-3").provisionamentoPendente === false, 4000));
  assert.ok(await ate(() => sessao.fechamento() !== null));
  assert.equal(sessao.fechamento().codigo, 4001);
  assert.match(sessao.fechamento().motivo, /confirmou a credencial/);
  assert.ok(await ate(() => deviceHub.estadoPublico("PROV-3").transporte === "mesh"));
  assert.equal(credenciais.exigidoPara({ sala: "PROV-3" }), true);
  gateway.ws.close();
});

test("the MAC stops being accepted when the pending provisioning expires, and a session left open by MAC ends then", async () => {
  const mac = "AA:CC:22:00:00:04";
  sala("PROV-4", mac);
  const cred = await provisionarPorMac("PROV-4", mac);
  db.prepare("UPDATE esp_credenciais SET provisionamentoPendenteAte = ? WHERE sala = 'PROV-4'").run(sqlEm(1500));
  assert.equal(credenciais.estado("PROV-4").provisionamentoPendente, true);

  db.prepare("UPDATE esp_credenciais SET deviceId = ? WHERE sala = 'PROV-4'").run("esp_00000000000000ff");
  const sessao = await porMac("PROV-4", mac);
  assert.equal(sessao.aberto, true);
  assert.equal(sessao.provisionamentos().length, 0, "a credential that is not the one kept in memory is never redelivered");
  db.prepare("UPDATE esp_credenciais SET deviceId = ? WHERE sala = 'PROV-4'").run(cred.deviceId);
  assert.equal(deviceHub.encerrarCredenciaisExpiradas(), 0);
  await esperar(1700);
  assert.equal(deviceHub.encerrarCredenciaisExpiradas(), 1);
  assert.ok(await ate(() => sessao.fechamento() !== null));
  assert.equal(sessao.fechamento().codigo, 4001);

  assert.equal(credenciais.estado("PROV-4").provisionamentoPendente, false);
  assert.equal((await porMac("PROV-4", mac)).aberto, false);
  assert.equal((await heartbeatPorMac("PROV-4", mac)).status, 401);
  const autenticada = await porCredencial(cred);
  assert.equal(autenticada.aberto, true, "the provisioned credential itself stays valid");
  autenticada.ws.close();
});

test("a pending provisioning does not open the MAC when every board must use a credential", async () => {
  const mac = "AA:CC:22:00:00:05";
  sala("PROV-5", mac);
  await provisionarPorMac("PROV-5", mac);
  configuracoesService.validarEAtualizar({ espCredenciaisObrigatorias: true }, { nivel: 3, id: "test" });
  try {
    const estado = credenciais.estado("PROV-5");
    assert.equal(estado.provisionamentoPendente, true, "still awaiting the board");
    assert.equal(estado.macAceitoAte, null, "but the MAC is not reported as accepted");
    assert.equal(estado.provisionamentoReentregavel, false);
    assert.equal((await porMac("PROV-5", mac)).aberto, false);
    assert.equal((await heartbeatPorMac("PROV-5", mac)).status, 401);
  } finally {
    configuracoesService.validarEAtualizar({ espCredenciaisObrigatorias: false }, { nivel: 3, id: "test" });
  }
});

test("provisioning without a MAC-only session, or after a revocation, never opens the MAC", async () => {
  const mac = "AA:CC:22:00:00:06";
  sala("PROV-6", mac);
  credenciais.provisionar("PROV-6");
  assert.equal(credenciais.estado("PROV-6").provisionamentoPendente, false);
  assert.equal((await porMac("PROV-6", mac)).aberto, false);

  credenciais.revogar("PROV-6");
  credenciais.provisionar("PROV-6");
  assert.equal(credenciais.estado("PROV-6").provisionamentoPendente, false);
  assert.equal(credenciais.exigidoPara({ sala: "PROV-6" }), true);
  assert.equal((await porMac("PROV-6", mac)).aberto, false);
});

test("rotation is refused while the provisioning awaits the board", async () => {
  const mac = "AA:CC:22:00:00:07";
  sala("PROV-7", mac);
  const cred = await provisionarPorMac("PROV-7", mac);
  assert.throws(() => credenciais.rotacionar("PROV-7"), (erro) => erro.conflito === true);
  assert.equal(linha("PROV-7").segredoHashPendente, null);
  assert.equal((await heartbeatPorCredencial(cred, "PROV-7")).status, 200);
  assert.ok(credenciais.rotacionar("PROV-7").pendente);
});

test("replace and revoke end a pending provisioning and the MAC with it", async () => {
  sala("PROV-8", "AA:CC:22:00:00:08");
  await provisionarPorMac("PROV-8", "AA:CC:22:00:00:08");
  credenciais.substituir("PROV-8");
  assert.equal(credenciais.estado("PROV-8").provisionamentoPendente, false);
  assert.equal((await porMac("PROV-8", "AA:CC:22:00:00:08")).aberto, false);

  sala("PROV-9", "AA:CC:22:00:00:09");
  await provisionarPorMac("PROV-9", "AA:CC:22:00:00:09");
  credenciais.revogar("PROV-9");
  assert.equal(credenciais.estado("PROV-9").provisionamentoPendente, false);
  assert.equal((await porMac("PROV-9", "AA:CC:22:00:00:09")).aberto, false);
  assert.equal((await heartbeatPorMac("PROV-9", "AA:CC:22:00:00:09")).status, 401);
});

test("provisioning again is refused while the pending credential can still be redelivered", async () => {
  const mac = "AA:CC:22:00:00:10";
  sala("PROV-10", mac);
  await provisionarPorMac("PROV-10", mac);
  assert.throws(() => credenciais.provisionar("PROV-10"), /já tem uma credencial ativa/);
});

test("after a server restart the pending provisioning cannot be redelivered; provisioning again needs the board connected by MAC and keeps the deadline", () => {
  const prazo = sqlEm(10 * 60 * 60 * 1000);
  const { spawnSync } = require("child_process");
  const filho = spawnSync(process.execPath, ["-e", `
    process.env.NODE_ENV = 'test';
    process.env.REMOTEIFES_DB_PATH = ':memory:';
    const db = require(${JSON.stringify(require.resolve("../src/config/database"))});
    require(${JSON.stringify(require.resolve("../src/db/schema"))}).criarSchema();
    db.prepare("INSERT INTO salas (sala, nome, bloco, andar, mac) VALUES ('PROV-11', 'PROV-11', 'A', 1, 'AA:CC:22:00:00:11')").run();
    const hub = require(${JSON.stringify(require.resolve("../src/services/deviceHub"))});
    let sessao = null;
    let aberta = false;
    const entregas = [];
    hub.conexaoDaSala = () => sessao;
    hub.dispositivoConectado = () => !!sessao && aberta;
    hub.enviarAtualizacaoCredencial = (sala, payload) => { if (!sessao) return false; entregas.push(payload); return true; };
    const cred = require(${JSON.stringify(require.resolve("../src/services/esp32CredenciaisService"))});
    const crypto = require('crypto');
    const antigo = 'perdido-perdido-perdido-perdido-perdido';
    db.prepare("INSERT INTO esp_credenciais (sala, deviceId, segredoHash, criadoEm, provisionamentoPendenteAte) VALUES ('PROV-11', 'esp_00000000000000aa', ?, datetime('now'), ?)").run(crypto.createHash('sha256').update(antigo).digest('hex'), ${JSON.stringify(prazo)});
    const estado = cred.estado('PROV-11');
    const macAceito = !cred.exigidoPara({ sala: 'PROV-11' });
    const entregue = cred.entregarProvisionamentoPendente('PROV-11');
    let semSessao = null;
    try { cred.provisionar('PROV-11'); semSessao = 'aceito'; } catch (e) { semSessao = 'recusado'; }
    const antigoAindaValidoSemSessao = !!db.prepare("SELECT 1 FROM esp_credenciais WHERE deviceId = 'esp_00000000000000aa'").get();
    sessao = { viaCredencial: false };
    let sessaoFechando = null;
    try { cred.provisionar('PROV-11'); sessaoFechando = 'aceito'; } catch (e) { sessaoFechando = 'recusado'; }
    aberta = true;
    const novo = cred.provisionar('PROV-11');
    const linha = db.prepare("SELECT * FROM esp_credenciais WHERE sala = 'PROV-11'").get();
    let terceira = null;
    try { cred.provisionar('PROV-11'); terceira = 'aceito'; } catch (e) { terceira = 'recusado'; }
    process.stdout.write(JSON.stringify({
      pendente: estado.provisionamentoPendente,
      reentregavel: estado.provisionamentoReentregavel,
      macAceito,
      entregue,
      semSessao,
      antigoAindaValidoSemSessao,
      sessaoFechando,
      entregueAoReprovisionar: entregas.length === 1 && entregas[0].tipo === 'credencial_provisionar' && entregas[0].deviceId === novo.deviceId && entregas[0].segredo === novo.segredo,
      prazoMantido: linha.provisionamentoPendenteAte === ${JSON.stringify(prazo)},
      novoValido: !!cred.verificar(novo.deviceId, novo.segredo),
      antigoValido: !!cred.verificar('esp_00000000000000aa', antigo),
      terceira,
    }));
  `], { encoding: "utf8" });
  assert.equal(filho.status, 0, filho.stderr);
  const resultado = JSON.parse(filho.stdout.trim().split("\n").pop());
  assert.deepEqual(resultado, {
    pendente: true,
    reentregavel: false,
    macAceito: true,
    entregue: false,
    semSessao: "recusado",
    antigoAindaValidoSemSessao: true,
    sessaoFechando: "recusado",
    entregueAoReprovisionar: true,
    prazoMantido: true,
    novoValido: true,
    antigoValido: false,
    terceira: "recusado",
  });
});

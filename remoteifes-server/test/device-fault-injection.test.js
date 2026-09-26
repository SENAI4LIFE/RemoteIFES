const fs = require("fs");
const os = require("os");
const path = require("path");
process.env.NODE_ENV = "test";
const RAIZ_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "remoteifes-falhas-"));
process.env.REMOTEIFES_DB_PATH = ":memory:";
process.env.REMOTEIFES_FIRMWARE_DIR = path.join(RAIZ_TMP, "firmware");

const http = require("http");
const test = require("node:test");
const assert = require("node:assert/strict");

const db = require("../src/config/database");
const app = require("../src/app");
const deviceHub = require("../src/services/deviceHub");
const salasService = require("../src/services/salasService");
const credenciais = require("../src/services/esp32CredenciaisService");
const otaService = require("../src/services/otaService");
const meshService = require("../src/services/meshService");
const { Bancada } = require("./support/bancada-dispositivos");

// Protocol-level fault injection against the real server stack (Express app, device hub, SQLite in
// memory), driven by the simulated boards in support/bancada-dispositivos.js. What passes here is
// the server's handling of a board's messages, timing and failures; nothing here exercises ESP32
// hardware, Wi-Fi or radio.

const CONTEXTO = { usuario: { id: 1, usuario: "superadmin", isAdmin: true, podeControlar: true, nivel: 3 }, origem: "manual" };
let server;
let porta;
let sequencia = 0;

function hex2(n) {
  return n.toString(16).padStart(2, "0").toUpperCase();
}

function novaSala({ credencial = true, protocolo = 16 } = {}) {
  sequencia += 1;
  const sala = `FI-${sequencia}`;
  const mac = `AA:F1:00:00:${hex2(sequencia)}:01`;
  db.prepare("INSERT INTO salas (sala, nome, bloco, andar, ligado, temperaturaAlvo, turboAtivo, mac, irProtocolo) VALUES (?, ?, 'F', 1, 0, 24, 0, ?, ?)")
    .run(sala, sala, mac, protocolo);
  const cred = credencial ? credenciais.provisionar(sala) : null;
  return { sala, mac, credencial: cred && { deviceId: cred.deviceId, segredo: cred.segredo } };
}

function versaoDe(sala) {
  return db.prepare("SELECT estadoVersao FROM salas WHERE sala = ?").get(sala).estadoVersao;
}

/**
 * Resolves when `condicao()` is true. Re-evaluated on every device-hub and room event, with a short
 * poll as a safety net for state that changes without an event.
 */
function ate(condicao, { limiteMs = 4000, descricao = "condição" } = {}) {
  return new Promise((resolve, reject) => {
    let timer;
    let poll;
    const verificar = () => {
      let valor;
      try {
        valor = condicao();
      } catch {
        valor = false;
      }
      if (!valor) return;
      fim();
      resolve(valor);
    };
    const fim = () => {
      clearTimeout(timer);
      clearInterval(poll);
      for (const e of ["conexao", "telemetria"]) deviceHub.eventos.off(e, verificar);
      salasService.eventos.off("mudanca-sala", verificar);
    };
    for (const e of ["conexao", "telemetria"]) deviceHub.eventos.on(e, verificar);
    salasService.eventos.on("mudanca-sala", verificar);
    poll = setInterval(verificar, 20);
    timer = setTimeout(() => {
      fim();
      reject(new Error(`tempo esgotado aguardando ${descricao}`));
    }, limiteMs);
    verificar();
  });
}

const conectada = (sala) => ate(() => deviceHub.estadoPublico(sala).conectado, { descricao: `${sala} conectada` });
const desconectada = (sala) => ate(() => !deviceHub.estadoPublico(sala).conectado, { descricao: `${sala} desconectada` });
const confirmada = (sala) => ate(() => deviceHub.estadoPublico(sala).estadoConfirmado === true, { descricao: `${sala} confirmada` });

async function subirServidor(portaFixa = 0) {
  server = http.createServer(app);
  deviceHub.iniciar(server);
  await new Promise((resolve) => server.listen(portaFixa, "127.0.0.1", resolve));
  porta = server.address().port;
}

async function derrubarServidor() {
  deviceHub.encerrar();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

/** A bench that is torn down after the test, and proves it left nothing behind. */
function bancada(t) {
  const b = new Bancada({ porta });
  t.after(async () => {
    const restos = await b.encerrar();
    assert.deepEqual(restos, { dispositivos: restos.dispositivos, sockets: 0, timers: 0, esperas: 0 }, "the bench left something open");
  });
  return b;
}

test.before(() => subirServidor());

test.after(async () => {
  await derrubarServidor();
  meshService.encerrar();
  fs.rmSync(RAIZ_TMP, { recursive: true, force: true });
});

// --- Harness ---------------------------------------------------------------------------------

test("the bench waits on events and leaves no socket, timer or waiter behind", async (t) => {
  const b = new Bancada({ porta });
  const s = novaSala();
  const placa = b.placa({ credencial: s.credencial, mac: s.mac, telemetriaMs: 50, reconectar: { atrasoMs: 30 } });
  await placa.conectar();
  // Messages already received count; later ones are awaited.
  assert.equal((await placa.aguardar("device_role")).tipo, "device_role");
  const marca = placa.totalRecebidas;
  salasService.aplicarComando(s.sala, "ligar", undefined, CONTEXTO);
  const comando = await placa.aguardar((m) => m.tipo === "send_known_state" && m.restauracao !== true, { desde: marca });
  assert.equal(comando.power, true);
  // A wait that never matches fails with a readable reason instead of hanging.
  await assert.rejects(placa.aguardar("nunca-enviado", { limiteMs: 50 }), /tempo esgotado aguardando mensagem nunca-enviado/);

  // Teardown while a reconnection is pending: the board must not come back.
  const pendente = assert.rejects(placa.aguardar("nunca-enviado", { limiteMs: 10_000 }), /placa encerrada/);
  placa.derrubar();
  await desconectada(s.sala);
  const restos = await b.encerrar();
  await pendente;
  assert.deepEqual({ ...restos, dispositivos: 0 }, { dispositivos: 0, sockets: 0, timers: 0, esperas: 0 });
  // Longer than the reconnection delay: this checks for an absence.
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(deviceHub.estadoPublico(s.sala).conectado, false, "an ended bench does not reconnect");
  assert.equal(await b.encerrar().then((r) => r.sockets), 0, "encerrar is idempotent");
});

// --- Connection behaviour ------------------------------------------------------------------------

test("normal, delayed and silent connections", async (t) => {
  const b = bancada(t);
  const [normal, atrasada, silenciosa] = [novaSala(), novaSala(), novaSala()];
  await b.placa({ credencial: normal.credencial, mac: normal.mac }).conectar();
  await confirmada(normal.sala);

  const placaAtrasada = b.placa({ credencial: atrasada.credencial, mac: atrasada.mac });
  const conexao = placaAtrasada.conectar({ atrasoMs: 120 });
  assert.equal(deviceHub.estadoPublico(atrasada.sala).conectado, false, "not before its delay");
  await conexao;
  await confirmada(atrasada.sala);

  // A silent board holds an open, authenticated channel but never reports: it is connected, and
  // its desired state is not confirmed.
  const muda = b.placa({ credencial: silenciosa.credencial, mac: silenciosa.mac });
  muda.falhas.silenciosa = true;
  await muda.conectar();
  await conectada(silenciosa.sala);
  salasService.aplicarComando(silenciosa.sala, "ligar", undefined, CONTEXTO);
  await muda.aguardar((m) => m.tipo === "send_known_state" && m.versao === versaoDe(silenciosa.sala));
  assert.equal(deviceHub.estadoPublico(silenciosa.sala).estadoConfirmado, false);
});

test("authentication followed by a drop, and a drop in the middle of a command", async (t) => {
  const b = bancada(t);
  const s = novaSala();
  const placa = b.placa({ credencial: s.credencial, mac: s.mac });
  await placa.conectar();
  placa.derrubar();
  await desconectada(s.sala);
  assert.equal(db.prepare("SELECT online FROM salas WHERE sala = ?").get(s.sala).online, 0, "the room is marked offline");

  await placa.conectar();
  await confirmada(s.sala);
  placa.falhas.semConfirmacao = true;
  const marca = placa.totalRecebidas;
  salasService.aplicarComando(s.sala, "desligar", undefined, CONTEXTO);
  await placa.aguardar("send_known_state", { desde: marca });
  placa.derrubar();
  await desconectada(s.sala);
  // The intent survives the drop and is restored on the next connection, where it is confirmed.
  placa.falhas.semConfirmacao = false;
  const antes = placa.totalRecebidas;
  await placa.conectar();
  const restauracao = await placa.aguardar((m) => m.tipo === "send_known_state" && m.restauracao === true, { desde: antes });
  assert.equal(restauracao.power, false);
  assert.equal(restauracao.versao, versaoDe(s.sala));
  await confirmada(s.sala);
});

test("a reconnection storm converges to one session per room", async (t) => {
  const b = bancada(t);
  const salas = Array.from({ length: 6 }, () => novaSala());
  const placas = salas.map((s) => b.placa({ credencial: s.credencial, mac: s.mac, reconectar: { atrasoMs: 0 } }));
  await Promise.all(placas.map((p) => p.conectar()));
  for (let rodada = 0; rodada < 5; rodada += 1) {
    const aberturas = placas.map((p) => new Promise((r) => p.once("aberta", r)));
    for (const p of placas) p.derrubar();
    await Promise.all(aberturas);
  }
  await Promise.all(salas.map((s) => confirmada(s.sala)));
  for (const p of placas) assert.equal(p.conexoes, 6);
  const sessoes = deviceHub.listarConexoes().filter(([sala]) => salas.some((s) => s.sala === sala));
  assert.equal(sessoes.length, salas.length, "exactly one session per room");
});

test("a controlled reconnection replaces the session without a duplicate", async (t) => {
  const b = bancada(t);
  const s = novaSala();
  const primeira = b.placa({ credencial: s.credencial, mac: s.mac });
  await primeira.conectar();
  // Same board opening a second socket before the first is gone: the older one is closed with 4002.
  const segunda = b.placa({ credencial: s.credencial, mac: s.mac });
  await segunda.conectar();
  assert.equal(await primeira.aguardarFechamento(), 4002);
  await confirmada(s.sala);
  await segunda.fechar();
  await desconectada(s.sala);
  await segunda.conectar();
  await confirmada(s.sala);
});

test("boards reconnect by themselves after the server restarts", async (t) => {
  const b = bancada(t);
  const salas = [novaSala(), novaSala()];
  const placas = salas.map((s) => b.placa({ credencial: s.credencial, mac: s.mac, reconectar: { atrasoMs: 50 } }));
  await Promise.all(placas.map((p) => p.conectar()));
  const portaAtual = porta;
  const fechamentos = placas.map((p) => p.aguardarFechamento());
  await derrubarServidor();
  assert.deepEqual(await Promise.all(fechamentos), [1001, 1001], "the server says it is going away");
  // While the server is down the boards keep retrying; they stop at teardown.
  await subirServidor(portaAtual);
  await Promise.all(salas.map((s) => confirmada(s.sala)));
  for (const p of placas) assert.ok(p.conexoes >= 2);
});

// --- Telemetry and confirmation --------------------------------------------------------------

test("confirmation: delayed, duplicated and missing", async (t) => {
  const b = bancada(t);
  const [atrasada, duplicada, ausente] = [novaSala(), novaSala(), novaSala()];
  const placas = {};
  for (const [nome, s] of Object.entries({ atrasada, duplicada, ausente })) {
    placas[nome] = b.placa({ credencial: s.credencial, mac: s.mac });
    await placas[nome].conectar();
    await confirmada(s.sala);
  }
  placas.atrasada.falhas.confirmacaoAtrasadaMs = 150;
  placas.duplicada.falhas.confirmacaoDuplicada = true;
  placas.ausente.falhas.semConfirmacao = true;
  for (const s of [atrasada, duplicada, ausente]) salasService.aplicarComando(s.sala, "ligar", undefined, CONTEXTO);

  assert.equal(deviceHub.estadoPublico(atrasada.sala).estadoConfirmado, false, "not confirmed before the late report");
  await confirmada(atrasada.sala);
  await confirmada(duplicada.sala);
  await placas.ausente.aguardar((m) => m.tipo === "send_known_state" && m.versao === versaoDe(ausente.sala));
  assert.equal(deviceHub.estadoPublico(ausente.sala).estadoConfirmado, false, "a command that is never reported stays unconfirmed");
});

test("stale, out-of-order and duplicate reports never confirm a newer intent", async (t) => {
  const b = bancada(t);
  const s = novaSala();
  const placa = b.placa({ credencial: s.credencial, mac: s.mac });
  await placa.conectar();
  await confirmada(s.sala);
  const confirmadaAntes = versaoDe(s.sala);

  placa.falhas.semConfirmacao = true;
  salasService.aplicarComando(s.sala, "ligar", undefined, CONTEXTO);
  const nova = versaoDe(s.sala);
  await placa.aguardar((m) => m.tipo === "send_known_state" && m.versao === nova);
  // The board reports the previous version (a report produced before the command, arriving after).
  placa.telemetria({ versao: confirmadaAntes });
  placa.telemetria({ versao: confirmadaAntes });
  await ate(() => deviceHub.estadoPublico(s.sala).versaoEstadoReportada === confirmadaAntes);
  assert.equal(deviceHub.estadoPublico(s.sala).estadoConfirmado, false);

  placa.telemetria({ versao: nova });
  placa.telemetria({ versao: nova });
  await confirmada(s.sala);
  // An older report after the confirmation says the board went back: the confirmation is withdrawn
  // instead of kept on the strength of a report that no longer describes the board.
  placa.info({ versao: confirmadaAntes });
  await ate(() => deviceHub.estadoPublico(s.sala).estadoConfirmado === false);
  placa.telemetria({ versao: nova });
  await confirmada(s.sala);
});

test("malformed, unknown and oversized frames do not reach the room; flooding closes the socket", async (t) => {
  const b = bancada(t);
  const s = novaSala();
  const placa = b.placa({ credencial: s.credencial, mac: s.mac });
  await placa.conectar();
  await confirmada(s.sala);
  const telemetriaAntes = deviceHub.estadoPublico(s.sala).ultimaTelemetria;

  placa.enviarBruto("{isto não é json");
  placa.enviarBruto("[1,2,3]");
  placa.enviar({ tipo: 42 });
  placa.enviar({ tipo: "tipo-que-nao-existe", temp: 99 });
  placa.enviar({ tipo: "telemetria", temp: "quente", hum: -5, rssi: 12 });
  await ate(() => deviceHub.estadoPublico(s.sala).ultimaTelemetria !== telemetriaAntes);
  const t1 = deviceHub.estadoPublico(s.sala).ultimaTelemetria;
  assert.equal(t1.temp, null, "an out-of-range reading is dropped, not stored");
  assert.equal(t1.rssi, null);
  assert.ok(placa.aberta(), "malformed frames do not end the session");

  const fechou = placa.aguardarFechamento();
  placa.enviarBruto(Buffer.alloc(300 * 1024, 0x61));
  // The server answers 1009 and drops the connection; the client may see either while still sending.
  assert.ok([1006, 1009].includes(await fechou), "a frame above the payload ceiling closes the socket");
  await desconectada(s.sala);

  await placa.conectar();
  const inundacao = placa.aguardarFechamento();
  for (let i = 0; i < 200; i += 1) placa.enviar({ tipo: "tipo-que-nao-existe" });
  assert.equal(await inundacao, 4008, "the per-socket message budget closes a flood");
});

// --- Identity and credentials ----------------------------------------------------------------

test("credential generations: pending delivered, activated by proof, previous accepted during grace", async (t) => {
  const b = bancada(t);
  const s = novaSala();
  const placa = b.placa({ credencial: s.credencial, mac: s.mac });
  await placa.conectar();

  const rotacao = credenciais.rotacionar(s.sala);
  assert.equal(rotacao.enviadoAoDispositivo, true);
  await placa.aguardar((m) => m.tipo === "credencial_rotacionar" && m.segredo === rotacao.segredo);
  assert.equal(credenciais.estado(s.sala).rotacaoPendente, true, "pending until the board proves it");

  await placa.adotarCredencialRecebida();
  await ate(() => credenciais.estado(s.sala).rotacaoPendente === false, { descricao: "pending generation activated" });
  await confirmada(s.sala);

  // The previous secret still opens a session during the grace period, and the server delivers the
  // current one again so the board can catch up.
  const antiga = b.placa({ credencial: s.credencial, mac: s.mac });
  await antiga.conectar();
  const reentrega = await antiga.aguardar("credencial_rotacionar");
  assert.equal(reentrega.segredo, rotacao.segredo);
  assert.ok(deviceHub.conexaoDaSala(s.sala).credencialExpiraEm, "a grace session carries its expiry");

  // After the grace period the previous secret is refused.
  await antiga.fechar();
  db.prepare("UPDATE esp_credenciais SET anteriorExpiraEm = datetime('now', '-1 minute') WHERE sala = ?").run(s.sala);
  await assert.rejects(b.placa({ credencial: s.credencial, mac: s.mac }).conectar(), (e) => e.codigo === 4001);
});

test("a rotation lost before the board proves it keeps the current secret and is delivered again", async (t) => {
  const b = bancada(t);
  const s = novaSala();
  const placa = b.placa({ credencial: s.credencial, mac: s.mac });
  await placa.conectar();
  placa.falhas.naoAplicarCredencial = true;
  const rotacao = credenciais.rotacionar(s.sala);
  await placa.aguardar("credencial_rotacionar");
  placa.derrubar();
  await desconectada(s.sala);

  const marca = placa.totalRecebidas;
  await placa.conectar();
  assert.equal(credenciais.estado(s.sala).rotacaoPendente, true, "the unproven generation is still pending");
  const entrega = await placa.aguardar("credencial_rotacionar", { desde: marca });
  assert.equal(entrega.segredo, rotacao.segredo, "pending generation delivered again on the next connection");
  await placa.adotarCredencialRecebida();
  await ate(() => credenciais.estado(s.sala).rotacaoPendente === false);
});

test("revoked, wrong, mismatched and MAC-only identities are refused", async (t) => {
  const b = bancada(t);
  const [a, outra, legado] = [novaSala(), novaSala(), novaSala({ credencial: false })];

  const conectadaA = b.placa({ credencial: a.credencial, mac: a.mac });
  await conectadaA.conectar();
  const fechou = conectadaA.aguardarFechamento();
  credenciais.revogar(a.sala);
  assert.equal(await fechou, 4001, "revocation ends the live session");
  const recusa = (placa) => assert.rejects(placa.conectar(), (e) => e.codigo === 4001);
  await recusa(b.placa({ credencial: a.credencial, mac: a.mac }));
  await recusa(b.placa({ credencial: { deviceId: outra.credencial.deviceId, segredo: "segredo-errado-com-tamanho-valido-000" }, mac: outra.mac }));
  // A device id with another room's secret: the identities do not mix.
  await recusa(b.placa({ credencial: { deviceId: outra.credencial.deviceId, segredo: a.credencial.segredo }, mac: outra.mac }));
  await recusa(b.placa({ credencial: { deviceId: "esp_0000000000000000", segredo: outra.credencial.segredo }, mac: outra.mac }));
  // Without a credential the room is identified by its MAC, which must match.
  await recusa(b.placa({ sala: legado.sala, mac: "AA:F1:FF:FF:FF:FF" }));
  await b.placa({ sala: legado.sala, mac: legado.mac }).conectar();
  await conectada(legado.sala);
  for (const s of [a, outra]) assert.equal(deviceHub.estadoPublico(s.sala).conectado, false);
});

// --- OTA ---------------------------------------------------------------------------------------

function publicarFirmware(versao, semente) {
  const buf = Buffer.alloc(96 * 1024, 0);
  buf[0] = 0xe9;
  for (let i = 1; i < buf.length; i += 1) buf[i] = (i * semente) % 251;
  const origem = path.join(RAIZ_TMP, `fw-${versao}.bin`);
  fs.writeFileSync(origem, buf);
  return otaService.publicarFirmware({ origem, versao });
}

async function placaParaOta(b, modo, fw = "4.3.0") {
  const s = novaSala();
  const placa = b.placa({ credencial: s.credencial, mac: s.mac, sala: s.sala, fw });
  placa.ota.modo = modo;
  await placa.conectar();
  await ate(() => deviceHub.estadoPublico(s.sala).fwVersao === fw);
  return { ...s, placa };
}

const faseOta = (sala, fase) => ate(() => otaService.estadoDaSala(sala).fase === fase, { descricao: `OTA de ${sala} em ${fase}`, limiteMs: 6000 });

test("OTA: offer, real download, progress, restart and boot validation", async (t) => {
  const b = bancada(t);
  publicarFirmware("4.4.0", 3);
  const d = await placaParaOta(b, "ok");
  d.placa.ota.baixar = true;
  otaService.ofertar(d.sala);
  await faseOta(d.sala, "concluido");
  const estado = otaService.estadoDaSala(d.sala);
  assert.equal(estado.evidencia, "boot", "completed on the board's own boot validation");
  assert.equal(d.placa.fw, "4.4.0");
  assert.ok(await d.placa.aguardar("ota_validacao_ok"));
});

test("OTA failures end in the phase and cause they deserve", async (t) => {
  const b = bancada(t);
  publicarFirmware("4.5.0", 5);
  const casos = [
    ["erro", "transferencia"],
    ["interromper", "transferencia"],
    ["rollback", "rollback"],
    ["versao-inesperada", "indeterminado"],
  ];
  // The server runs at most two transfers at once; the cases go in pairs.
  for (let i = 0; i < casos.length; i += 2) {
    const par = await Promise.all(casos.slice(i, i + 2).map(async ([modo, causa]) => ({ modo, causa, d: await placaParaOta(b, modo) })));
    for (const { d } of par) otaService.ofertar(d.sala);
    for (const { modo, causa, d } of par) {
      await faseOta(d.sala, "falhou");
      assert.equal(otaService.estadoDaSala(d.sala).causa, causa, `${modo} ends with cause ${causa}`);
    }
  }
  // A duplicated "ok" result is harmless: the update still completes once.
  const dup = await placaParaOta(b, "resultado-duplicado");
  otaService.ofertar(dup.sala);
  await faseOta(dup.sala, "concluido");
});

test("OTA boot validation that never arrives times out", async (t) => {
  const b = bancada(t);
  publicarFirmware("4.6.0", 7);
  const d = await placaParaOta(b, "sem-validacao");
  otaService.ofertar(d.sala);
  await faseOta(d.sala, "validando");
  // The validation window is four minutes: the clock is moved instead of waited.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 5 * 60 * 1000 });
  otaService.verificarTimeouts();
  t.mock.timers.reset();
  assert.equal(otaService.estadoDaSala(d.sala).fase, "falhou");
  assert.equal(otaService.estadoDaSala(d.sala).causa, "validacao");
});

test("a board that stops answering an offer fails by transfer timeout", async (t) => {
  const b = bancada(t);
  publicarFirmware("4.7.0", 9);
  const d = await placaParaOta(b, "parado");
  otaService.ofertar(d.sala);
  await d.placa.aguardar("ota_oferta");
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 5 * 60 * 1000 });
  otaService.verificarTimeouts();
  t.mock.timers.reset();
  assert.equal(otaService.estadoDaSala(d.sala).causa, "transferencia");
});

// --- Mesh ------------------------------------------------------------------------------------

async function malha(b, { nos = 1 } = {}) {
  const gw = novaSala();
  const gateway = b.gateway({ credencial: gw.credencial, mac: gw.mac });
  await gateway.conectar();
  const alvos = Array.from({ length: nos }, () => novaSala());
  const refs = alvos.map((a) => gateway.no({ deviceId: a.credencial.deviceId, segredo: a.credencial.segredo }));
  return { gw, gateway, alvos, refs };
}

const noNaTopologia = (deviceId) => meshService.topologia().nos.find((n) => n.deviceId === deviceId);

test("mesh: nodes behind a gateway, with delayed and duplicated forwarding and a replayed frame", async (t) => {
  const b = bancada(t);
  const { gateway, alvos, refs } = await malha(b, { nos: 2 });
  gateway.relay.atrasoMs = 60;
  gateway.relay.duplicar = true;
  for (const no of refs) gateway.anunciar(no);
  await Promise.all(alvos.map((a) => conectada(a.sala)));
  for (const a of alvos) assert.equal(deviceHub.estadoPublico(a.sala).transporte, "mesh");
  await ate(() => refs.every((no) => no.sessao), { descricao: "node sessions" });

  // Each uplink frame arrives late and twice; the server processes it once and counts the copy.
  const id = alvos[0].credencial.deviceId;
  const registros = () => db.prepare("SELECT cmd FROM comandos_log WHERE sala = ? AND origem = 'esp32_local'").all(alvos[0].sala).map((r) => r.cmd);
  const quadro = gateway.doNo(refs[0], { tipo: "comando", cmd: "ligar", valor: 1 });
  await gateway.drenar();
  await ate(() => registros().length === 1, { descricao: "command processed" });
  const duplicados = noNaTopologia(id).duplicados;
  assert.ok(duplicados >= 1, "the duplicated copy was counted");

  // The same frame captured and replayed later: counted, not processed.
  gateway.relay.duplicar = false;
  gateway.relay.atrasoMs = 0;
  gateway.reenviar(refs[0], quadro);
  await ate(() => noNaTopologia(id).duplicados === duplicados + 1, { descricao: "replay counted" });
  assert.deepEqual(registros(), ["ligar"], "the command frame was processed once");
});

test("mesh: invalid proof, route and parent changes, malformed route metadata", async (t) => {
  const b = bancada(t);
  const { gateway, alvos, refs } = await malha(b, { nos: 2 });
  const impostor = gateway.no({ deviceId: alvos[1].credencial.deviceId, segredo: "segredo-inventado-pelo-gateway-000000" });
  gateway.anunciar(impostor);
  await ate(() => impostor.recusado === "credencial");
  assert.equal(deviceHub.estadoPublico(alvos[1].sala).conectado, false);

  gateway.anunciar(refs[0]);
  await conectada(alvos[0].sala);
  await ate(() => refs[0].sessao);
  const id = alvos[0].credencial.deviceId;
  gateway.doNo(refs[0], { tipo: "telemetria", temp: 22 }, { rota: { pai: "esp_00000000000000aa", saltos: 2, rssi: -70 } });
  await ate(() => noNaTopologia(id).mudancasDeRota === 1);
  gateway.doNo(refs[0], { tipo: "telemetria", temp: 22 }, { rota: { pai: "esp_00000000000000bb", saltos: 2, rssi: -71 } });
  await ate(() => noNaTopologia(id).pai === "esp_00000000000000bb");
  assert.equal(noNaTopologia(id).mudancasDeRota, 2, "a parent change is a route change");
  // Values outside the protocol's bounds are ignored, not stored.
  gateway.doNo(refs[0], { tipo: "telemetria", temp: 22 }, { rota: { pai: "não é um nó", saltos: 99, rssi: 50 } });
  await ate(() => deviceHub.estadoPublico(alvos[0].sala).ultimaTelemetria?.temp === 22);
  const no = noNaTopologia(id);
  assert.deepEqual([no.pai, no.saltos, no.rssi], ["esp_00000000000000bb", 2, -71]);
});

test("mesh: a node leaving and the gateway disappearing take the rooms offline", async (t) => {
  const b = bancada(t);
  const { gateway, alvos, refs } = await malha(b, { nos: 2 });
  for (const no of refs) gateway.anunciar(no);
  await Promise.all(alvos.map((a) => conectada(a.sala)));

  gateway.anunciar(refs[0], "saiu");
  await desconectada(alvos[0].sala);
  assert.equal(noNaTopologia(alvos[0].credencial.deviceId).estado, "inalcancavel");
  assert.equal(deviceHub.estadoPublico(alvos[1].sala).conectado, true, "the other node is unaffected");

  gateway.derrubar();
  await desconectada(alvos[1].sala);
  assert.equal(noNaTopologia(alvos[1].credencial.deviceId).estado, "inalcancavel");
});

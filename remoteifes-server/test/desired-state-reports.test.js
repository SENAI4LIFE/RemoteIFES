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

let server;
let wsUrl;
const abertos = new Set();
const ADMIN = { usuario: { id: 1, usuario: "superadmin", isAdmin: true, podeControlar: true, nivel: 3 }, origem: "manual" };
const FAILSAFE = { failsafeConfigurado: true, failsafePulsos: 4, failsafeCarrierHz: 38000, failsafeProtocolRecordId: 1 };

function sala(codigo, mac, ligado) {
  db.prepare("INSERT OR IGNORE INTO salas (sala, nome, bloco, andar, mac, ligado, temperaturaAlvo, irProtocolo) VALUES (?, ?, 'A', 1, ?, ?, 23, 16)").run(codigo, codigo, mac, ligado ? 1 : 0);
}

function linha(codigo) {
  return db.prepare("SELECT ligado, turboAtivo, temperaturaAlvo, estadoVersao FROM salas WHERE sala = ?").get(codigo);
}

function esperar(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function ate(condicao, limiteMs = 3000) {
  const inicio = Date.now();
  while (!condicao() && Date.now() - inicio < limiteMs) await esperar(10);
  return condicao();
}

async function conectar(codigo, mac) {
  const mensagens = [];
  const ws = new WebSocket(wsUrl, { headers: { "x-device-sala": codigo, "x-device-mac": mac } });
  abertos.add(ws);
  ws.on("message", (d) => mensagens.push(JSON.parse(d.toString())));
  ws.once("close", () => abertos.delete(ws));
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  await ate(() => mensagens.some((m) => m.tipo === "device_role"));
  return {
    ws,
    mensagens,
    enviar: (m) => ws.send(JSON.stringify(m)),
    estados: () => mensagens.filter((m) => m.tipo === "send_known_state"),
    // Waits for the server-side close (entry removed), not only for the socket in CLOSING.
    fechar: async () => { ws.close(); await ate(() => !deviceHub.estadoPublico(codigo).conectado); },
  };
}

function status(codigo) {
  return salasService.statusCompleto(codigo, ADMIN.usuario);
}

function ouvirMudancasDeSala(t, codigo) {
  const contagem = { valor: 0 };
  const ouvinte = ({ sala: s }) => { if (s === codigo) contagem.valor += 1; };
  salasService.eventos.on("mudanca-sala", ouvinte);
  t.after(() => salasService.eventos.removeListener("mudanca-sala", ouvinte));
  return contagem;
}

test.before(async () => {
  server = http.createServer(app);
  statusHub.iniciar(server);
  deviceHub.iniciar(server);
  await new Promise((r) => server.listen(0, r));
  wsUrl = `ws://127.0.0.1:${server.address().port}/ws/dispositivo`;
});

test.after(async () => {
  for (const ws of abertos) {
    try { ws.terminate(); } catch (erro) {}
  }
  deviceHub.encerrar();
  statusHub.encerrar();
  await new Promise((r) => server.close(r));
});

test("late telemetry does not erase an already persisted command, and reconnection restores the intent", async () => {
  sala("REL-1", "AA:BB:CC:E1:00:01", false);
  const d = await conectar("REL-1", "AA:BB:CC:E1:00:01");
  d.enviar({ tipo: "info", fw: "4.2.0", failsafeConfigurado: false, failsafeLatched: false });
  assert.ok(await ate(() => d.estados().length === 1));
  assert.equal(d.estados()[0].power, false);
  assert.equal(d.estados()[0].restauracao, true, "the initial synchronization is marked as restoration");

  const resultado = salasService.aplicarComando("REL-1", "ligar", undefined, ADMIN);
  assert.equal(resultado.enviadoAoDispositivo, true, "the response distinguishes submission to the socket from application by the board");
  assert.equal(linha("REL-1").ligado, 1);
  assert.ok(await ate(() => d.estados().length === 2));
  assert.equal(d.estados()[1].restauracao, undefined, "an explicit command is not restoration");
  assert.equal(d.estados()[1].versao, linha("REL-1").estadoVersao);

  d.enviar({ tipo: "telemetria", fw: "4.2.0", modo: "operation", ligado: false, rssi: -50, temp: 24, ultimoComando: { tipo: "known_state", protocol: 16, temp: 23, power: false, turbo: false } });
  await ate(() => deviceHub.estadoPublico("REL-1").ultimaTelemetria?.ligado === false);
  assert.equal(linha("REL-1").ligado, 1, "the board's old echo does not undo the command");
  assert.equal(status("REL-1").dispositivoConfirmou, false, "and does not count as confirmation either");

  await d.fechar();
  const r = await conectar("REL-1", "AA:BB:CC:E1:00:01");
  r.enviar({ tipo: "info", fw: "4.2.0", failsafeConfigurado: false, failsafeLatched: false });
  assert.ok(await ate(() => r.estados().length === 1));
  assert.equal(r.estados()[0].power, true, "reconnection reapplies the intent the user requested");
  await r.fechar();
});

test("the HTTP heartbeat does not rewrite the intent with the board's echo either", async () => {
  sala("REL-2", "AA:BB:CC:E1:00:02", true);
  salasService.heartbeatDispositivo("REL-2", { ligado: false, temperatura: 25 }, "AA:BB:CC:E1:00:02", "127.0.0.1");
  const row = db.prepare("SELECT ligado, temperatura, online FROM salas WHERE sala = 'REL-2'").get();
  assert.equal(row.ligado, 1);
  assert.equal(row.temperatura, 25, "the sensor reading is still recorded");
  assert.equal(row.online, 1);
});

test("confirmation by the board is exposed to the panel and notifies only room observers", async (t) => {
  sala("REL-3", "AA:BB:CC:E1:00:03", false);
  assert.equal(status("REL-3").dispositivoConfirmou, null, "without a connected board there is nothing to confirm");
  const mudancas = ouvirMudancasDeSala(t, "REL-3");
  const d = await conectar("REL-3", "AA:BB:CC:E1:00:03");
  d.enviar({ tipo: "info", fw: "4.3.0", failsafeConfigurado: false, failsafeLatched: false });
  assert.ok(await ate(() => d.estados().length === 1));
  assert.equal(status("REL-3").dispositivoConfirmou, false);

  const versao = d.estados()[0].versao;
  d.enviar({ tipo: "telemetria", fw: "4.3.0", modo: "operation", ligado: false, versao, failsafeConfigurado: false, failsafeLatched: false });
  assert.ok(await ate(() => status("REL-3").dispositivoConfirmou === true));
  assert.equal(mudancas.valor, 1, "the confirmation change notifies the room's observers");
  assert.equal(deviceHub.estadoPublico("REL-3").estadoConfirmado, true);
  assert.equal(deviceHub.estadoPublico("REL-3").versaoEstadoReportada, versao);

  salasService.aplicarComando("REL-3", "temperatura", 25, ADMIN);
  assert.equal(status("REL-3").dispositivoConfirmou, false, "a new command waits for the board again");
  assert.ok(await ate(() => d.estados().length === 2));
  d.enviar({ tipo: "telemetria", fw: "4.3.0", modo: "operation", ligado: true, versao, failsafeConfigurado: false, failsafeLatched: false });
  await esperar(100);
  assert.equal(status("REL-3").dispositivoConfirmou, false, "an echo of the previous version does not confirm the new one");
  d.enviar({ tipo: "telemetria", fw: "4.3.0", modo: "operation", ligado: true, versao: d.estados()[1].versao, failsafeConfigurado: false, failsafeLatched: false });
  assert.ok(await ate(() => status("REL-3").dispositivoConfirmou === true));
  await d.fechar();
  assert.equal(status("REL-3").dispositivoConfirmou, null);
});

test("firmware without version echo confirms through the last reported command", async () => {
  sala("REL-4", "AA:BB:CC:E1:00:04", true);
  const d = await conectar("REL-4", "AA:BB:CC:E1:00:04");
  d.enviar({ tipo: "info", fw: "4.2.0", failsafeConfigurado: false, failsafeLatched: false });
  assert.ok(await ate(() => d.estados().length === 1));
  d.enviar({ tipo: "telemetria", fw: "4.2.0", modo: "operation", ligado: true, ultimoComando: { tipo: "known_state", protocol: 16, temp: 22, power: true, turbo: false } });
  await esperar(100);
  assert.equal(status("REL-4").dispositivoConfirmou, false, "a temperature different from the desired one does not confirm");
  d.enviar({ tipo: "telemetria", fw: "4.2.0", modo: "operation", ligado: true, ultimoComando: { tipo: "known_state", protocol: 16, temp: 23, power: true, turbo: false } });
  assert.ok(await ate(() => status("REL-4").dispositivoConfirmou === true));
  await d.fechar();
});

test("late info: restoration is flagged, the late info does not adopt the latch, and new firmware's failsafe_status does", async () => {
  sala("REL-5", "AA:BB:CC:E1:00:05", true);
  const d = await conectar("REL-5", "AA:BB:CC:E1:00:05");
  assert.ok(await ate(() => d.estados().length === 1, 4000), "without info, the state goes out after the safety wait");
  assert.equal(d.estados()[0].restauracao, true);
  assert.equal(d.estados()[0].power, true);
  const versao = d.estados()[0].versao;

  d.enviar({ tipo: "info", fw: "4.2.0", ...FAILSAFE, failsafeLatched: true, ligado: false });
  await ate(() => deviceHub.estadoPublico("REL-5").failsafe?.latched === true);
  assert.equal(linha("REL-5").ligado, 1, "an info older than the restoration must not be taken as the board's current state");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM comandos_log WHERE sala = 'REL-5' AND cmd = 'failsafe_off_local'").get().n, 0);

  d.enviar({ tipo: "failsafe_status", ...FAILSAFE, failsafeLatched: true, versao });
  assert.ok(await ate(() => linha("REL-5").ligado === 0), "the latched board's refusal of the restoration is adopted as a local shutdown");
  assert.equal(linha("REL-5").estadoVersao, versao, "adopting the local OFF does not advance the version");
  assert.ok(db.prepare("SELECT 1 FROM comandos_log WHERE sala = 'REL-5' AND cmd = 'failsafe_off_local' AND valor = 'adotado_em_operacao' AND origem = 'esp32_local'").get());
  assert.equal(status("REL-5").dispositivoConfirmou, true, "board off and intent off are reconciled");
  assert.equal(d.estados().length, 1, "nothing else is resent");
  await d.fechar();
});

test("an info already received on the socket is processed before the timeout-driven synchronization, even after an event-loop pause", async () => {
  sala("REL-6", "AA:BB:CC:E1:00:06", true);
  const d = await conectar("REL-6", "AA:BB:CC:E1:00:06");
  await esperar(2700);
  await new Promise((resolve) => {
    d.ws.once("pong", () => {
      d.enviar({ tipo: "info", fw: "4.2.0", ...FAILSAFE, failsafeLatched: true, ligado: false });
      const fim = Date.now() + 600;
      while (Date.now() < fim) {}
      resolve();
    });
    d.ws.ping();
  });
  await esperar(200);
  assert.equal(d.estados().length, 0, "the queued info wins over the timeout synchronization: no state is resent over the latch");
  assert.equal(linha("REL-6").ligado, 0);
  assert.ok(db.prepare("SELECT 1 FROM comandos_log WHERE sala = 'REL-6' AND cmd = 'failsafe_off_local' AND valor = 'mantido_na_reconexao'").get());
  await d.fechar();
});

test("latch reported during operation: adopted when it reflects the current intent, ignored when it predates an explicit command", async () => {
  sala("REL-7", "AA:BB:CC:E1:00:07", true);
  const d = await conectar("REL-7", "AA:BB:CC:E1:00:07");
  d.enviar({ tipo: "info", fw: "4.3.0", ...FAILSAFE, failsafeLatched: false });
  assert.ok(await ate(() => d.estados().length === 1));
  const v1 = d.estados()[0].versao;
  d.enviar({ tipo: "telemetria", fw: "4.3.0", modo: "operation", ligado: true, versao: v1, ...FAILSAFE, failsafeLatched: false });
  assert.ok(await ate(() => status("REL-7").dispositivoConfirmou === true));

  d.enviar({ tipo: "telemetria", fw: "4.3.0", modo: "operation", ligado: false, versao: v1, ...FAILSAFE, failsafeLatched: true });
  assert.ok(await ate(() => linha("REL-7").ligado === 0), "the physical switch turned the room off after the last command: the server adopts it");
  assert.equal(status("REL-7").dispositivoConfirmou, true);

  salasService.aplicarComando("REL-7", "ligar", undefined, ADMIN);
  assert.ok(await ate(() => d.estados().length === 2));
  const v2 = d.estados()[1].versao;
  assert.ok(v2 > v1);
  d.enviar({ tipo: "telemetria", fw: "4.3.0", modo: "operation", ligado: false, versao: v1, ...FAILSAFE, failsafeLatched: true });
  await esperar(100);
  assert.equal(linha("REL-7").ligado, 1, "a report older than the command does not erase the new intent");
  assert.equal(status("REL-7").dispositivoConfirmou, false);
  d.enviar({ tipo: "telemetria", fw: "4.3.0", modo: "operation", ligado: true, versao: v2, ...FAILSAFE, failsafeLatched: false });
  assert.ok(await ate(() => status("REL-7").dispositivoConfirmou === true));
  assert.equal(linha("REL-7").ligado, 1);
  await d.fechar();
});

test("firmware 4.2.0: a latch during operation is adopted only after the connection confirmed the current intent", async () => {
  sala("REL-8", "AA:BB:CC:E1:00:08", true);
  const d = await conectar("REL-8", "AA:BB:CC:E1:00:08");
  d.enviar({ tipo: "info", fw: "4.2.0", ...FAILSAFE, failsafeLatched: false });
  assert.ok(await ate(() => d.estados().length === 1));
  d.enviar({ tipo: "telemetria", fw: "4.2.0", modo: "operation", ligado: false, ...FAILSAFE, failsafeLatched: true, ultimoComando: { tipo: "failsafe" } });
  await esperar(100);
  assert.equal(linha("REL-8").ligado, 1, "without proof the board has processed the intent, the latch may predate it");

  d.enviar({ tipo: "telemetria", fw: "4.2.0", modo: "operation", ligado: true, ...FAILSAFE, failsafeLatched: false, ultimoComando: { tipo: "known_state", protocol: 16, temp: 23, power: true, turbo: false } });
  assert.ok(await ate(() => status("REL-8").dispositivoConfirmou === true));
  d.enviar({ tipo: "telemetria", fw: "4.2.0", modo: "operation", ligado: false, ...FAILSAFE, failsafeLatched: true, ultimoComando: { tipo: "failsafe" } });
  assert.ok(await ate(() => linha("REL-8").ligado === 0), "after confirmation, message order proves the latch is later");
  await d.fechar();
});

test("a latch adopted on reconnection is recorded once and never resends the ON state", async () => {
  sala("REL-9", "AA:BB:CC:E1:00:09", true);
  const d = await conectar("REL-9", "AA:BB:CC:E1:00:09");
  d.enviar({ tipo: "info", fw: "4.3.0", ...FAILSAFE, failsafeLatched: true, ligado: false });
  assert.ok(await ate(() => linha("REL-9").ligado === 0));
  d.enviar({ tipo: "info", fw: "4.3.0", ...FAILSAFE, failsafeLatched: true, ligado: false });
  d.enviar({ tipo: "telemetria", fw: "4.3.0", modo: "operation", ligado: false, ...FAILSAFE, failsafeLatched: true });
  await esperar(150);
  assert.equal(d.estados().length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM comandos_log WHERE sala = 'REL-9' AND cmd = 'failsafe_off_local'").get().n, 1);
  assert.equal(status("REL-9").dispositivoConfirmou, true);
  await d.fechar();
});

test("every intent change advances the state version and resends it with the command", () => {
  sala("REL-10", "AA:BB:CC:E1:00:10", false);
  const v0 = linha("REL-10").estadoVersao;
  salasService.aplicarComando("REL-10", "ligar", undefined, ADMIN);
  salasService.aplicarComando("REL-10", "temperatura", 24, ADMIN);
  salasService.aplicarComando("REL-10", "turbo", true, ADMIN);
  salasService.aplicarComando("REL-10", "desligar", undefined, ADMIN);
  assert.equal(linha("REL-10").estadoVersao, v0 + 4);
  salasService.aplicarInicioAgendamento("REL-10", 24);
  assert.equal(linha("REL-10").estadoVersao, v0 + 5);
  salasService.definirLimitesTemperatura("REL-10", { minima: 23, maxima: 25 });
  assert.equal(linha("REL-10").estadoVersao, v0 + 6);
  const configuracoes = require("../src/services/configuracoesService");
  const limitesAntes = configuracoes.limitesTemperatura();
  configuracoes.validarEAtualizar({ turboFuncaoExtra: configuracoes.turboFuncaoExtra() === "swing" ? "nenhuma" : "swing" }, ADMIN.usuario);
  assert.equal(linha("REL-10").estadoVersao, v0 + 7, "a global setting that changes the IR state advances the version");
  assert.equal(salasService.comandoEstadoIR(salasService.buscar("REL-10")).versao, v0 + 7);
  salasService.reenviarEstadoIRParaTodas();
  assert.equal(linha("REL-10").estadoVersao, v0 + 7, "resending the same state is not new intent");
  configuracoes.validarEAtualizar({ modoManutencao: false }, ADMIN.usuario);
  assert.equal(linha("REL-10").estadoVersao, v0 + 7, "a setting that does not touch the IR state does not advance the version");
  assert.deepEqual(configuracoes.limitesTemperatura(), limitesAntes);
  salasService.adotarDesligamentoLocal("REL-10");
  assert.equal(linha("REL-10").estadoVersao, v0 + 7, "adopting the local OFF is not new intent");
});

test("an explicit command sent before the late initial info is not erased by the old latch, and the board confirms it", async () => {
  sala("REL-12", "AA:BB:CC:E1:00:12", false);
  const d = await conectar("REL-12", "AA:BB:CC:E1:00:12");
  const resultado = salasService.aplicarComando("REL-12", "ligar", undefined, ADMIN);
  assert.equal(resultado.enviadoAoDispositivo, true);
  assert.ok(await ate(() => d.estados().length === 1));
  const v = d.estados()[0].versao;
  assert.equal(d.estados()[0].restauracao, undefined);

  d.enviar({ tipo: "info", fw: "4.3.0", ...FAILSAFE, failsafeLatched: true, ligado: false, versao: v - 1 });
  await esperar(150);
  assert.equal(linha("REL-12").ligado, 1, "the info describes the board before the command: the old latch does not erase the new intent");
  assert.equal(d.estados().length, 1, "nothing is restored over the explicit command already sent");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM comandos_log WHERE sala = 'REL-12' AND cmd = 'failsafe_off_local'").get().n, 0);
  assert.equal(status("REL-12").dispositivoConfirmou, false);

  d.enviar({ tipo: "telemetria", fw: "4.3.0", modo: "operation", ligado: true, versao: v, ...FAILSAFE, failsafeLatched: false });
  assert.ok(await ate(() => status("REL-12").dispositivoConfirmou === true));
  assert.equal(linha("REL-12").ligado, 1);

  d.enviar({ tipo: "telemetria", fw: "4.3.0", modo: "operation", ligado: false, versao: v, ...FAILSAFE, failsafeLatched: true });
  assert.ok(await ate(() => linha("REL-12").ligado === 0), "a latch after the command is still adopted");
  await d.fechar();

  sala("REL-13", "AA:BB:CC:E1:00:13", false);
  const e = await conectar("REL-13", "AA:BB:CC:E1:00:13");
  salasService.aplicarComando("REL-13", "ligar", undefined, ADMIN);
  assert.ok(await ate(() => e.estados().length === 1));
  e.enviar({ tipo: "info", fw: "4.2.0", ...FAILSAFE, failsafeLatched: true, ligado: false });
  await esperar(150);
  assert.equal(linha("REL-13").ligado, 1, "without version echo the late info does not adopt a latch older than the command either");
  await esperar(3200);
  assert.equal(e.estados().length, 1, "the timeout synchronization does not resend the state already sent");
  await e.fechar();
});

test("an administrative IR test invalidates confirmation until newer intent is sent", async (t) => {
  sala("REL-14", "AA:BB:CC:E1:00:14", true);
  const d = await conectar("REL-14", "AA:BB:CC:E1:00:14");
  d.enviar({ tipo: "info", fw: "4.3.0", ...FAILSAFE, failsafeLatched: false });
  assert.ok(await ate(() => d.estados().length === 1));
  const v = d.estados()[0].versao;
  d.enviar({ tipo: "telemetria", fw: "4.3.0", modo: "operation", ligado: true, versao: v, ...FAILSAFE, failsafeLatched: false });
  assert.ok(await ate(() => status("REL-14").dispositivoConfirmou === true));

  const mudancas = ouvirMudancasDeSala(t, "REL-14");
  assert.equal(deviceHub.enviarTesteIR("REL-14", { tipo: "send_known_state", protocol: 16, temp: 30, power: false, turbo: false, fan: "", swing: false }), true);
  assert.equal(status("REL-14").dispositivoConfirmou, false, "the appliance was put into a state that is not the intent");
  assert.equal(linha("REL-14").ligado, 1, "the test changes neither the intent nor the version");
  assert.equal(linha("REL-14").estadoVersao, v);
  assert.equal(mudancas.valor, 1, "the panel is notified of the lost confirmation");
  assert.ok(await ate(() => d.estados().length === 2));
  assert.equal(d.estados()[1].versao, undefined, "the test goes out without a version");

  d.enviar({ tipo: "telemetria", fw: "4.3.0", modo: "operation", ligado: false, versao: v, ...FAILSAFE, failsafeLatched: false, ultimoComando: { tipo: "known_state", protocol: 16, temp: 30, power: false, turbo: false } });
  await esperar(150);
  assert.equal(status("REL-14").dispositivoConfirmou, false, "an echo of the version before the test does not confirm again");
  assert.equal(linha("REL-14").ligado, 1);

  salasService.aplicarComando("REL-14", "ligar", undefined, ADMIN);
  assert.ok(await ate(() => d.estados().length === 3));
  const v2 = d.estados()[2].versao;
  assert.ok(v2 > v);
  d.enviar({ tipo: "telemetria", fw: "4.3.0", modo: "operation", ligado: true, versao: v2, ...FAILSAFE, failsafeLatched: false });
  assert.ok(await ate(() => status("REL-14").dispositivoConfirmou === true), "the new intent becomes confirmable again");

  assert.equal(deviceHub.enviarTesteIR("REL-14", { tipo: "send_raw", raw: [9000, 4500, 560, 560], carrierHz: 38000 }), true);
  assert.equal(status("REL-14").dispositivoConfirmou, false, "a RAW also takes the board out of the desired state");
  d.enviar({ tipo: "telemetria", fw: "4.3.0", modo: "operation", ligado: false, versao: v2, ...FAILSAFE, failsafeLatched: true });
  assert.ok(await ate(() => linha("REL-14").ligado === 0), "a latch after the test is still adopted: the echo proves it is later than the intent");
  assert.equal(status("REL-14").dispositivoConfirmou, true, "board and intent off are reconciled");
  await d.fechar();
});

test("a failure writing global limits leaves no half intent or version and sends nothing to the board", (t) => {
  sala("REL-15", "AA:BB:CC:E1:00:15", true);
  const configuracoes = require("../src/services/configuracoesService");
  const antesCfg = configuracoes.limitesTemperatura();
  db.prepare("UPDATE salas SET temperaturaAlvo = 18 WHERE sala = 'REL-15'").run();
  const antes = linha("REL-15");
  const enviados = [];
  t.mock.method(deviceHub, "enviarComando", (s, payload) => { enviados.push({ sala: s, payload }); return true; });
  const preparar = db.prepare.bind(db);
  t.mock.method(db, "prepare", (sql, ...resto) => {
    if (/UPDATE salas SET estadoVersao = estadoVersao \+ 1 WHERE irProtocolo IS NOT NULL/.test(sql)) {
      return { run: () => { throw new Error("SQLITE_FULL simulado"); } };
    }
    return preparar(sql, ...resto);
  });
  assert.throws(() => configuracoes.validarEAtualizar({ temperaturaMinima: 20, temperaturaMaxima: 28 }, ADMIN.usuario), /SQLITE_FULL/);
  assert.deepEqual(configuracoes.limitesTemperatura(), antesCfg, "the configuration was not written");
  assert.deepEqual(linha("REL-15"), antes, "the target was not adjusted without the version advancing with it");
  assert.equal(enviados.length, 0, "nothing is submitted to the board without a commit");

  db.prepare.mock.restore();
  configuracoes.validarEAtualizar({ temperaturaMinima: 20, temperaturaMaxima: 28 }, ADMIN.usuario);
  const depois = linha("REL-15");
  assert.equal(depois.temperaturaAlvo, 20, "the target is adjusted to the new limit");
  assert.equal(depois.estadoVersao, antes.estadoVersao + 1);
  assert.equal(enviados.find((e) => e.sala === "REL-15").payload.versao, depois.estadoVersao, "the resend goes out with the stored version");
  configuracoes.validarEAtualizar({ temperaturaMinima: antesCfg.minima, temperaturaMaxima: antesCfg.maxima }, ADMIN.usuario);

  t.mock.method(db, "prepare", (sql, ...resto) => {
    if (/UPDATE agendamentos SET temperatura = MAX/.test(sql)) return { run: () => { throw new Error("SQLITE_FULL simulado"); } };
    return preparar(sql, ...resto);
  });
  const antesSala = linha("REL-15");
  enviados.length = 0;
  assert.throws(() => salasService.definirLimitesTemperatura("REL-15", { minima: 22, maxima: 26 }), /SQLITE_FULL/);
  assert.deepEqual(linha("REL-15"), antesSala, "per-room limits: the room does not change if the second write fails");
  assert.equal(enviados.length, 0);
});

test("the scheduler does not repeat a command whose execution record failed: state and record persist together", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: new Date("2026-09-06T11:59:00Z") });
  const agendamentos = require("../src/services/agendamentosService");
  const { dataAtualBrasiliaISO } = require("../src/utils/tempo");
  const scheduler = require("../src/scheduler/schedulerService");
  t.after(() => scheduler.pararScheduler());
  const usuario = db.prepare("SELECT * FROM usuarios WHERE nivel = 3").get();
  const codigo = "REL-11";
  db.prepare("INSERT INTO salas (sala, nome, bloco, andar) VALUES (?, ?, 'A', 1)").run(codigo, codigo);
  const ag = agendamentos.criar({ sala: codigo, usuarioId: usuario.id, data: dataAtualBrasiliaISO(), temperatura: 24, horaInicio: "09:00", horaFim: "10:00" });

  const preparar = db.prepare.bind(db);
  let falhas = 1;
  t.mock.method(db, "prepare", (sql, ...resto) => {
    if (/INSERT INTO agendamentos_execucoes/.test(sql) && falhas > 0) {
      falhas -= 1;
      return { run: () => { throw new Error("SQLITE_FULL simulado"); } };
    }
    return preparar(sql, ...resto);
  });

  scheduler.iniciarScheduler();
  t.mock.timers.tick(60000);
  assert.equal(linha(codigo).ligado, 0, "with the record failing, the room does not change state");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM comandos_log WHERE sala = ?").get(codigo).n, 0);
  assert.equal(agendamentos.jaExecutadoHoje(ag.id, "ligar", dataAtualBrasiliaISO()), false);

  t.mock.timers.tick(60000);
  assert.equal(linha(codigo).ligado, 1, "on the next tick the schedule is applied exactly once");
  assert.equal(agendamentos.jaExecutadoHoje(ag.id, "ligar", dataAtualBrasiliaISO()), true);
  assert.deepEqual(db.prepare("SELECT cmd FROM comandos_log WHERE sala = ? ORDER BY id").all(codigo).map((l) => l.cmd), ["ligar", "temperatura"]);

  salasService.aplicarComando(codigo, "desligar", undefined, ADMIN);
  t.mock.timers.tick(60000);
  assert.equal(linha(codigo).ligado, 0, "the manual shutdown is not overwritten by a repeated schedule");
});

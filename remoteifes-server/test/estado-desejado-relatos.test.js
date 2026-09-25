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

test("uma telemetria atrasada não apaga um comando já persistido, e a reconexão restaura a intenção", async () => {
  sala("REL-1", "AA:BB:CC:E1:00:01", false);
  const d = await conectar("REL-1", "AA:BB:CC:E1:00:01");
  d.enviar({ tipo: "info", fw: "4.2.0", failsafeConfigurado: false, failsafeLatched: false });
  assert.ok(await ate(() => d.estados().length === 1));
  assert.equal(d.estados()[0].power, false);
  assert.equal(d.estados()[0].restauracao, true, "a sincronização inicial é marcada como restauração");

  const resultado = salasService.aplicarComando("REL-1", "ligar", undefined, ADMIN);
  assert.equal(resultado.enviadoAoDispositivo, true, "a resposta distingue a submissão ao socket da aplicação pela placa");
  assert.equal(linha("REL-1").ligado, 1);
  assert.ok(await ate(() => d.estados().length === 2));
  assert.equal(d.estados()[1].restauracao, undefined, "um comando explícito não é restauração");
  assert.equal(d.estados()[1].versao, linha("REL-1").estadoVersao);

  d.enviar({ tipo: "telemetria", fw: "4.2.0", modo: "operation", ligado: false, rssi: -50, temp: 24, ultimoComando: { tipo: "known_state", protocol: 16, temp: 23, power: false, turbo: false } });
  await ate(() => deviceHub.estadoPublico("REL-1").ultimaTelemetria?.ligado === false);
  assert.equal(linha("REL-1").ligado, 1, "o eco antigo da placa não desfaz o comando");
  assert.equal(status("REL-1").dispositivoConfirmou, false, "e também não conta como confirmação");

  await d.fechar();
  const r = await conectar("REL-1", "AA:BB:CC:E1:00:01");
  r.enviar({ tipo: "info", fw: "4.2.0", failsafeConfigurado: false, failsafeLatched: false });
  assert.ok(await ate(() => r.estados().length === 1));
  assert.equal(r.estados()[0].power, true, "a reconexão reaplica a intenção que o usuário pediu");
  await r.fechar();
});

test("o heartbeat HTTP também não reescreve a intenção com o eco da placa", async () => {
  sala("REL-2", "AA:BB:CC:E1:00:02", true);
  salasService.heartbeatDispositivo("REL-2", { ligado: false, temperatura: 25 }, "AA:BB:CC:E1:00:02", "127.0.0.1");
  const row = db.prepare("SELECT ligado, temperatura, online FROM salas WHERE sala = 'REL-2'").get();
  assert.equal(row.ligado, 1);
  assert.equal(row.temperatura, 25, "a leitura do sensor continua sendo registrada");
  assert.equal(row.online, 1);
});

test("a confirmação pela placa é exposta ao painel e avisa só quem observa a sala", async (t) => {
  sala("REL-3", "AA:BB:CC:E1:00:03", false);
  assert.equal(status("REL-3").dispositivoConfirmou, null, "sem placa conectada não há o que confirmar");
  const mudancas = ouvirMudancasDeSala(t, "REL-3");
  const d = await conectar("REL-3", "AA:BB:CC:E1:00:03");
  d.enviar({ tipo: "info", fw: "4.3.0", failsafeConfigurado: false, failsafeLatched: false });
  assert.ok(await ate(() => d.estados().length === 1));
  assert.equal(status("REL-3").dispositivoConfirmou, false);

  const versao = d.estados()[0].versao;
  d.enviar({ tipo: "telemetria", fw: "4.3.0", modo: "operation", ligado: false, versao, failsafeConfigurado: false, failsafeLatched: false });
  assert.ok(await ate(() => status("REL-3").dispositivoConfirmou === true));
  assert.equal(mudancas.valor, 1, "a mudança de confirmação avisa os observadores da sala");
  assert.equal(deviceHub.estadoPublico("REL-3").estadoConfirmado, true);
  assert.equal(deviceHub.estadoPublico("REL-3").versaoEstadoReportada, versao);

  salasService.aplicarComando("REL-3", "temperatura", 25, ADMIN);
  assert.equal(status("REL-3").dispositivoConfirmou, false, "um comando novo volta a aguardar a placa");
  assert.ok(await ate(() => d.estados().length === 2));
  d.enviar({ tipo: "telemetria", fw: "4.3.0", modo: "operation", ligado: true, versao, failsafeConfigurado: false, failsafeLatched: false });
  await esperar(100);
  assert.equal(status("REL-3").dispositivoConfirmou, false, "o eco da versão anterior não confirma a nova");
  d.enviar({ tipo: "telemetria", fw: "4.3.0", modo: "operation", ligado: true, versao: d.estados()[1].versao, failsafeConfigurado: false, failsafeLatched: false });
  assert.ok(await ate(() => status("REL-3").dispositivoConfirmou === true));
  await d.fechar();
  assert.equal(status("REL-3").dispositivoConfirmou, null);
});

test("firmware sem eco de versão confirma pelo último comando relatado", async () => {
  sala("REL-4", "AA:BB:CC:E1:00:04", true);
  const d = await conectar("REL-4", "AA:BB:CC:E1:00:04");
  d.enviar({ tipo: "info", fw: "4.2.0", failsafeConfigurado: false, failsafeLatched: false });
  assert.ok(await ate(() => d.estados().length === 1));
  d.enviar({ tipo: "telemetria", fw: "4.2.0", modo: "operation", ligado: true, ultimoComando: { tipo: "known_state", protocol: 16, temp: 22, power: true, turbo: false } });
  await esperar(100);
  assert.equal(status("REL-4").dispositivoConfirmou, false, "temperatura diferente da desejada não confirma");
  d.enviar({ tipo: "telemetria", fw: "4.2.0", modo: "operation", ligado: true, ultimoComando: { tipo: "known_state", protocol: 16, temp: 23, power: true, turbo: false } });
  assert.ok(await ate(() => status("REL-4").dispositivoConfirmou === true));
  await d.fechar();
});

test("info atrasado: a restauração sai marcada, o info tardio não adota a trava, e o failsafe_status do firmware novo adota", async () => {
  sala("REL-5", "AA:BB:CC:E1:00:05", true);
  const d = await conectar("REL-5", "AA:BB:CC:E1:00:05");
  assert.ok(await ate(() => d.estados().length === 1, 4000), "sem info, o estado sai após a espera de segurança");
  assert.equal(d.estados()[0].restauracao, true);
  assert.equal(d.estados()[0].power, true);
  const versao = d.estados()[0].versao;

  d.enviar({ tipo: "info", fw: "4.2.0", ...FAILSAFE, failsafeLatched: true, ligado: false });
  await ate(() => deviceHub.estadoPublico("REL-5").failsafe?.latched === true);
  assert.equal(linha("REL-5").ligado, 1, "um info anterior à restauração não pode ser tomado como o estado atual da placa");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM comandos_log WHERE sala = 'REL-5' AND cmd = 'failsafe_off_local'").get().n, 0);

  d.enviar({ tipo: "failsafe_status", ...FAILSAFE, failsafeLatched: true, versao });
  assert.ok(await ate(() => linha("REL-5").ligado === 0), "a recusa da restauração pela placa travada é adotada como desligamento local");
  assert.equal(linha("REL-5").estadoVersao, versao, "adotar o OFF local não avança a versão");
  assert.ok(db.prepare("SELECT 1 FROM comandos_log WHERE sala = 'REL-5' AND cmd = 'failsafe_off_local' AND valor = 'adotado_em_operacao' AND origem = 'esp32_local'").get());
  assert.equal(status("REL-5").dispositivoConfirmou, true, "placa desligada e intenção desligada estão reconciliadas");
  assert.equal(d.estados().length, 1, "nada mais é reenviado");
  await d.fechar();
});

test("um info já recebido no socket é processado antes da sincronização por tempo esgotado, mesmo após uma pausa do event loop", async () => {
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
  assert.equal(d.estados().length, 0, "o info enfileirado vence a sincronização por tempo: nenhum estado é reenviado sobre a trava");
  assert.equal(linha("REL-6").ligado, 0);
  assert.ok(db.prepare("SELECT 1 FROM comandos_log WHERE sala = 'REL-6' AND cmd = 'failsafe_off_local' AND valor = 'mantido_na_reconexao'").get());
  await d.fechar();
});

test("trava reportada em operação: adotada quando reflete a intenção vigente, ignorada quando é anterior a um comando explícito", async () => {
  sala("REL-7", "AA:BB:CC:E1:00:07", true);
  const d = await conectar("REL-7", "AA:BB:CC:E1:00:07");
  d.enviar({ tipo: "info", fw: "4.3.0", ...FAILSAFE, failsafeLatched: false });
  assert.ok(await ate(() => d.estados().length === 1));
  const v1 = d.estados()[0].versao;
  d.enviar({ tipo: "telemetria", fw: "4.3.0", modo: "operation", ligado: true, versao: v1, ...FAILSAFE, failsafeLatched: false });
  assert.ok(await ate(() => status("REL-7").dispositivoConfirmou === true));

  d.enviar({ tipo: "telemetria", fw: "4.3.0", modo: "operation", ligado: false, versao: v1, ...FAILSAFE, failsafeLatched: true });
  assert.ok(await ate(() => linha("REL-7").ligado === 0), "o switch físico desligou a sala depois do último comando: o servidor adota");
  assert.equal(status("REL-7").dispositivoConfirmou, true);

  salasService.aplicarComando("REL-7", "ligar", undefined, ADMIN);
  assert.ok(await ate(() => d.estados().length === 2));
  const v2 = d.estados()[1].versao;
  assert.ok(v2 > v1);
  d.enviar({ tipo: "telemetria", fw: "4.3.0", modo: "operation", ligado: false, versao: v1, ...FAILSAFE, failsafeLatched: true });
  await esperar(100);
  assert.equal(linha("REL-7").ligado, 1, "um relato anterior ao comando não apaga a intenção nova");
  assert.equal(status("REL-7").dispositivoConfirmou, false);
  d.enviar({ tipo: "telemetria", fw: "4.3.0", modo: "operation", ligado: true, versao: v2, ...FAILSAFE, failsafeLatched: false });
  assert.ok(await ate(() => status("REL-7").dispositivoConfirmou === true));
  assert.equal(linha("REL-7").ligado, 1);
  await d.fechar();
});

test("firmware 4.2.0: a trava em operação só é adotada depois que a conexão confirmou a intenção vigente", async () => {
  sala("REL-8", "AA:BB:CC:E1:00:08", true);
  const d = await conectar("REL-8", "AA:BB:CC:E1:00:08");
  d.enviar({ tipo: "info", fw: "4.2.0", ...FAILSAFE, failsafeLatched: false });
  assert.ok(await ate(() => d.estados().length === 1));
  d.enviar({ tipo: "telemetria", fw: "4.2.0", modo: "operation", ligado: false, ...FAILSAFE, failsafeLatched: true, ultimoComando: { tipo: "failsafe" } });
  await esperar(100);
  assert.equal(linha("REL-8").ligado, 1, "sem prova de que a placa já processou a intenção, a trava pode ser anterior a ela");

  d.enviar({ tipo: "telemetria", fw: "4.2.0", modo: "operation", ligado: true, ...FAILSAFE, failsafeLatched: false, ultimoComando: { tipo: "known_state", protocol: 16, temp: 23, power: true, turbo: false } });
  assert.ok(await ate(() => status("REL-8").dispositivoConfirmou === true));
  d.enviar({ tipo: "telemetria", fw: "4.2.0", modo: "operation", ligado: false, ...FAILSAFE, failsafeLatched: true, ultimoComando: { tipo: "failsafe" } });
  assert.ok(await ate(() => linha("REL-8").ligado === 0), "depois da confirmação, a ordem das mensagens prova que a trava é posterior");
  await d.fechar();
});

test("a trava adotada na reconexão é registrada uma única vez e nunca reenvia o estado ligado", async () => {
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

test("cada mudança de intenção avança a versão do estado e a reenvia com o comando", () => {
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
  assert.equal(linha("REL-10").estadoVersao, v0 + 7, "uma configuração global que muda o estado IR avança a versão");
  assert.equal(salasService.comandoEstadoIR(salasService.buscar("REL-10")).versao, v0 + 7);
  salasService.reenviarEstadoIRParaTodas();
  assert.equal(linha("REL-10").estadoVersao, v0 + 7, "reenviar o mesmo estado não é uma intenção nova");
  configuracoes.validarEAtualizar({ modoManutencao: false }, ADMIN.usuario);
  assert.equal(linha("REL-10").estadoVersao, v0 + 7, "uma configuração que não toca o estado IR não avança a versão");
  assert.deepEqual(configuracoes.limitesTemperatura(), limitesAntes);
  salasService.adotarDesligamentoLocal("REL-10");
  assert.equal(linha("REL-10").estadoVersao, v0 + 7, "adotar o OFF local não é uma intenção nova");
});

test("um comando explícito enviado antes do info inicial atrasado não é apagado pela trava antiga, e a placa o confirma", async () => {
  sala("REL-12", "AA:BB:CC:E1:00:12", false);
  const d = await conectar("REL-12", "AA:BB:CC:E1:00:12");
  const resultado = salasService.aplicarComando("REL-12", "ligar", undefined, ADMIN);
  assert.equal(resultado.enviadoAoDispositivo, true);
  assert.ok(await ate(() => d.estados().length === 1));
  const v = d.estados()[0].versao;
  assert.equal(d.estados()[0].restauracao, undefined);

  d.enviar({ tipo: "info", fw: "4.3.0", ...FAILSAFE, failsafeLatched: true, ligado: false, versao: v - 1 });
  await esperar(150);
  assert.equal(linha("REL-12").ligado, 1, "o info descreve a placa de antes do comando: a trava antiga não apaga a intenção nova");
  assert.equal(d.estados().length, 1, "nada é restaurado por cima do comando explícito já enviado");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM comandos_log WHERE sala = 'REL-12' AND cmd = 'failsafe_off_local'").get().n, 0);
  assert.equal(status("REL-12").dispositivoConfirmou, false);

  d.enviar({ tipo: "telemetria", fw: "4.3.0", modo: "operation", ligado: true, versao: v, ...FAILSAFE, failsafeLatched: false });
  assert.ok(await ate(() => status("REL-12").dispositivoConfirmou === true));
  assert.equal(linha("REL-12").ligado, 1);

  d.enviar({ tipo: "telemetria", fw: "4.3.0", modo: "operation", ligado: false, versao: v, ...FAILSAFE, failsafeLatched: true });
  assert.ok(await ate(() => linha("REL-12").ligado === 0), "uma trava posterior ao comando continua sendo adotada");
  await d.fechar();

  sala("REL-13", "AA:BB:CC:E1:00:13", false);
  const e = await conectar("REL-13", "AA:BB:CC:E1:00:13");
  salasService.aplicarComando("REL-13", "ligar", undefined, ADMIN);
  assert.ok(await ate(() => e.estados().length === 1));
  e.enviar({ tipo: "info", fw: "4.2.0", ...FAILSAFE, failsafeLatched: true, ligado: false });
  await esperar(150);
  assert.equal(linha("REL-13").ligado, 1, "sem eco de versão o info atrasado também não adota a trava anterior ao comando");
  await esperar(3200);
  assert.equal(e.estados().length, 1, "a sincronização por tempo esgotado não reenvia o estado já enviado");
  await e.fechar();
});

test("um teste IR administrativo invalida a confirmação até uma intenção mais nova ser enviada", async (t) => {
  sala("REL-14", "AA:BB:CC:E1:00:14", true);
  const d = await conectar("REL-14", "AA:BB:CC:E1:00:14");
  d.enviar({ tipo: "info", fw: "4.3.0", ...FAILSAFE, failsafeLatched: false });
  assert.ok(await ate(() => d.estados().length === 1));
  const v = d.estados()[0].versao;
  d.enviar({ tipo: "telemetria", fw: "4.3.0", modo: "operation", ligado: true, versao: v, ...FAILSAFE, failsafeLatched: false });
  assert.ok(await ate(() => status("REL-14").dispositivoConfirmou === true));

  const mudancas = ouvirMudancasDeSala(t, "REL-14");
  assert.equal(deviceHub.enviarTesteIR("REL-14", { tipo: "send_known_state", protocol: 16, temp: 30, power: false, turbo: false, fan: "", swing: false }), true);
  assert.equal(status("REL-14").dispositivoConfirmou, false, "o aparelho foi posto num estado que não é a intenção");
  assert.equal(linha("REL-14").ligado, 1, "o teste não muda a intenção nem a versão");
  assert.equal(linha("REL-14").estadoVersao, v);
  assert.equal(mudancas.valor, 1, "o painel é avisado da perda de confirmação");
  assert.ok(await ate(() => d.estados().length === 2));
  assert.equal(d.estados()[1].versao, undefined, "o teste sai sem versão");

  d.enviar({ tipo: "telemetria", fw: "4.3.0", modo: "operation", ligado: false, versao: v, ...FAILSAFE, failsafeLatched: false, ultimoComando: { tipo: "known_state", protocol: 16, temp: 30, power: false, turbo: false } });
  await esperar(150);
  assert.equal(status("REL-14").dispositivoConfirmou, false, "o eco da versão anterior ao teste não volta a confirmar");
  assert.equal(linha("REL-14").ligado, 1);

  salasService.aplicarComando("REL-14", "ligar", undefined, ADMIN);
  assert.ok(await ate(() => d.estados().length === 3));
  const v2 = d.estados()[2].versao;
  assert.ok(v2 > v);
  d.enviar({ tipo: "telemetria", fw: "4.3.0", modo: "operation", ligado: true, versao: v2, ...FAILSAFE, failsafeLatched: false });
  assert.ok(await ate(() => status("REL-14").dispositivoConfirmou === true), "a intenção nova volta a ser confirmável");

  assert.equal(deviceHub.enviarTesteIR("REL-14", { tipo: "send_raw", raw: [9000, 4500, 560, 560], carrierHz: 38000 }), true);
  assert.equal(status("REL-14").dispositivoConfirmou, false, "um RAW também tira a placa do estado desejado");
  d.enviar({ tipo: "telemetria", fw: "4.3.0", modo: "operation", ligado: false, versao: v2, ...FAILSAFE, failsafeLatched: true });
  assert.ok(await ate(() => linha("REL-14").ligado === 0), "a trava depois do teste ainda é adotada: o eco prova que ela é posterior à intenção");
  assert.equal(status("REL-14").dispositivoConfirmou, true, "placa e intenção desligadas estão reconciliadas");
  await d.fechar();
});

test("uma falha ao gravar limites globais não deixa intenção nem versão pela metade e não envia nada à placa", (t) => {
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
  assert.deepEqual(configuracoes.limitesTemperatura(), antesCfg, "a configuração não foi gravada");
  assert.deepEqual(linha("REL-15"), antes, "o alvo não foi ajustado sem a versão avançar junto");
  assert.equal(enviados.length, 0, "nada é submetido à placa sem commit");

  db.prepare.mock.restore();
  configuracoes.validarEAtualizar({ temperaturaMinima: 20, temperaturaMaxima: 28 }, ADMIN.usuario);
  const depois = linha("REL-15");
  assert.equal(depois.temperaturaAlvo, 20, "o alvo é ajustado ao novo limite");
  assert.equal(depois.estadoVersao, antes.estadoVersao + 1);
  assert.equal(enviados.find((e) => e.sala === "REL-15").payload.versao, depois.estadoVersao, "o reenvio sai com a versão gravada");
  configuracoes.validarEAtualizar({ temperaturaMinima: antesCfg.minima, temperaturaMaxima: antesCfg.maxima }, ADMIN.usuario);

  t.mock.method(db, "prepare", (sql, ...resto) => {
    if (/UPDATE agendamentos SET temperatura = MAX/.test(sql)) return { run: () => { throw new Error("SQLITE_FULL simulado"); } };
    return preparar(sql, ...resto);
  });
  const antesSala = linha("REL-15");
  enviados.length = 0;
  assert.throws(() => salasService.definirLimitesTemperatura("REL-15", { minima: 22, maxima: 26 }), /SQLITE_FULL/);
  assert.deepEqual(linha("REL-15"), antesSala, "limites por sala: a sala não muda se a segunda escrita falha");
  assert.equal(enviados.length, 0);
});

test("o agendador não repete um comando cujo registro de execução falhou: estado e registro persistem juntos", (t) => {
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
  assert.equal(linha(codigo).ligado, 0, "com o registro falhando, a sala não muda de estado");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM comandos_log WHERE sala = ?").get(codigo).n, 0);
  assert.equal(agendamentos.jaExecutadoHoje(ag.id, "ligar", dataAtualBrasiliaISO()), false);

  t.mock.timers.tick(60000);
  assert.equal(linha(codigo).ligado, 1, "no tick seguinte o agendamento é aplicado uma única vez");
  assert.equal(agendamentos.jaExecutadoHoje(ag.id, "ligar", dataAtualBrasiliaISO()), true);
  assert.deepEqual(db.prepare("SELECT cmd FROM comandos_log WHERE sala = ? ORDER BY id").all(codigo).map((l) => l.cmd), ["ligar", "temperatura"]);

  salasService.aplicarComando(codigo, "desligar", undefined, ADMIN);
  t.mock.timers.tick(60000);
  assert.equal(linha(codigo).ligado, 0, "o desligamento manual não é sobrescrito por uma repetição do agendamento");
});

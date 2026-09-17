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
const agendamentos = require("../src/services/agendamentosService");
const monitoramentoService = require("../src/services/monitoramentoService");
const scheduler = require("../src/scheduler/schedulerService");
const { dataAtualBrasiliaISO } = require("../src/utils/tempo");

const ADMIN = { usuario: { id: 1, usuario: "superadmin", isAdmin: true, podeControlar: true, nivel: 3 }, origem: "manual" };
// 2026-09-06 19:59 em Brasília; o agendamento liga às 20:00 e deveria desligar às 23:30.
const VESPERA_1959 = new Date("2026-09-06T22:59:00Z");
const DIA_SEGUINTE_0010 = new Date("2026-09-07T03:10:00Z");

let server;
let wsUrl;
const abertos = new Set();

function sala(codigo, mac = null) {
  db.prepare("INSERT INTO salas (sala, nome, bloco, andar, mac, temperaturaAlvo, irProtocolo) VALUES (?, ?, 'A', 1, ?, 23, 16)").run(codigo, codigo, mac);
}

function linha(codigo) {
  return db.prepare("SELECT ligado, temperaturaAlvo, estadoVersao FROM salas WHERE sala = ?").get(codigo);
}

function logs(codigo) {
  return db.prepare("SELECT cmd, origem FROM comandos_log WHERE sala = ? ORDER BY id").all(codigo).map((l) => `${l.cmd}:${l.origem}`);
}

function superadmin() {
  return db.prepare("SELECT * FROM usuarios WHERE nivel = 3").get();
}

// O relógio do SQLite (datetime('now')) não é simulado pelos mock timers: os registros do dia
// anterior recebem explicitamente o instante em que teriam sido gravados.
function datarRegistrosDaVespera(codigo, instanteUtc = "2026-09-06 23:00:00") {
  db.prepare("UPDATE comandos_log SET criadoEm = ? WHERE sala = ?").run(instanteUtc, codigo);
  db.prepare("UPDATE agendamentos_execucoes SET executadoEm = ? WHERE agendamentoId IN (SELECT id FROM agendamentos WHERE sala = ?)").run(instanteUtc, codigo);
}

// Liga pelo agendador às 20:00 da véspera e para o servidor antes das 23:30 (queda), voltando à
// hora indicada do dia seguinte com a passagem inicial do agendador.
function simularQuedaAntesDoDesligar(t, codigo, criar, { retorno = DIA_SEGUINTE_0010 } = {}) {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: VESPERA_1959 });
  t.after(() => scheduler.pararScheduler());
  const ag = criar();
  scheduler.iniciarScheduler();
  t.mock.timers.tick(60000);
  assert.equal(linha(codigo).ligado, 1, "o agendamento liga às 20:00");
  assert.equal(agendamentos.jaExecutadoHoje(ag.id, "ligar", "2026-09-06"), true);
  datarRegistrosDaVespera(codigo);
  scheduler.pararScheduler();
  t.mock.timers.setTime(retorno.getTime());
  assert.equal(dataAtualBrasiliaISO(), "2026-09-07");
  return ag;
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
  scheduler.pararScheduler();
  deviceHub.encerrar();
  statusHub.encerrar();
  await new Promise((r) => server.close(r));
});

test("o OFF agendado que ficou pendente na queda é aplicado uma única vez ao voltar no dia seguinte", (t) => {
  sala("VD-1");
  const ag = simularQuedaAntesDoDesligar(t, "VD-1", () => agendamentos.criar({ sala: "VD-1", usuarioId: superadmin().id, data: dataAtualBrasiliaISO(), temperatura: 24, horaInicio: "20:00", horaFim: "23:30" }));
  const versaoAntes = linha("VD-1").estadoVersao;
  const naoEntreguesAntes = monitoramentoService.coletar().falhas.contadores.comandoNaoEntregue;

  scheduler.iniciarScheduler();
  assert.equal(linha("VD-1").ligado, 0, "a passagem inicial do agendador aplica o desligamento pendente");
  assert.equal(linha("VD-1").estadoVersao, versaoAntes + 1, "é uma intenção nova, com versão própria");
  assert.equal(agendamentos.jaExecutadoHoje(ag.id, "desligar", "2026-09-06"), true, "a execução fica registrada na data do agendamento");
  assert.deepEqual(logs("VD-1"), ["ligar:agendamento", "temperatura:agendamento", "desligar:agendamento"]);
  assert.equal(monitoramentoService.coletar().falhas.contadores.comandoNaoEntregue, naoEntreguesAntes, "sem placa conectada, a passagem inicial só persiste a intenção");

  t.mock.timers.tick(60000);
  t.mock.timers.tick(60000);
  assert.deepEqual(logs("VD-1"), ["ligar:agendamento", "temperatura:agendamento", "desligar:agendamento"], "os ticks seguintes não repetem o desligamento");
  assert.equal(agendamentos.listarDesligamentosPendentesDeOntem().length, 0);
});

test("a recuperação respeita uma intenção mais nova após a hora devida, mas não um ajuste feito dentro do período", (t) => {
  sala("VD-2");
  sala("VD-3");
  const usuarioId = superadmin().id;
  const agB = simularQuedaAntesDoDesligar(t, "VD-2", () => {
    agendamentos.criar({ sala: "VD-3", usuarioId, data: dataAtualBrasiliaISO(), temperatura: 24, horaInicio: "20:00", horaFim: "23:30" });
    return agendamentos.criar({ sala: "VD-2", usuarioId, data: dataAtualBrasiliaISO(), temperatura: 24, horaInicio: "20:00", horaFim: "22:00", modo: "ligar_intervalo", ligarInicio: "20:00", ligarFim: "21:30" });
  });
  datarRegistrosDaVespera("VD-3");
  // VD-2: ajuste manual às 21:00 (dentro do intervalo, antes das 21:30 devidas) não conta como intenção nova.
  salasService.aplicarComando("VD-2", "temperatura", 25, ADMIN);
  db.prepare("UPDATE comandos_log SET criadoEm = '2026-09-07 00:00:00' WHERE sala = 'VD-2' AND origem = 'manual'").run();
  // VD-3: alguém ligou manualmente às 23:45, depois da hora em que o OFF era devido.
  salasService.aplicarComando("VD-3", "ligar", undefined, ADMIN);
  db.prepare("UPDATE comandos_log SET criadoEm = '2026-09-07 02:45:00' WHERE sala = 'VD-3' AND origem = 'manual'").run();

  scheduler.iniciarScheduler();
  assert.equal(linha("VD-2").ligado, 0, "o intervalo ligar_intervalo é recuperado pela hora ligarFim");
  assert.equal(agendamentos.jaExecutadoHoje(agB.id, "desligar", "2026-09-06"), true);
  assert.equal(linha("VD-3").ligado, 1, "a intenção manual posterior à hora devida prevalece");
  assert.deepEqual(logs("VD-3"), ["ligar:agendamento", "temperatura:agendamento", "ligar:manual"]);
  t.mock.timers.tick(60000);
  assert.equal(linha("VD-3").ligado, 1);
});

test("cancelamento e execução já registrada são respeitados; um agendamento que nunca ligou não é tocado", (t) => {
  sala("VD-4");
  sala("VD-5");
  sala("VD-6");
  const usuarioId = superadmin().id;
  const agDesativado = simularQuedaAntesDoDesligar(t, "VD-4", () => {
    agendamentos.criar({ sala: "VD-5", usuarioId, data: dataAtualBrasiliaISO(), temperatura: 24, horaInicio: "20:00", horaFim: "23:30" });
    agendamentos.criar({ sala: "VD-6", usuarioId, data: dataAtualBrasiliaISO(), temperatura: 24, horaInicio: "22:00", horaFim: "23:30" });
    return agendamentos.criar({ sala: "VD-4", usuarioId, data: dataAtualBrasiliaISO(), temperatura: 24, horaInicio: "20:00", horaFim: "23:30" });
  });
  datarRegistrosDaVespera("VD-5");
  agendamentos.alternar(agDesativado.id, false, { id: usuarioId, isAdmin: true });
  const agConcluido = db.prepare("SELECT id FROM agendamentos WHERE sala = 'VD-5'").get();
  agendamentos.registrarExecucao(agConcluido.id, "desligar", "2026-09-06");
  db.prepare("UPDATE salas SET ligado = 1 WHERE sala IN ('VD-5', 'VD-6')").run();
  assert.equal(linha("VD-6").ligado, 1, "VD-6 nunca ligou pelo agendador (o servidor caiu antes das 22:00)");

  scheduler.iniciarScheduler();
  assert.equal(linha("VD-4").ligado, 1, "um agendamento desativado não executa mais nada, como no mesmo dia");
  assert.equal(linha("VD-5").ligado, 1, "um desligamento já registrado não é repetido");
  assert.equal(linha("VD-6").ligado, 1, "sem ligar executado não há desligamento pendente");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM comandos_log WHERE cmd = 'desligar' AND sala IN ('VD-4', 'VD-5', 'VD-6')").get().n, 0);
});

test("ao reconectar depois da volta, a placa recebe o OFF recuperado, não o ligado expirado do agendamento", async (t) => {
  sala("VD-7", "AA:BB:CC:DD:0D:07");
  t.mock.timers.enable({ apis: ["Date"], now: VESPERA_1959 });
  t.after(() => scheduler.pararScheduler());
  const ag = agendamentos.criar({ sala: "VD-7", usuarioId: superadmin().id, data: dataAtualBrasiliaISO(), temperatura: 24, horaInicio: "20:00", horaFim: "23:30" });
  t.mock.timers.setTime(new Date("2026-09-06T23:00:00Z").getTime());
  scheduler.iniciarScheduler();
  assert.equal(linha("VD-7").ligado, 1);
  assert.equal(agendamentos.jaExecutadoHoje(ag.id, "ligar", "2026-09-06"), true);
  datarRegistrosDaVespera("VD-7");
  scheduler.pararScheduler();

  t.mock.timers.setTime(DIA_SEGUINTE_0010.getTime());
  scheduler.iniciarScheduler();
  assert.equal(linha("VD-7").ligado, 0);

  const mensagens = [];
  const ws = new WebSocket(wsUrl, { headers: { "x-device-sala": "VD-7", "x-device-mac": "AA:BB:CC:DD:0D:07" } });
  abertos.add(ws);
  ws.on("message", (d) => mensagens.push(JSON.parse(d.toString())));
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  ws.send(JSON.stringify({ tipo: "info", fw: "4.3.0", failsafeConfigurado: false, failsafeLatched: false, ligado: true }));
  for (let i = 0; i < 300 && !mensagens.some((m) => m.tipo === "send_known_state"); i++) await new Promise((r) => setTimeout(r, 10));
  const estado = mensagens.find((m) => m.tipo === "send_known_state");
  assert.ok(estado, "a reconexão restaura o estado desejado");
  assert.equal(estado.power, false, "o estado restaurado é o desligamento recuperado");
  assert.equal(estado.restauracao, true);
  assert.equal(estado.versao, linha("VD-7").estadoVersao);
  ws.close();
});

process.env.REMOTEIFES_DB_PATH = ":memory:";
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");

require("../src/app");
const db = require("../src/config/database");
const salasService = require("../src/services/salasService");
const agendamentos = require("../src/services/agendamentosService");
const usuariosService = require("../src/services/usuariosService");
const scheduler = require("../src/scheduler/schedulerService");
const { dataAtualBrasiliaISO, horaAtualBrasilia } = require("../src/utils/tempo");

const superadmin = db.prepare("SELECT * FROM usuarios WHERE nivel = 3").get();
const ADMIN = { usuario: { ...superadmin, isAdmin: true, podeControlar: true }, origem: "manual" };
// 2026-09-06 in Brasília (UTC-3): 07:59 local = 10:59Z.
const instante = (hhmm) => new Date(`2026-09-06T${hhmm}:00-03:00`);

function sala(codigo) {
  db.prepare("INSERT INTO salas (sala, nome, bloco, andar, temperaturaAlvo, irProtocolo) VALUES (?, ?, 'A', 1, 23, 16)").run(codigo, codigo);
}

function linha(codigo) {
  return db.prepare("SELECT ligado, estadoVersao FROM salas WHERE sala = ?").get(codigo);
}

function logs(codigo) {
  return db.prepare("SELECT cmd, origem FROM comandos_log WHERE sala = ? ORDER BY id").all(codigo).map((l) => `${l.cmd}:${l.origem}`);
}

function relogio(t, hhmm) {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: instante(hhmm) });
  t.after(() => scheduler.pararScheduler());
  assert.equal(horaAtualBrasilia(), hhmm);
}

function criar(codigo, horaInicio, horaFim, extra = {}) {
  return agendamentos.criar({ sala: codigo, usuarioId: superadmin.id, data: dataAtualBrasiliaISO(), temperatura: 24, horaInicio, horaFim, ...extra });
}

test.after(() => db.close());

test("a schedule created after its own window does not turn off a manually turned-on room", (t) => {
  sala("JE-1");
  relogio(t, "13:59");
  salasService.aplicarComando("JE-1", "ligar", undefined, ADMIN);
  const ag = criar("JE-1", "00:05", "00:10");
  scheduler.iniciarScheduler();
  t.mock.timers.tick(60000);
  t.mock.timers.tick(60000);
  assert.equal(linha("JE-1").ligado, 1, "without having turned on through the scheduler, the schedule has no OFF to run");
  assert.equal(agendamentos.jaExecutadoHoje(ag.id, "ligar", dataAtualBrasiliaISO()), false);
  assert.equal(agendamentos.jaExecutadoHoje(ag.id, "desligar", dataAtualBrasiliaISO()), false);
  assert.deepEqual(logs("JE-1"), ["ligar:manual"]);
});

test("at the exact end time: the schedule that turned on turns off; one created in that minute neither turns on nor off", (t) => {
  sala("JE-2");
  sala("JE-3");
  relogio(t, "08:59");
  const ligou = criar("JE-2", "08:00", "09:00");
  scheduler.iniciarScheduler();
  assert.equal(linha("JE-2").ligado, 1, "created inside the window, turns on at the first pass");
  t.mock.timers.setTime(instante("09:00").getTime());
  salasService.aplicarComando("JE-3", "ligar", undefined, ADMIN);
  const tardio = criar("JE-3", "08:00", "09:00");
  t.mock.timers.tick(60000);
  assert.equal(linha("JE-2").ligado, 0, "the end is exclusive: turns off at the horaFim minute");
  assert.equal(agendamentos.jaExecutadoHoje(ligou.id, "desligar", dataAtualBrasiliaISO()), true);
  assert.equal(linha("JE-3").ligado, 1, "created at the end minute, it never turned on and therefore does not turn off");
  assert.equal(agendamentos.jaExecutadoHoje(tardio.id, "ligar", dataAtualBrasiliaISO()), false);
  assert.equal(agendamentos.jaExecutadoHoje(tardio.id, "desligar", dataAtualBrasiliaISO()), false);
  t.mock.timers.tick(60000);
  assert.deepEqual(logs("JE-2"), ["ligar:agendamento", "temperatura:agendamento", "desligar:agendamento"]);
  assert.deepEqual(logs("JE-3"), ["ligar:manual"]);
});

test("normal cycle: turns on at start, off at end, and nothing repeats", (t) => {
  sala("JE-4");
  relogio(t, "07:58");
  const ag = criar("JE-4", "08:00", "08:02");
  scheduler.iniciarScheduler();
  assert.equal(linha("JE-4").ligado, 0);
  t.mock.timers.tick(60000);
  assert.equal(linha("JE-4").ligado, 0, "07:59 does not turn on yet");
  t.mock.timers.tick(60000);
  assert.equal(linha("JE-4").ligado, 1, "turns on at 08:00");
  t.mock.timers.tick(60000);
  assert.equal(linha("JE-4").ligado, 1, "08:01 stays on");
  t.mock.timers.tick(60000);
  assert.equal(linha("JE-4").ligado, 0, "turns off at 08:02");
  t.mock.timers.tick(60000);
  t.mock.timers.tick(60000);
  assert.deepEqual(logs("JE-4"), ["ligar:agendamento", "temperatura:agendamento", "desligar:agendamento"]);
  assert.equal(agendamentos.jaExecutadoHoje(ag.id, "desligar", dataAtualBrasiliaISO()), true);
});

test("same-day restart: the pending OFF of the schedule that turned on is recovered; a schedule missed entirely during the outage is not touched", (t) => {
  sala("JE-5");
  sala("JE-6");
  relogio(t, "08:00");
  const ligou = criar("JE-5", "08:00", "09:00");
  const perdido = criar("JE-6", "09:30", "10:00");
  scheduler.iniciarScheduler();
  assert.equal(linha("JE-5").ligado, 1);
  scheduler.pararScheduler();
  salasService.aplicarComando("JE-6", "ligar", undefined, ADMIN);
  const versaoAntes = linha("JE-5").estadoVersao;

  t.mock.timers.setTime(instante("10:30").getTime());
  scheduler.iniciarScheduler();
  assert.equal(linha("JE-5").ligado, 0, "the initial pass recovers the shutdown due at 09:00");
  assert.equal(linha("JE-5").estadoVersao, versaoAntes + 1);
  assert.equal(agendamentos.jaExecutadoHoje(ligou.id, "desligar", dataAtualBrasiliaISO()), true);
  assert.equal(linha("JE-6").ligado, 1, "a schedule that never turned on does not turn the room off");
  assert.equal(agendamentos.jaExecutadoHoje(perdido.id, "desligar", dataAtualBrasiliaISO()), false);
  t.mock.timers.tick(60000);
  assert.equal(linha("JE-6").ligado, 1);
  assert.deepEqual(logs("JE-6"), ["ligar:manual"]);
});

test("ligar_intervalo created after the turn-on interval keeps the reservation but neither turns on nor off", (t) => {
  sala("JE-7");
  relogio(t, "15:00");
  salasService.aplicarComando("JE-7", "ligar", undefined, ADMIN);
  const ag = criar("JE-7", "14:00", "16:00", { modo: "ligar_intervalo", ligarInicio: "14:00", ligarFim: "14:30" });
  scheduler.iniciarScheduler();
  t.mock.timers.tick(60000);
  assert.equal(linha("JE-7").ligado, 1);
  assert.deepEqual(logs("JE-7"), ["ligar:manual"]);
  assert.equal(agendamentos.jaExecutadoHoje(ag.id, "desligar", dataAtualBrasiliaISO()), false);
  const bloqueio = salasService.bloqueioAtivo("JE-7");
  assert.equal(bloqueio && bloqueio.agendamentoId, ag.id, "the reservation stays valid until horaFim");
});

test("ligar_intervalo created inside the turn-on interval turns on immediately and off at ligarFim, not at horaFim", (t) => {
  sala("JE-8");
  relogio(t, "14:10");
  const ag = criar("JE-8", "14:00", "16:00", { modo: "ligar_intervalo", ligarInicio: "14:00", ligarFim: "14:12" });
  scheduler.iniciarScheduler();
  assert.equal(linha("JE-8").ligado, 1);
  t.mock.timers.tick(60000);
  assert.equal(linha("JE-8").ligado, 1);
  t.mock.timers.tick(60000);
  assert.equal(linha("JE-8").ligado, 0, "turns off at 14:12");
  assert.equal(agendamentos.jaExecutadoHoje(ag.id, "desligar", dataAtualBrasiliaISO()), true);
  assert.ok(salasService.bloqueioAtivo("JE-8"), "the reservation continues until 16:00");
});

test("adjacent reservations of different users: at the exact end minute the room already belongs to the next one", (t) => {
  sala("JE-9");
  relogio(t, "08:30");
  const outro = usuariosService.criar({ usuario: "je-adjacente", senha: "senhaSegura123", nome: "Adjacente", podeControlar: true }, { nivel: 3 });
  const primeira = criar("JE-9", "08:00", "09:00", { modo: "reserva" });
  const segunda = agendamentos.criar({ sala: "JE-9", usuarioId: outro.id, data: dataAtualBrasiliaISO(), temperatura: 24, horaInicio: "09:00", horaFim: "10:00", modo: "reserva" });

  assert.equal(salasService.bloqueioAtivo("JE-9").agendamentoId, primeira.id);
  t.mock.timers.setTime(instante("08:59").getTime());
  assert.equal(salasService.bloqueioAtivo("JE-9").agendamentoId, primeira.id);
  assert.equal(agendamentos.salasComAgendamentoAtivo()["JE-9"].agendamentoId, primeira.id);

  t.mock.timers.setTime(instante("09:00").getTime());
  assert.equal(salasService.bloqueioAtivo("JE-9").agendamentoId, segunda.id, "[start, end): at 09:00 the first reservation has already ended");
  assert.equal(salasService.bloqueioAtivo("JE-9").usuarioId, outro.id);
  assert.equal(agendamentos.salasComAgendamentoAtivo()["JE-9"].agendamentoId, segunda.id);
  assert.throws(() => salasService.aplicarComando("JE-9", "ligar", undefined, { usuario: { ...superadmin, isAdmin: false, podeControlar: true }, origem: "manual" }), /reservada por agendamento de Adjacente até 10:00/);

  t.mock.timers.setTime(instante("10:00").getTime());
  assert.equal(salasService.bloqueioAtivo("JE-9"), null, "without a following reservation, the room is released at horaFim");
  assert.equal(agendamentos.salasComAgendamentoAtivo()["JE-9"], undefined);
});

test("removing or disabling a running schedule releases the reservation and cancels the OFF without turning off the air conditioner", (t) => {
  sala("JE-10");
  sala("JE-11");
  relogio(t, "08:00");
  const removido = criar("JE-10", "08:00", "09:00");
  const desativado = criar("JE-11", "08:00", "09:00");
  scheduler.iniciarScheduler();
  assert.equal(linha("JE-10").ligado, 1);
  assert.equal(linha("JE-11").ligado, 1);

  t.mock.timers.setTime(instante("08:30").getTime());
  agendamentos.remover(removido.id, { id: superadmin.id, isAdmin: true });
  agendamentos.alternar(desativado.id, false, { id: superadmin.id, isAdmin: true });
  assert.equal(salasService.bloqueioAtivo("JE-10"), null);
  assert.equal(salasService.bloqueioAtivo("JE-11"), null);
  assert.equal(linha("JE-10").ligado, 1);
  assert.equal(linha("JE-11").ligado, 1);

  t.mock.timers.setTime(instante("09:00").getTime());
  t.mock.timers.tick(60000);
  t.mock.timers.tick(60000);
  assert.equal(linha("JE-10").ligado, 1, "a removed schedule no longer turns anything off");
  assert.equal(linha("JE-11").ligado, 1, "a disabled schedule no longer turns anything off");
  assert.deepEqual(logs("JE-10"), ["ligar:agendamento", "temperatura:agendamento"]);
  assert.deepEqual(logs("JE-11"), ["ligar:agendamento", "temperatura:agendamento"]);
});

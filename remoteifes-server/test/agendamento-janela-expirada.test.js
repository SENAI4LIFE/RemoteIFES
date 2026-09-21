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
// 2026-09-06 em Brasília (UTC-3): 07:59 local = 10:59Z.
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

test("agendamento criado depois da própria janela não desliga uma sala ligada manualmente", (t) => {
  sala("JE-1");
  relogio(t, "13:59");
  salasService.aplicarComando("JE-1", "ligar", undefined, ADMIN);
  const ag = criar("JE-1", "00:05", "00:10");
  scheduler.iniciarScheduler();
  t.mock.timers.tick(60000);
  t.mock.timers.tick(60000);
  assert.equal(linha("JE-1").ligado, 1, "sem ter ligado pelo agendador, o agendamento não tem OFF a executar");
  assert.equal(agendamentos.jaExecutadoHoje(ag.id, "ligar", dataAtualBrasiliaISO()), false);
  assert.equal(agendamentos.jaExecutadoHoje(ag.id, "desligar", dataAtualBrasiliaISO()), false);
  assert.deepEqual(logs("JE-1"), ["ligar:manual"]);
});

test("na hora exata do fim: quem ligou desliga; quem foi criado nesse minuto não liga nem desliga", (t) => {
  sala("JE-2");
  sala("JE-3");
  relogio(t, "08:59");
  const ligou = criar("JE-2", "08:00", "09:00");
  scheduler.iniciarScheduler();
  assert.equal(linha("JE-2").ligado, 1, "criado dentro da janela, liga na primeira passagem");
  t.mock.timers.setTime(instante("09:00").getTime());
  salasService.aplicarComando("JE-3", "ligar", undefined, ADMIN);
  const tardio = criar("JE-3", "08:00", "09:00");
  t.mock.timers.tick(60000);
  assert.equal(linha("JE-2").ligado, 0, "o fim é exclusivo: desliga no minuto de horaFim");
  assert.equal(agendamentos.jaExecutadoHoje(ligou.id, "desligar", dataAtualBrasiliaISO()), true);
  assert.equal(linha("JE-3").ligado, 1, "criado no minuto do fim, nunca ligou e por isso não desliga");
  assert.equal(agendamentos.jaExecutadoHoje(tardio.id, "ligar", dataAtualBrasiliaISO()), false);
  assert.equal(agendamentos.jaExecutadoHoje(tardio.id, "desligar", dataAtualBrasiliaISO()), false);
  t.mock.timers.tick(60000);
  assert.deepEqual(logs("JE-2"), ["ligar:agendamento", "temperatura:agendamento", "desligar:agendamento"]);
  assert.deepEqual(logs("JE-3"), ["ligar:manual"]);
});

test("ciclo normal: liga no início, desliga no fim e nada se repete", (t) => {
  sala("JE-4");
  relogio(t, "07:58");
  const ag = criar("JE-4", "08:00", "08:02");
  scheduler.iniciarScheduler();
  assert.equal(linha("JE-4").ligado, 0);
  t.mock.timers.tick(60000);
  assert.equal(linha("JE-4").ligado, 0, "07:59 ainda não liga");
  t.mock.timers.tick(60000);
  assert.equal(linha("JE-4").ligado, 1, "liga às 08:00");
  t.mock.timers.tick(60000);
  assert.equal(linha("JE-4").ligado, 1, "08:01 continua ligado");
  t.mock.timers.tick(60000);
  assert.equal(linha("JE-4").ligado, 0, "desliga às 08:02");
  t.mock.timers.tick(60000);
  t.mock.timers.tick(60000);
  assert.deepEqual(logs("JE-4"), ["ligar:agendamento", "temperatura:agendamento", "desligar:agendamento"]);
  assert.equal(agendamentos.jaExecutadoHoje(ag.id, "desligar", dataAtualBrasiliaISO()), true);
});

test("reinício no mesmo dia: o OFF pendente de quem ligou é recuperado; um agendamento perdido inteiro na queda não é tocado", (t) => {
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
  assert.equal(linha("JE-5").ligado, 0, "a passagem inicial recupera o desligamento devido às 09:00");
  assert.equal(linha("JE-5").estadoVersao, versaoAntes + 1);
  assert.equal(agendamentos.jaExecutadoHoje(ligou.id, "desligar", dataAtualBrasiliaISO()), true);
  assert.equal(linha("JE-6").ligado, 1, "o agendamento que nunca ligou não desliga a sala");
  assert.equal(agendamentos.jaExecutadoHoje(perdido.id, "desligar", dataAtualBrasiliaISO()), false);
  t.mock.timers.tick(60000);
  assert.equal(linha("JE-6").ligado, 1);
  assert.deepEqual(logs("JE-6"), ["ligar:manual"]);
});

test("ligar_intervalo criado depois do intervalo de ligar mantém a reserva, mas não liga nem desliga", (t) => {
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
  assert.equal(bloqueio && bloqueio.agendamentoId, ag.id, "a reserva continua valendo até horaFim");
});

test("ligar_intervalo criado dentro do intervalo de ligar liga na hora e desliga em ligarFim, não em horaFim", (t) => {
  sala("JE-8");
  relogio(t, "14:10");
  const ag = criar("JE-8", "14:00", "16:00", { modo: "ligar_intervalo", ligarInicio: "14:00", ligarFim: "14:12" });
  scheduler.iniciarScheduler();
  assert.equal(linha("JE-8").ligado, 1);
  t.mock.timers.tick(60000);
  assert.equal(linha("JE-8").ligado, 1);
  t.mock.timers.tick(60000);
  assert.equal(linha("JE-8").ligado, 0, "desliga às 14:12");
  assert.equal(agendamentos.jaExecutadoHoje(ag.id, "desligar", dataAtualBrasiliaISO()), true);
  assert.ok(salasService.bloqueioAtivo("JE-8"), "a reserva segue até 16:00");
});

test("reservas adjacentes de usuários diferentes: no minuto exato do fim a sala já pertence à próxima", (t) => {
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
  assert.equal(salasService.bloqueioAtivo("JE-9").agendamentoId, segunda.id, "[inicio, fim): às 09:00 a primeira reserva já terminou");
  assert.equal(salasService.bloqueioAtivo("JE-9").usuarioId, outro.id);
  assert.equal(agendamentos.salasComAgendamentoAtivo()["JE-9"].agendamentoId, segunda.id);
  assert.throws(() => salasService.aplicarComando("JE-9", "ligar", undefined, { usuario: { ...superadmin, isAdmin: false, podeControlar: true }, origem: "manual" }), /reservada por agendamento de Adjacente até 10:00/);

  t.mock.timers.setTime(instante("10:00").getTime());
  assert.equal(salasService.bloqueioAtivo("JE-9"), null, "sem reserva seguinte, a sala é liberada em horaFim");
  assert.equal(agendamentos.salasComAgendamentoAtivo()["JE-9"], undefined);
});

test("remover ou desativar um agendamento em curso libera a reserva e cancela o OFF, sem desligar o ar-condicionado", (t) => {
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
  assert.equal(linha("JE-10").ligado, 1, "o agendamento removido não desliga mais nada");
  assert.equal(linha("JE-11").ligado, 1, "o agendamento desativado não desliga mais nada");
  assert.deepEqual(logs("JE-10"), ["ligar:agendamento", "temperatura:agendamento"]);
  assert.deepEqual(logs("JE-11"), ["ligar:agendamento", "temperatura:agendamento"]);
});

process.env.NODE_ENV = "test";
process.env.REMOTEIFES_DB_PATH = ":memory:";

const test = require("node:test");
const assert = require("node:assert/strict");
require("../src/app");
const db = require("../src/config/database");
const agendamentos = require("../src/services/agendamentosService");
const salas = require("../src/services/salasService");
const { dataAtualBrasiliaISO } = require("../src/utils/tempo");
const usuario = db.prepare("SELECT * FROM usuarios WHERE nivel = 3").get();

test("reativacao recusa conflito sem alterar o agendamento desativado", () => {
  const dados = { sala: "A-108", usuarioId: usuario.id, data: dataAtualBrasiliaISO(), horaInicio: "08:00", horaFim: "09:00", temperatura: 24 };
  const anterior = agendamentos.criar(dados);
  agendamentos.alternar(anterior.id, false, usuario);
  const atual = agendamentos.criar(dados);
  assert.throws(() => agendamentos.alternar(anterior.id, true, usuario), /conflito/);
  assert.equal(agendamentos.buscarPorId(anterior.id).ativo, 0);
  assert.equal(agendamentos.buscarPorId(atual.id).ativo, 1);
  agendamentos.alternar(atual.id, false, usuario);
  assert.equal(agendamentos.alternar(anterior.id, true, usuario).ativo, 1);
  assert.equal(agendamentos.alternar(anterior.id, true, usuario).ativo, 1);
});

test("mapa de reservas preserva bloqueios e usa uma consulta para todas as salas", (t) => {
  const inserir = db.prepare("INSERT INTO agendamentos (sala, usuarioId, data, horaInicio, horaFim, temperatura, ativo) VALUES (?, ?, ?, '00:00', '23:59', 24, ?)");
  inserir.run("A-103a", usuario.id, dataAtualBrasiliaISO(), 1);
  inserir.run("A-108", usuario.id, "2000-01-01", 1);
  inserir.run("A-103a", usuario.id, dataAtualBrasiliaISO(), 0);
  const esperado = {};
  for (const sala of salas.listar()) {
    const bloqueio = salas.bloqueioAtivo(sala.sala);
    if (bloqueio) esperado[sala.sala] = bloqueio;
  }
  const preparar = db.prepare.bind(db);
  let consultas = 0;
  t.mock.method(db, "prepare", (...args) => {
    consultas += 1;
    return preparar(...args);
  });
  assert.deepEqual(agendamentos.salasComAgendamentoAtivo(), esperado);
  assert.equal(consultas, 1);
});

test("reservas consecutivas criadas fora de ordem terminam com o estado da reserva atual", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: new Date("2026-09-06T11:59:00Z") });
  const scheduler = require("../src/scheduler/schedulerService");
  t.after(() => scheduler.pararScheduler());
  const sala = "audit-agenda-ordem";
  db.prepare("INSERT INTO salas (sala, nome, bloco, andar) VALUES (?, ?, 'A', 1)").run(sala, sala);
  const dados = { sala, usuarioId: usuario.id, data: dataAtualBrasiliaISO(), temperatura: 24 };
  const atual = agendamentos.criar({ ...dados, horaInicio: "09:00", horaFim: "10:00" });
  const anterior = agendamentos.criar({ ...dados, horaInicio: "08:00", horaFim: "09:00" });
  scheduler.iniciarScheduler();
  t.mock.timers.tick(60000);
  assert.equal(salas.buscar(sala).ligado, 1);
  assert.equal(agendamentos.jaExecutadoHoje(anterior.id, "desligar", dados.data), true);
  assert.equal(agendamentos.jaExecutadoHoje(atual.id, "ligar", dados.data), true);
  const logs = db.prepare("SELECT COUNT(*) n FROM comandos_log WHERE sala = ?").get(sala).n;
  t.mock.timers.tick(60000);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM comandos_log WHERE sala = ?").get(sala).n, logs);
});

test.after(() => db.close());

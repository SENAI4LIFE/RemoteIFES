process.env.NODE_ENV = "test";
process.env.REMOTEIFES_DB_PATH = ":memory:";

const test = require("node:test");
const assert = require("node:assert/strict");
require("../src/app");
const db = require("../src/config/database");
const salas = require("../src/services/salasService");
const deviceHub = require("../src/services/deviceHub");

const contexto = { usuario: { id: 1, usuario: "superadmin", isAdmin: true, podeControlar: true, nivel: 3 }, origem: "manual" };

function estado(sala) {
  return { ...db.prepare("SELECT ligado, turboAtivo, temperaturaAlvo, atualizadoEm FROM salas WHERE sala = ?").get(sala) };
}

function logs(sala) {
  return db.prepare("SELECT cmd, valor FROM comandos_log WHERE sala = ? ORDER BY id").all(sala).map((l) => ({ cmd: l.cmd, valor: l.valor }));
}

test.before(() => {
  db.prepare("INSERT INTO salas (sala, nome, bloco, andar, ligado, temperaturaAlvo, irProtocolo) VALUES ('ATOM-1', 'Atômica', 'A', 1, 0, 23, 16)").run();
});

function simularFalhaNoLog(t) {
  const preparar = db.prepare.bind(db);
  const mock = t.mock.method(db, "prepare", (sql, ...resto) => {
    if (/INSERT INTO comandos_log/.test(sql)) {
      return { run: () => { throw new Error("disco cheio (SQLITE_FULL simulado)"); } };
    }
    return preparar(sql, ...resto);
  });
  return () => mock.mock.restore();
}

test("a failure writing the command record rolls back the state mutation and sends nothing to the device", (t) => {
  const antes = estado("ATOM-1");
  const enviados = [];
  t.mock.method(deviceHub, "enviarComando", (sala, comando) => { enviados.push(comando); return true; });
  let mudancas = 0;
  const ouvinte = () => { mudancas += 1; };
  salas.eventos.on("mudanca", ouvinte);
  t.after(() => salas.eventos.removeListener("mudanca", ouvinte));

  const restaurar = simularFalhaNoLog(t);
  assert.throws(() => salas.aplicarComando("ATOM-1", "temperatura", 25, contexto), /disco cheio/);
  assert.deepEqual(estado("ATOM-1"), antes, "ligado/temperaturaAlvo must not change without the command record");
  assert.deepEqual(logs("ATOM-1"), []);
  assert.equal(enviados.length, 0);
  assert.equal(mudancas, 0);
  assert.throws(() => salas.aplicarComando("ATOM-1", "ligar", undefined, contexto), /disco cheio/);
  assert.deepEqual(estado("ATOM-1"), antes);
  restaurar();
});

test("after the failure the database is not left in an open transaction and the next command is written in full", (t) => {
  const enviados = [];
  t.mock.method(deviceHub, "enviarComando", (sala, comando) => { enviados.push(comando); return true; });
  const resultado = salas.aplicarComando("ATOM-1", "temperatura", 25, contexto);
  assert.equal(resultado.ligado, 1);
  assert.equal(resultado.temperaturaAlvo, 25);
  assert.deepEqual(logs("ATOM-1"), [{ cmd: "ligar", valor: "automatico" }, { cmd: "temperatura", valor: "25" }]);
  assert.equal(enviados.length, 1);
  assert.equal(enviados[0].tipo, "send_known_state");
  assert.equal(enviados[0].power, true);
  assert.equal(enviados[0].temp, 25);
});

test("schedule start is also atomic between state and record", (t) => {
  db.prepare("UPDATE salas SET ligado = 0, temperaturaAlvo = 23 WHERE sala = 'ATOM-1'").run();
  db.prepare("DELETE FROM comandos_log WHERE sala = 'ATOM-1'").run();
  const antes = estado("ATOM-1");
  const restaurar = simularFalhaNoLog(t);
  assert.throws(() => salas.aplicarInicioAgendamento("ATOM-1", 24), /disco cheio/);
  assert.deepEqual(estado("ATOM-1"), antes);
  assert.deepEqual(logs("ATOM-1"), []);
  restaurar();
  salas.aplicarInicioAgendamento("ATOM-1", 24);
  assert.equal(estado("ATOM-1").ligado, 1);
  assert.equal(logs("ATOM-1").length, 2);
});

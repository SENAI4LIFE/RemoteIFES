process.env.NODE_ENV = "test";
process.env.REMOTEIFES_DB_PATH = ":memory:";

const test = require("node:test");
const assert = require("node:assert/strict");

const db = require("../src/config/database");
const agendamentosService = require("../src/services/agendamentosService");

require("../src/app");

const usuario = db.prepare("SELECT id FROM usuarios WHERE usuario = 'admin'").get();
const agendamento = db.prepare(`
  INSERT INTO agendamentos (sala, usuarioId, data, horaInicio, horaFim, temperatura)
  VALUES ('A-103a', ?, '2099-01-01', '08:00', '09:00', 23)
`).run(usuario.id).lastInsertRowid;

test("execução de agendamento usa a data de Brasília, não a data UTC do timestamp", () => {
  db.prepare(`
    INSERT INTO agendamentos_execucoes (agendamentoId, tipo, executadoEm)
    VALUES (?, 'ligar', '2026-08-28 02:30:00')
  `).run(agendamento);

  assert.equal(agendamentosService.jaExecutadoHoje(agendamento, "ligar", "2026-08-27"), true);
  assert.equal(agendamentosService.jaExecutadoHoje(agendamento, "ligar", "2026-08-28"), false);
});

test("nova execução persiste explicitamente a data lógica", () => {
  agendamentosService.registrarExecucao(agendamento, "desligar", "2026-08-27");
  const linha = db.prepare(`
    SELECT dataExecucao FROM agendamentos_execucoes
    WHERE agendamentoId = ? AND tipo = 'desligar'
  `).get(agendamento);
  assert.equal(linha.dataExecucao, "2026-08-27");
});

test.after(() => db.close());

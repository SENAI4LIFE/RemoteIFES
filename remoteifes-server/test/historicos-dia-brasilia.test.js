process.env.NODE_ENV = "test";
process.env.REMOTEIFES_DB_PATH = ":memory:";

const test = require("node:test");
const assert = require("node:assert/strict");

require("../src/app");
const db = require("../src/config/database");
const salasService = require("../src/services/salasService");
const tokenService = require("../src/services/tokenService");
const auditoriaService = require("../src/services/auditoriaService");

const superadmin = db.prepare("SELECT * FROM usuarios WHERE nivel = 3").get();

// UTC instants (SQLite datetime('now') format) around Brasília midnight (UTC-3): the first three
// belong to local 20/09, the last two to 21/09.
const INSTANTES = {
  "00:00 do dia 20": "2026-09-20 03:00:00",
  "22:30 do dia 20": "2026-09-21 01:30:00",
  "23:59:59 do dia 20": "2026-09-21 02:59:59",
  "00:00 do dia 21": "2026-09-21 03:00:00",
  "20:59 do dia 21": "2026-09-21 23:59:00",
};
const DO_DIA_20 = ["00:00 do dia 20", "22:30 do dia 20", "23:59:59 do dia 20"];
const DO_DIA_21 = ["00:00 do dia 21", "20:59 do dia 21"];

function rotulos(linhas, campo = "rotulo") {
  return linhas.map((l) => l[campo]).sort();
}

test.after(() => db.close());

test("Logs > Comandos: filtrar e apagar por dia usam o dia de Brasília, com as duas bordas da meia-noite", () => {
  db.prepare("DELETE FROM comandos_log").run();
  for (const [rotulo, instante] of Object.entries(INSTANTES)) {
    db.prepare("INSERT INTO comandos_log (usuario, sala, cmd, valor, origem, criadoEm) VALUES ('x', 'A-108', 'ligar', ?, 'manual', ?)").run(rotulo, instante);
  }
  assert.deepEqual(rotulos(salasService.listarLogs({ data: "2026-09-20" }), "valor"), [...DO_DIA_20].sort());
  assert.deepEqual(rotulos(salasService.listarLogs({ data: "2026-09-21" }), "valor"), [...DO_DIA_21].sort());
  assert.deepEqual(rotulos(salasService.listarLogs({ data: "2026-09-19" }), "valor"), []);

  salasService.apagarLogs({ data: "2026-09-20" });
  assert.deepEqual(rotulos(salasService.listarLogs({}), "valor"), [...DO_DIA_21].sort(), "apagar o dia 20 preserva a meia-noite do dia 21 e as 20:59 do dia 21");
  salasService.apagarLogs({ data: "2026-09-21" });
  assert.deepEqual(salasService.listarLogs({}), []);
});

test("Logs > Dispositivos: eventos online/offline filtrados pelo dia de Brasília", () => {
  db.prepare("DELETE FROM esp_eventos").run();
  for (const [rotulo, instante] of Object.entries(INSTANTES)) {
    db.prepare("INSERT INTO esp_eventos (sala, status, criadoEm) VALUES ('A-108', ?, ?)").run(rotulo, instante);
  }
  assert.deepEqual(rotulos(salasService.listarEventosEsp({ data: "2026-09-20" }), "status"), [...DO_DIA_20].sort());
  assert.deepEqual(rotulos(salasService.listarEventosEsp({ data: "2026-09-21" }), "status"), [...DO_DIA_21].sort());
});

test("Logs > Acessos: filtrar e apagar por dia usam o dia de Brasília", () => {
  db.prepare("DELETE FROM esp_acessos").run();
  for (const [rotulo, instante] of Object.entries(INSTANTES)) {
    db.prepare("INSERT INTO esp_acessos (sala, ip, userAgent, criadoEm) VALUES ('A-108', '10.0.0.1', ?, ?)").run(rotulo, instante);
  }
  assert.deepEqual(rotulos(salasService.listarAcessosEsp({ data: "2026-09-20" }), "userAgent"), [...DO_DIA_20].sort());
  assert.deepEqual(rotulos(salasService.listarAcessosEsp({ data: "2026-09-21" }), "userAgent"), [...DO_DIA_21].sort());
  salasService.apagarAcessosEsp({ data: "2026-09-21" });
  assert.deepEqual(rotulos(salasService.listarAcessosEsp({}), "userAgent"), [...DO_DIA_20].sort());
});

test("Sessões: histórico filtrado e apagado pelo dia de Brasília do login", () => {
  db.prepare("DELETE FROM sessoes").run();
  for (const [rotulo, instante] of Object.entries(INSTANTES)) {
    db.prepare("INSERT INTO sessoes (token, usuarioId, login, logout, ultimoUso) VALUES (?, ?, ?, ?, ?)").run(`tok-${rotulo}`, superadmin.id, instante, instante, instante);
  }
  const porLogin = (linhas) => linhas.map((l) => Object.entries(INSTANTES).find(([, i]) => i === l.login)[0]).sort();
  assert.deepEqual(porLogin(tokenService.listarHistoricoSessoes({ data: "2026-09-20" })), [...DO_DIA_20].sort());
  assert.deepEqual(porLogin(tokenService.listarHistoricoSessoes({ data: "2026-09-21" })), [...DO_DIA_21].sort());
  tokenService.apagarHistoricoSessoes({ data: "2026-09-20" });
  assert.deepEqual(porLogin(tokenService.listarHistoricoSessoes({})), [...DO_DIA_21].sort());
});

test("Auditoria e conectividade: filtro de dia em Brasília", () => {
  db.prepare("DELETE FROM auditoria_eventos").run();
  for (const [rotulo, instante] of Object.entries(INSTANTES)) {
    const id = auditoriaService.registrar({ tipo: "teste_dia", ator: superadmin, alvoTipo: "x", alvoId: "1", alvoRotulo: rotulo, descricao: rotulo });
    db.prepare("UPDATE auditoria_eventos SET criadoEm = ? WHERE id = ?").run(instante, id);
  }
  assert.deepEqual(rotulos(auditoriaService.listar({ data: "2026-09-20" }).itens, "alvoRotulo"), [...DO_DIA_20].sort());
  assert.deepEqual(rotulos(auditoriaService.listar({ data: "2026-09-21" }).itens, "alvoRotulo"), [...DO_DIA_21].sort());

  db.prepare("DELETE FROM esp_indisponibilidades").run();
  for (const [rotulo, instante] of Object.entries(INSTANTES)) {
    db.prepare("INSERT INTO esp_indisponibilidades (sala, offlineEm, onlineEm, duracaoSegundos) VALUES (?, ?, ?, 1)").run(rotulo, instante, instante);
  }
  assert.deepEqual(rotulos(auditoriaService.listarConectividade({ data: "2026-09-20" }).itens, "sala"), [...DO_DIA_20].sort());
  assert.deepEqual(rotulos(auditoriaService.listarConectividade({ data: "2026-09-21" }).itens, "sala"), [...DO_DIA_21].sort());
});

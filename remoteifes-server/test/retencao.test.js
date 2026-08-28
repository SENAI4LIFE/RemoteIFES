process.env.REMOTEIFES_DB_PATH = ":memory:";
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");

const db = require("../src/config/database");
require("../src/app");
const { executarLimpezaRetencao, normalizarDiasRetencao } = require("../src/services/retencaoService");

test.after(() => db.close());

test("configuração de retenção rejeita valores que ampliariam a exclusão", () => {
  assert.equal(normalizarDiasRetencao("-1", 180), 180);
  assert.equal(normalizarDiasRetencao("0", 180), 180);
  assert.equal(normalizarDiasRetencao("1.5", 180), 180);
  assert.equal(normalizarDiasRetencao("30", 180), 30);
});

test("retenção remove somente histórico elegível e preserva dados persistentes", () => {
  const adminId = db.prepare("SELECT id FROM usuarios WHERE usuario = 'admin'").get().id;
  const sala = db.prepare("SELECT sala FROM salas LIMIT 1").get().sala;

  db.prepare("INSERT INTO comandos_log (sala, cmd, origem, criadoEm) VALUES (?, 'ligar', 'manual', datetime('now', '-400 days'))").run(sala);
  db.prepare("INSERT INTO notificacoes (tipo, mensagem, lida, criadoEm) VALUES ('lida', 'antiga', 1, datetime('now', '-400 days'))").run();
  db.prepare("INSERT INTO notificacoes (tipo, mensagem, lida, criadoEm) VALUES ('nao_lida', 'antiga', 0, datetime('now', '-400 days'))").run();
  db.prepare("INSERT INTO sessoes (usuarioId, token, login, ultimoUso, logout) VALUES (?, 'encerrada', datetime('now', '-400 days'), datetime('now', '-400 days'), datetime('now', '-400 days'))").run(adminId);
  db.prepare("INSERT INTO sessoes (usuarioId, token, login, ultimoUso) VALUES (?, 'ativa', datetime('now', '-400 days'), datetime('now'))").run(adminId);
  db.prepare("INSERT INTO relatos (usuarioId, titulo, descricao, criadoEm) VALUES (?, 'persistente', 'descrição persistente', datetime('now', '-800 days'))").run(adminId);

  executarLimpezaRetencao();

  assert.equal(db.prepare("SELECT COUNT(*) n FROM comandos_log WHERE criadoEm < datetime('now', '-390 days')").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM notificacoes WHERE tipo = 'lida'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM notificacoes WHERE tipo = 'nao_lida'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sessoes WHERE token = 'encerrada'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sessoes WHERE token = 'ativa'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM relatos WHERE titulo = 'persistente'").get().n, 1);
});

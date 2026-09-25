process.env.REMOTEIFES_DB_PATH = ":memory:";
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");

const db = require("../src/config/database");
require("../src/app");
const auditoriaService = require("../src/services/auditoriaService");
const retencaoService = require("../src/services/retencaoService");
const heatmapService = require("../src/services/heatmapService");
const configuracoesService = require("../src/services/configuracoesService");

function sala(codigo) {
  db.prepare("INSERT OR IGNORE INTO salas (sala, nome, bloco, andar, mac) VALUES (?, ?, 'A', 1, ?)").run(codigo, codigo, `AA:BB:CC:00:00:${codigo.slice(-2)}`);
}

test.before(() => {
  sala("RET-01");
  sala("RET-02");
  sala("RET-03");
});

test("an ongoing outage that started before the retention cutoff is never deleted and still closes on reconnection", () => {
  assert.equal(configuracoesService.obter().retencaoAuditoriaDias, 7);
  db.prepare("INSERT INTO esp_indisponibilidades (sala, offlineEm) VALUES ('RET-01', datetime('now', '-12 days'))").run();
  db.prepare("INSERT INTO esp_indisponibilidades (sala, offlineEm, onlineEm, duracaoSegundos) VALUES ('RET-02', datetime('now', '-12 days'), datetime('now', '-11 days'), 86400)").run();

  retencaoService.executarLimpezaRetencao();

  assert.equal(db.prepare("SELECT COUNT(*) n FROM esp_indisponibilidades WHERE sala = 'RET-01'").get().n, 1, "a queda aberta atravessa o corte");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM esp_indisponibilidades WHERE sala = 'RET-02'").get().n, 0, "the old closed outage is pruned");

  const fechada = auditoriaService.registrarOnline("RET-01");
  assert.ok(fechada, "reconnection must find the open interval");
  assert.ok(fechada.duracaoSegundos >= 12 * 86400 - 5);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM esp_indisponibilidades WHERE sala = 'RET-01' AND onlineEm IS NULL").get().n, 0);
});

test("the row limit also spares open intervals", () => {
  const inserirFechada = db.prepare("INSERT INTO esp_indisponibilidades (sala, offlineEm, onlineEm, duracaoSegundos) VALUES ('RET-03', datetime('now', ?), datetime('now', ?), 60)");
  for (let i = 0; i < 30; i += 1) inserirFechada.run(`-${(i + 1) * 60} minutes`, `-${i * 60 + 1} minutes`);
  db.prepare("INSERT INTO esp_indisponibilidades (sala, offlineEm) VALUES ('RET-03', datetime('now', '-40 hours'))").run();
  retencaoService.aplicarLimite("esp_indisponibilidades", 10);
  const restantes = db.prepare("SELECT onlineEm FROM esp_indisponibilidades WHERE sala = 'RET-03'").all();
  assert.equal(restantes.length, 11);
  assert.equal(restantes.filter((r) => r.onlineEm === null).length, 1, "the open interval survives the count-based cut");
});

test("in the 30-day heatmap availability is computed over the span with retained evidence, not over the whole period", () => {
  db.prepare("DELETE FROM esp_indisponibilidades").run();
  db.prepare("INSERT INTO esp_indisponibilidades (sala, offlineEm, onlineEm, duracaoSegundos) VALUES ('RET-01', datetime('now', '-3 days'), datetime('now', '-2 days'), 86400)").run();
  db.prepare("INSERT INTO esp_indisponibilidades (sala, offlineEm) VALUES ('RET-02', datetime('now', '-20 days'))").run();
  heatmapService.limparCache();

  const trinta = heatmapService.calcular("disponibilidade", "30d");
  assert.equal(trinta.janela.horas, 720);
  assert.equal(trinta.janela.horasEfetivas, 7 * 24);
  assert.match(trinta.avisoRetencao, /168 h/);
  const ret01 = trinta.salas.find((s) => s.sala === "RET-01");
  const ret02 = trinta.salas.find((s) => s.sala === "RET-02");
  assert.ok(Math.abs(ret01.valor - (100 * (1 - 1 / 7))) < 0.2, `one offline day in 7 retained days ≈ 85.7%, got ${ret01.valor}`);
  assert.equal(ret02.valor, 0, "an ongoing outage covers the whole retained span");
  assert.equal(ret02.minutosOffline, 7 * 24 * 60);

  const sete = heatmapService.calcular("disponibilidade", "7d");
  assert.equal(sete.avisoRetencao, null);
  assert.equal(sete.janela.horasEfetivas, sete.janela.horas);
  assert.ok(Math.abs(sete.salas.find((s) => s.sala === "RET-01").valor - ret01.valor) < 0.2, "7d and 30d agree when there are only 7 days of evidence");

  const quedas = heatmapService.calcular("quedas", "30d");
  assert.equal(quedas.janela.horasEfetivas, 720, "counts keep the requested window and only warn about retention");
  assert.match(quedas.avisoRetencao, /retenção|mantido/);
  const comandos = heatmapService.calcular("comandos", "30d");
  assert.equal(comandos.janela.horasEfetivas, 720, "metrics without connectivity dependency keep the full window");
});

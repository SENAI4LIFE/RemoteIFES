process.env.REMOTEIFES_DB_PATH = ":memory:";
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../src/config/database");
require("../src/app");
const monitoramentoService = require("../src/services/monitoramentoService");

function sql(hora) {
  return new Date(hora).toISOString().slice(0, 19).replace("T", " ");
}

function limpar() {
  db.prepare("DELETE FROM monitoramento_amostras").run();
  db.prepare("DELETE FROM monitoramento_horas").run();
  monitoramentoService.limparCacheHistorico();
}

const SEIS_HORAS = 6 * 3600 * 1000;
const bucketAnterior = Math.floor(Date.now() / SEIS_HORAS) * SEIS_HORAS - SEIS_HORAS;
const horaA = bucketAnterior + 1 * 3600 * 1000;
const horaB = bucketAnterior + 2 * 3600 * 1000;
const bucketLegado = bucketAnterior - 2 * SEIS_HORAS;

test("a consolidação por hora guarda quantas amostras válidas cada medida teve", () => {
  limpar();
  const boot = sql(bucketAnterior - 3600 * 1000);
  for (let i = 0; i < 60; i += 1) {
    monitoramentoService.gravarAmostra({ inicioProcesso: boot, rssMB: 50, cpuPercent: 1, bancoMs: 10, espComMac: 2, espOnline: 2, espWs: 2 }, sql(horaA + i * 60000));
  }
  for (let i = 0; i < 60; i += 1) {
    monitoramentoService.gravarAmostra({ inicioProcesso: boot, rssMB: 50, cpuPercent: 1, bancoMs: i < 10 ? 100 : null, espComMac: 2, espOnline: 2, espWs: 2 }, sql(horaB + i * 60000));
  }
  assert.equal(monitoramentoService.consolidarHoras(), 2);
  const [a, b] = db.prepare("SELECT * FROM monitoramento_horas ORDER BY hora").all();
  assert.equal(a.amostras, 60);
  assert.equal(a.bancoMsAmostras, 60);
  assert.equal(a.bancoMs, 10);
  assert.equal(b.amostras, 60);
  assert.equal(b.bancoMsAmostras, 10, "só as amostras com valor contam para a média da medida");
  assert.equal(b.bancoMs, 100);
  assert.equal(b.rssMBAmostras, 60);
});

test("faixas longas ponderam cada medida pela sua própria quantidade de amostras válidas", () => {
  const h30 = monitoramentoService.historico("30d");
  const indice = h30.t.indexOf(bucketAnterior);
  assert.ok(indice >= 0, "o bucket de 6 h anterior precisa estar na grade");
  const esperado = (60 * 10 + 10 * 100) / 70;
  assert.ok(Math.abs(h30.medidas.bancoMs[indice] - esperado) < 0.01, `esperava ${esperado}, obteve ${h30.medidas.bancoMs[indice]} (a ponderação antiga daria 55)`);
  assert.equal(h30.medidas.rssMB[indice], 50);
  assert.equal(h30.n[indice], 120);
});

test("horas consolidadas antes da migração, sem contagem por medida, continuam agregando pelo total de amostras", () => {
  db.prepare("INSERT INTO monitoramento_horas (hora, amostras, bancoMs, rssMB) VALUES (?, 60, 4, 30)").run(sql(bucketLegado + 3600 * 1000));
  db.prepare("INSERT INTO monitoramento_horas (hora, amostras, bancoMs, rssMB) VALUES (?, 30, 8, 30)").run(sql(bucketLegado + 2 * 3600 * 1000));
  monitoramentoService.limparCacheHistorico();
  const h30 = monitoramentoService.historico("30d");
  const indice = h30.t.indexOf(bucketLegado);
  assert.ok(indice >= 0);
  const esperado = (60 * 4 + 30 * 8) / 90;
  assert.ok(Math.abs(h30.medidas.bancoMs[indice] - esperado) < 0.01, `legado: esperava ${esperado}, obteve ${h30.medidas.bancoMs[indice]}`);
  assert.equal(h30.medidas.rssMB[indice], 30);
});

test("um bucket em que nenhuma hora tem a medida fica nulo, sem divisão por zero", () => {
  db.prepare("INSERT INTO monitoramento_horas (hora, amostras, rssMB, rssMBAmostras, bancoMs, bancoMsAmostras) VALUES (?, 60, 30, 60, NULL, 0)").run(sql(bucketLegado - SEIS_HORAS + 3600 * 1000));
  monitoramentoService.limparCacheHistorico();
  const h30 = monitoramentoService.historico("30d");
  const indice = h30.t.indexOf(bucketLegado - SEIS_HORAS);
  assert.ok(indice >= 0);
  assert.equal(h30.medidas.bancoMs[indice], null);
  assert.equal(h30.medidas.rssMB[indice], 30);
});

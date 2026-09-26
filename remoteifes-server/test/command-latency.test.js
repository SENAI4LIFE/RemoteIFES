const test = require("node:test");
const assert = require("node:assert/strict");
const { executar, estatisticas } = require("../latencia-comandos");

// A small run of the synthetic command-latency benchmark (latencia-comandos.js, `npm run
// latencia`). It checks that every stage is measured and every command is delivered and confirmed,
// over both transports. It sets no latency limit: timings on shared CI runners vary too much for
// that, and the numbers describe the software path on loopback, not radio or ESP32 latency.

test("the latency benchmark measures every stage over both transports", { timeout: 240_000 }, async () => {
  const r = await executar({ populacoes: [2], amostras: 8, rajada: 2, transportes: ["direto", "malha"] });
  assert.ok(r.ok, JSON.stringify(r.cargas.map((c) => c.erro || null)));
  assert.equal(r.cargas.length, 2);
  for (const carga of r.cargas) {
    for (const fase of ["estavel", "rajada"]) {
      const d = carga[fase];
      assert.equal(d.falhas + d.tempoEsgotado, 0, `${carga.transporte} ${fase}`);
      for (const etapa of ["aceitacao", "caminho", "entrega", "confirmacao", "total", "http"]) {
        assert.equal(d.etapasMs[etapa].n, fase === "estavel" ? 8 : 2, `${carga.transporte} ${fase} ${etapa}`);
      }
      assert.ok(d.etapasMs.total.mediana > 0);
    }
  }
  const direto = r.cargas.find((c) => c.transporte === "direto");
  assert.equal(direto.recuperacao.reconexaoAteConfirmacaoMs.n, 2);
  assert.ok(direto.recuperacao.reconexaoAteConfirmacaoMs.min >= 0, "only a confirmation after the reconnection counts");
});

test("the statistics use nearest-rank percentiles", () => {
  const v = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.deepEqual(estatisticas(v), { n: 100, mediana: 50, p95: 95, p99: 99, max: 100, min: 1 });
  assert.deepEqual(estatisticas([]), { n: 0 });
});

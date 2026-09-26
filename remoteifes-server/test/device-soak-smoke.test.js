const test = require("node:test");
const assert = require("node:assert/strict");
const { executarEnsaio } = require("../ensaio-dispositivos");

// A short run of the simulated-device soak (ensaio-dispositivos.js), small enough for CI. It checks
// invariants, not timings: after cycles of telemetry, commands, drops and mesh re-entries, every
// command was delivered and confirmed, and the server returns to its baseline once the boards are
// gone. Longer runs are for a workstation: `npm run ensaio -- --diretas 50 --ciclos 10`.

test("a short soak leaves no session, socket, handshake or growing heap behind", { timeout: 240_000 }, async () => {
  const r = await executarEnsaio({ diretas: 4, gateways: 1, nosPorGateway: 2, ciclos: 3, cicloS: 3, telemetriaMs: 400, comandosPorCiclo: 2, quedas: 0.5 });
  for (const invariante of r.invariantes) assert.ok(invariante.ok, `${invariante.nome}: ${JSON.stringify(invariante.detalhe)}`);
  assert.equal(r.contagens.quedasInjetadas, 6, "two of four direct boards dropped in each of three cycles");
  assert.equal(r.contagens.reentradasMalha, 3);
  assert.equal(r.contagens.comandos.confirmados, 6);
  assert.ok(r.final.banco.linhas.comandos_log >= 6, "commands were written to the command log");
});

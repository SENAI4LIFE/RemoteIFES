const test = require("node:test");
const assert = require("node:assert/strict");
const { executarEnsaio } = require("../ensaio-recuperacao");

// The disaster-recovery drill (ensaio-recuperacao.js, `npm run ensaio-recuperacao`), end to end on
// an isolated server with the production backup and restore commands: verified backup, loss of the
// database, corruption with quarantine, invalid backups refused, a restore refused while the server
// runs, and the restore marker.

test("the recovery drill restores a working system in every scenario", { timeout: 300_000 }, async () => {
  const r = await executarEnsaio();
  for (const c of r.cenarios) assert.ok(c.ok, `${c.nome}: ${c.erro}`);
  assert.equal(r.cenarios.length, 6);
  assert.ok(r.ok);
});

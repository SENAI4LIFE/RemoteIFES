// Loaded with `node --require` by tests that start a real Console process: the automatic update
// check fires shortly after start instead of minutes later, so the test can watch it happen. Only
// the pacing changes; what the check does is the production code.

const path = require("path");
const verificacao = require(path.join(__dirname, "..", "..", "src", "verificacao-automatica.js"));

verificacao.TEMPOS.esperaInicialMs = Number(process.env.VERIFICACAO_ESPERA_MS || 300);
verificacao.TEMPOS.variacao = 0;

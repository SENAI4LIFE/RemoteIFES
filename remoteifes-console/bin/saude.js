#!/usr/bin/env node
// Queries the application's /health and prints a readable line. Exits 0 when healthy. Used by the
// Console scripts; equivalent to the server's healthcheck.sh, but resolves the port from the same
// .env without depending on grep/curl.

const path = require("path");
const coleta = require(path.join(__dirname, "..", "src", "coleta"));

coleta
  .consultarSaude({ timeoutMs: 4000 })
  .then((saude) => {
    if (!saude.respondeu) {
      console.error(`sem resposta de http://127.0.0.1:${saude.porta}/health (${saude.erro || "desconhecido"})`);
      process.exit(1);
    }
    const commit = saude.commit ? saude.commit.slice(0, 12) : "não informado";
    console.log(
      `/health: ok=${saude.ok} banco=${saude.banco} ambiente=${saude.ambiente} commit=${commit} uptime=${saude.uptimeSegundos}s`
    );
    process.exit(saude.ok ? 0 : 1);
  })
  .catch((erro) => {
    console.error(`falha ao consultar /health: ${erro.message}`);
    process.exit(1);
  });

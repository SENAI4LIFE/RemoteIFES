#!/usr/bin/env node
// Consulta o /health da aplicação e imprime uma linha legível. Sai 0 quando saudável.
// Usado pelos scripts do console; equivale ao healthcheck.sh do servidor, mas resolve a porta
// pelo mesmo .env sem depender de grep/curl.

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

#!/usr/bin/env node
// Update and rollback runner for the Console itself.
//
// The source is a **signed release**; the RemoteIFES checkout does not participate, so a rollback
// of the checkout to a revision that predates the Console cannot remove it.
//
// Usage:
//   node bin/atualizar-console.js <versao>
//   node bin/atualizar-console.js --reverter
//   node bin/atualizar-console.js --importar <manifesto> <assinatura> <artefato>

const path = require("path");

const raiz = path.join(__dirname, "..");
const atualizador = require(path.join(raiz, "src", "atualizador"));

function log(linha) {
  process.stdout.write(`${linha}\n`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === "--reverter") {
    const r = await atualizador.reverter({ log });
    if (!r.ok) {
      console.error(r.erro);
      return 1;
    }
    log(`\nCONSOLE_RESULTADO ${JSON.stringify({ versao: r.versao, reinicio: r.reinicio })}`);
    return 0;
  }

  if (args[0] === "--importar") {
    const [, manifesto, assinatura, artefato] = args;
    const r = await atualizador.importarOffline({ manifesto, assinatura, artefato, log });
    if (!r.ok) {
      console.error(r.erro);
      return 1;
    }
    log(`
${r.resumo}`);
    if (r.reinicio !== "solicitado") {
      log(`Reinício automático indisponível (${r.reinicio}); a próxima abertura do console já carrega a versão nova.`);
    }
    log(`CONSOLE_RESULTADO ${JSON.stringify({ versao: r.versao, anterior: r.anterior, origem: "arquivo-local" })}`);
    return 0;
  }

  const versao = args[0];
  if (!versao) {
    console.error("uso: atualizar-console.js <versao> | --reverter | --importar <manifesto> <assinatura> <artefato>");
    return 2;
  }

  const r = await atualizador.atualizar(versao, { log });
  if (!r.ok) {
    console.error(`\n${r.erro}`);
    return 1;
  }
  log(`\n${r.resumo}`);
  if (r.reinicio !== "solicitado") {
    log(`Reinício automático indisponível (${r.reinicio}); a próxima abertura do console já carrega a versão nova.`);
  }
  log(`CONSOLE_RESULTADO ${JSON.stringify({ versao: r.versao, anterior: r.anterior })}`);
  return 0;
}

main()
  .then((codigo) => {
    process.exitCode = codigo;
  })
  .catch((erro) => {
    console.error(`Erro inesperado: ${erro && erro.stack ? erro.stack : erro}`);
    process.exitCode = 1;
  });

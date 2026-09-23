#!/usr/bin/env node
// Runner de atualização e reversão do próprio console.
//
// Substitui `bin/atualizar-console.sh`, que copiava o console do checkout do RemoteIFES. Aquilo
// não era um atualizador: pegava a árvore de trabalho que estivesse lá, sem assinatura, sem
// identidade de versão e sem transação — e sumia junto num rollback para revisão anterior ao
// console. Aqui a origem é um **release assinado**, e o checkout do RemoteIFES não participa.
//
// Uso:
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
    log(`Verificado: versão ${r.versao}. ${r.observacao}`);
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

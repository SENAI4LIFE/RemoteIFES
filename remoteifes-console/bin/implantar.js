#!/usr/bin/env node
// Deploy/rollback runner for the Console.
//
// This runner, not the Console and not `deploy.sh`, holds the maintenance lock for the whole
// operation: one acquisition, one owner. deploy.sh acquires the same lock with `noclobber`, so a
// second holder would make the managed deploy abort on its first step.
//
// Usage:
//   node bin/implantar.js aplicar <commit> [--offline] [--sem-reiniciar]
//   node bin/implantar.js reverter [<ref>]  [--offline] [--sem-reiniciar]

const path = require("path");

const raiz = path.join(__dirname, "..");
const config = require(path.join(raiz, "src", "config"));
const trava = require(path.join(raiz, "src", "trava"));
const implantacao = require(path.join(raiz, "src", "implantacao"));

function log(linha) {
  if (linha === undefined || linha === null || linha === "") return;
  process.stdout.write(`${linha}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  const modo = args[0];
  const posicionais = args.slice(1).filter((a) => !a.startsWith("--"));
  const offline = args.includes("--offline");
  const semReiniciar = args.includes("--sem-reiniciar");

  if (modo !== "aplicar" && modo !== "reverter") {
    console.error("uso: implantar.js {aplicar <commit>|reverter [<ref>]} [--offline] [--sem-reiniciar]");
    return 2;
  }
  if (modo === "aplicar" && !implantacao.RE_COMMIT.test(String(posicionais[0] || ""))) {
    console.error("aplicar exige um commit válido (7 a 40 dígitos hexadecimais)");
    return 2;
  }

  const operador = process.env.CONSOLE_OPERADOR || "cli";
  let travaAdquirida;
  try {
    travaAdquirida = trava.adquirir({
      acao: modo === "aplicar" ? "atualizacao.aplicar" : "atualizacao.reverter",
      trabalhoId: process.env.CONSOLE_TRABALHO_ID || null,
      operador,
    });
  } catch (erro) {
    console.error(erro.message);
    return 1;
  }

  const encerrar = () => {
    try {
      travaAdquirida.liberar();
    } catch {}
  };
  process.on("exit", encerrar);
  process.on("SIGTERM", () => {
    encerrar();
    process.exit(143);
  });
  process.on("SIGINT", () => {
    encerrar();
    process.exit(130);
  });

  try {
    const resultado =
      modo === "aplicar"
        ? await implantacao.implantar({ alvo: posicionais[0], offline, semReiniciar, log })
        : await implantacao.reverter({ alvo: posicionais[0] || null, offline, semReiniciar, log });

    if (resultado.resumo) log(`\n${resultado.resumo}`);
    if (resultado.aviso) log(`\nATENÇÃO: ${resultado.aviso}`);
    if (!resultado.ok) {
      console.error(`\n${resultado.erro}`);
      if (resultado.revertido) {
        console.error(
          resultado.reversaoConfirmada
            ? `A reversão foi confirmada: ${resultado.detalheReversao}`
            : `ATENÇÃO: a reversão NÃO foi confirmada: ${resultado.detalheReversao}. Verifique os registros do serviço.`
        );
      }
      if (resultado.desfechoIndefinido) {
        console.error("Desfecho indefinido: confira a versão em execução antes de repetir a operação.");
      }
      return 1;
    }
    log(`\nCONSOLE_RESULTADO ${JSON.stringify({ commit: resultado.commit, identidadeConfirmada: resultado.identidadeConfirmada !== false })}`);
    return 0;
  } finally {
    encerrar();
  }
}

main()
  .then((codigo) => {
    process.exitCode = codigo;
  })
  .catch((erro) => {
    console.error(`Erro inesperado: ${erro && erro.stack ? erro.stack : erro}`);
    process.exitCode = 1;
  });

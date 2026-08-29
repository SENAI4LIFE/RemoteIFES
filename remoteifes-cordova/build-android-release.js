const path = require("path");
const { spawnSync } = require("child_process");

function executar(comando, argumentos) {
  const resultado = spawnSync(comando, argumentos, { stdio: "inherit" });
  if (resultado.error) {
    throw new Error(`Falha ao executar ${comando}: ${resultado.error.message}`);
  }
  if (resultado.status !== 0) {
    const erro = new Error(`${comando} terminou com código ${resultado.status || 1}`);
    erro.exitCode = resultado.status || 1;
    throw erro;
  }
}

function caminhoCordova() {
  return require.resolve("cordova/bin/cordova");
}

function main() {
  const origem = process.env.REMOTEIFES_SERVER_URL;
  if (!origem) {
    console.error("Defina REMOTEIFES_SERVER_URL com a origem do servidor antes do build Android de produção.");
    process.exitCode = 1;
    return;
  }

  let endurecido = false;
  try {
    executar(process.execPath, [path.join(__dirname, "sync-www.js")]);
    executar(process.execPath, [path.join(__dirname, "harden-config.js"), origem]);
    endurecido = true;
    executar(process.execPath, [caminhoCordova(), "build", "android", "--release"]);
  } catch (erro) {
    console.error(erro.message);
    process.exitCode = erro.exitCode || 1;
  } finally {
    if (endurecido) {
      try {
        executar(process.execPath, [path.join(__dirname, "harden-config.js"), "--dev"]);
      } catch (erro) {
        console.error(`Falha ao restaurar config.xml: ${erro.message}`);
        process.exitCode = erro.exitCode || 1;
      }
    }
  }
}

if (require.main === module) main();

module.exports = { caminhoCordova };

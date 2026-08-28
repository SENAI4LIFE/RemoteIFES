const path = require("path");
const { spawnSync } = require("child_process");

const origem = process.env.REMOTEIFES_SERVER_URL;

if (!origem) {
  console.error("Defina REMOTEIFES_SERVER_URL com a origem do servidor antes do build Android de produção.");
  process.exit(1);
}

function executar(comando, argumentos) {
  const resultado = spawnSync(comando, argumentos, { stdio: "inherit" });
  if (resultado.error) {
    console.error(`Falha ao executar ${comando}: ${resultado.error.message}`);
    process.exit(1);
  }
  if (resultado.status !== 0) process.exit(resultado.status || 1);
}

executar(process.execPath, [path.join(__dirname, "sync-www.js")]);
executar(process.execPath, [path.join(__dirname, "harden-config.js"), origem]);
executar("cordova", ["build", "android", "--release"]);

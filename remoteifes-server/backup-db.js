const backupService = require("./src/services/backupService");

const rotulo = process.argv[2] || "manual";

try {
  const resultado = backupService.criarBackup({ rotulo });
  console.log(`Backup criado: ${resultado.arquivo}`);
  console.log(`Tamanho: ${(resultado.bytes / 1024).toFixed(1)} KiB`);
  console.log("Verificação de integridade: ok");
  if (resultado.removidos.length) {
    console.log(`Backups antigos removidos pela rotação: ${resultado.removidos.join(", ")}`);
  }
  fecharBanco();
  process.exit(0);
} catch (erro) {
  console.error(`Falha ao criar backup: ${erro.message}`);
  console.error("Rode o servidor ao menos uma vez para criar o banco antes de fazer backup.");
  fecharBanco();
  process.exit(1);
}

function fecharBanco() {
  try {
    require("./src/config/database").close();
  } catch {}
}

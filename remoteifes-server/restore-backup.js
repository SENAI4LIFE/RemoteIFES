const fs = require("fs");
const path = require("path");
const readline = require("readline");
const backupService = require("./src/services/backupService");
const { CAMINHO_DB } = require("./src/config/paths");

const args = process.argv.slice(2);
const semConfirmar = args.includes("--sim") || args.includes("-y");
const alvo = args.find((a) => !a.startsWith("-"));

function listarEDesistir() {
  const lista = backupService.listarBackups();
  if (!lista.length) {
    console.log(`Nenhum backup encontrado em ${backupService.DIR_BACKUPS}`);
    process.exit(1);
  }
  console.log("Backups disponíveis (mais recente primeiro):\n");
  for (const b of lista) {
    console.log(`  ${b.nome}   ${(b.bytes / 1024).toFixed(1)} KiB   ${b.modificadoEm}`);
  }
  console.log(`\nUso: npm run restore -- <arquivo|caminho> [--sim]`);
  process.exit(0);
}

if (!alvo) listarEDesistir();

const arquivo = fs.existsSync(alvo) ? alvo : path.join(backupService.DIR_BACKUPS, alvo);
if (!fs.existsSync(arquivo)) {
  console.error(`Arquivo não encontrado: ${arquivo}`);
  process.exit(1);
}

try {
  backupService.verificarArquivoBackup(arquivo);
  console.log(`Backup verificado com sucesso: ${arquivo}`);
} catch (erro) {
  console.error(`Backup inválido — restauração abortada: ${erro.message}`);
  process.exit(1);
}

console.log(`\nO banco atual (${CAMINHO_DB}) será SOBRESCRITO por este backup.`);
console.log("O servidor RemoteIFES precisa estar PARADO antes de continuar.");
console.log("Uma cópia de segurança do banco atual será criada automaticamente antes da troca.\n");

function prosseguir() {
  try {
    const resultado = backupService.restaurarBackup(arquivo);
    console.log(`Banco restaurado em ${resultado.destino}`);
    if (resultado.copiaSeguranca) {
      console.log(`Cópia de segurança do banco anterior: ${resultado.copiaSeguranca}`);
    }
    console.log("Verificação pós-restauração: ok. Reinicie o servidor RemoteIFES.");
    process.exit(0);
  } catch (erro) {
    console.error(`Falha na restauração: ${erro.message}`);
    process.exit(1);
  }
}

if (semConfirmar) {
  prosseguir();
} else {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('Digite "restaurar" para confirmar: ', (resposta) => {
    rl.close();
    if (resposta.trim().toLowerCase() === "restaurar") {
      prosseguir();
    } else {
      console.log("Cancelado.");
      process.exit(0);
    }
  });
}

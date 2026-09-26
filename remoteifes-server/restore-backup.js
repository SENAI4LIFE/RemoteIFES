const fs = require("fs");
const path = require("path");
const readline = require("readline");
const backupService = require("./src/services/backupService");
const { CAMINHO_DB } = require("./src/config/paths");
const { publicarMarcador } = require("./src/config/restauracao");

const args = process.argv.slice(2);
const semConfirmar = args.includes("--sim") || args.includes("-y");
const recuperarCorrompido = args.includes("--recuperar-corrompido");
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
  console.log(`\nUso: npm run restore -- <arquivo|caminho> [--sim] [--recuperar-corrompido]`);
  console.log("  --recuperar-corrompido  se o banco atual estiver corrompido, move-o para quarentena (nunca apaga) e instala o backup");
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
if (recuperarCorrompido) {
  const diagnostico = fs.existsSync(CAMINHO_DB) ? backupService.diagnosticarBancoAtual(CAMINHO_DB) : null;
  if (diagnostico && !diagnostico.integro) {
    console.log(`Diagnóstico do banco atual: ${diagnostico.mensagem}`);
    console.log("Como ele está danificado, será movido para quarentena (renomeado com sufixo .corrompido-<data>) junto dos arquivos -wal/-shm; nada é apagado.\n");
  } else {
    console.log("O banco atual passou na verificação de integridade: a quarentena não será usada e uma cópia de segurança verificada será criada normalmente.\n");
  }
} else {
  console.log("Uma cópia de segurança do banco atual será criada automaticamente antes da troca.\n");
}

// The marker keeps a server from STARTING during the swap; a server already running would keep its
// open database: on Linux it goes on writing to the replaced file, and everything written until its
// next restart is lost while other tools read the restored one. The running server is found by its
// own /health, on the address and port it is configured with.
async function servidorNoAr() {
  const porta = Number(process.env.PORTA || 8080);
  const bind = process.env.BIND_ADDR;
  const host = !bind || bind === "0.0.0.0" || bind === "::" ? "127.0.0.1" : bind;
  const url = `http://${host.includes(":") ? `[${host}]` : host}:${porta}/health`;
  try {
    const resposta = await fetch(url, { signal: AbortSignal.timeout(2000) });
    const corpo = await resposta.json();
    return corpo && typeof corpo === "object" && "banco" in corpo ? url : null;
  } catch {
    return null;
  }
}

async function prosseguir() {
  const emExecucao = await servidorNoAr();
  if (emExecucao) {
    console.error(`O servidor RemoteIFES está respondendo em ${emExecucao}. Pare-o antes de restaurar (sudo systemctl stop remoteifes.service) e rode de novo.`);
    process.exit(1);
  }
  // Until the swap ends no RemoteIFES process opens the database (src/config/restauracao.js).
  const removerMarcador = publicarMarcador(CAMINHO_DB);
  process.on("exit", removerMarcador);
  try {
    const resultado = backupService.restaurarBackup(arquivo, { quarentenarDanificado: recuperarCorrompido });
    console.log(`Banco restaurado em ${resultado.destino}`);
    if (resultado.copiaSeguranca) {
      console.log(`Cópia de segurança do banco anterior: ${resultado.copiaSeguranca}`);
    }
    if (resultado.quarentena) {
      console.log(`Arquivos danificados preservados para análise: ${Object.values(resultado.quarentena).join(", ")}`);
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

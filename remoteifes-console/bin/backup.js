#!/usr/bin/env node
// Cria um backup verificado do banco da aplicação.
//
// Reusa `src/services/backupService.js` do servidor de propósito: ele já garante snapshot
// consistente com `VACUUM INTO` (sem copiar arquivo SQLite ativo), integrity_check,
// foreign_key_check, presença das tabelas essenciais, permissão 0600, fsync, instalação
// atômica por rename, rotação e limpeza de temporários órfãos. Reimplementar aqui seria
// perder essas garantias.
//
// A conexão é aberta por este processo e passada ao serviço, para não acionar
// `conexaoAtiva()` — que carregaria `src/config/database.js` e, com ele, criação de
// diretório e PRAGMAs de escrita num processo que só deveria ler.

const fs = require("fs");
const path = require("path");

const raizConsole = path.join(__dirname, "..");
const config = require(path.join(raizConsole, "src", "config"));

const rotulo = process.argv[2] || "console";
if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(rotulo)) {
  console.error(`rótulo inválido: ${rotulo}`);
  process.exit(2);
}

const app = config.caminhosDaAplicacao();

if (!fs.existsSync(app.banco)) {
  console.error(`Banco não encontrado em ${app.banco}.`);
  console.error("Inicie o RemoteIFES ao menos uma vez para criá-lo antes de fazer backup.");
  process.exit(1);
}

let backupService;
try {
  backupService = require(path.join(config.DIR_SERVIDOR, "src", "services", "backupService"));
} catch (erro) {
  console.error(`Não foi possível carregar o serviço de backup do checkout: ${erro.message}`);
  console.error(`Checkout esperado em ${config.DIR_SERVIDOR}.`);
  process.exit(1);
}

const { DatabaseSync } = require("node:sqlite");

console.log(`Banco:    ${app.banco}`);
console.log(`Destino:  ${app.backups}`);
console.log(`Rótulo:   ${rotulo}`);
console.log("");

let conexao;
try {
  conexao = new DatabaseSync(app.banco);
  conexao.exec("PRAGMA busy_timeout = 10000");
  const resultado = backupService.criarBackup({ dir: app.backups, rotulo, conexao });
  console.log(`Backup criado: ${path.basename(resultado.arquivo)}`);
  console.log(`Tamanho: ${(resultado.bytes / 1024).toFixed(1)} KiB`);
  console.log("Verificação de integridade: ok");
  if (resultado.removidos.length) {
    console.log(`Removidos pela rotação: ${resultado.removidos.join(", ")}`);
  }
  console.log("CONSOLE_RESULTADO " + JSON.stringify({ arquivo: path.basename(resultado.arquivo), bytes: resultado.bytes }));
  process.exitCode = 0;
} catch (erro) {
  console.error(`Falha ao criar backup: ${erro.message}`);
  process.exitCode = 1;
} finally {
  try {
    if (conexao) conexao.close();
  } catch {}
}

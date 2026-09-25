#!/usr/bin/env node
// Managed restore of the application database.
//
// Writer quiescence is **established and proven**, not inferred: restoring while the application
// writes loses data.
//
// The proof cannot be "/health stopped answering". A hung process, a server on another port, an
// instance started by hand or a proxy that is down all produce the same silence while the database
// still has a live writer. The positive proof used here is an **exclusive SQLite lock**: if anyone
// still has the database open for writing, the lock fails and the restore does not happen.
//
// Sequence:
//   1. validates the chosen backup (validated identifier, never a free path from the browser);
//   2. publishes the restore marker (`<database>.restauracao`, this PID): from here until the swap
//      ends, every RemoteIFES process refuses to open the database (src/config/restauracao.js), so
//      no writer can start between the proof below and the swap;
//   3. disables the watchdog, where it exists, so it does not restart the application midway;
//   4. stops the application through the platform mechanism and confirms with the service manager;
//   5. **proves** nobody else writes by taking the exclusive database lock;
//   6. delegates the swap to backupService.restaurarBackup, which preserves the previous database,
//      validates before and after, and rolls back if the final check fails;
//   7. removes the marker and restores the previous lifecycle, then checks health.
//
// On any failure after step 3 the lifecycle is restored anyway: leaving RemoteIFES stopped and the
// watchdog disabled would be worse than the original failure.

const fs = require("fs");
const path = require("path");

const raizConsole = path.join(__dirname, "..");
const config = require(path.join(raizConsole, "src", "config"));
const processos = require(path.join(raizConsole, "src", "processos"));
const coleta = require(path.join(raizConsole, "src", "coleta"));
const plataforma = require(path.join(raizConsole, "src", "plataforma"));

const nomeBackup = process.argv[2];
const recuperarCorrompido = process.argv.includes("--recuperar-corrompido");

function passo(texto) {
  console.log(`\n== ${texto}`);
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function aplicacaoRespondendo() {
  const saude = await coleta.consultarSaude({ timeoutMs: 2000 });
  return saude.respondeu;
}

/**
 * Positive proof that nobody else writes to the database.
 *
 * Opens the file and attempts an exclusive SQLite lock. With another live writer (even hung, on
 * another port, or started by hand) SQLite refuses with SQLITE_BUSY. The absence of an HTTP
 * response proves nothing; this does.
 */
function provarQuiescencia(caminhoBanco) {
  if (!fs.existsSync(caminhoBanco)) return { ok: true, motivo: "não há banco a proteger" };
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
    return { ok: false, motivo: "node:sqlite indisponível neste runtime; não é possível provar quiescência" };
  }
  let conexao;
  try {
    conexao = new DatabaseSync(caminhoBanco);
    conexao.exec("PRAGMA busy_timeout = 3000");
    // WAL lets several writers coexist; proving exclusivity requires leaving it.
    conexao.exec("PRAGMA journal_mode = DELETE");
    conexao.exec("PRAGMA locking_mode = EXCLUSIVE");
    // Only a write transaction actually forces the exclusive lock.
    conexao.exec("BEGIN IMMEDIATE");
    conexao.exec("ROLLBACK");
    return { ok: true, motivo: "lock exclusivo do SQLite obtido: nenhum outro escritor está aberto" };
  } catch (erro) {
    return {
      ok: false,
      motivo:
        `não foi possível obter o lock exclusivo do banco (${erro.message}). ` +
        "Há um escritor ativo — um processo do RemoteIFES em execução, possivelmente travado ou iniciado fora do serviço.",
    };
  } finally {
    try {
      if (conexao) {
        conexao.exec("PRAGMA locking_mode = NORMAL");
        conexao.close();
      }
    } catch {}
  }
}

function publicarMarcador(caminhoBanco, backup) {
  const marcador = `${caminhoBanco}.restauracao`;
  const temporario = `${marcador}.${process.pid}.tmp`;
  fs.writeFileSync(temporario, JSON.stringify({ pid: process.pid, desde: new Date().toISOString(), backup }), { mode: 0o644 });
  fs.renameSync(temporario, marcador);
  return () => {
    try {
      const atual = JSON.parse(fs.readFileSync(marcador, "utf8"));
      if (atual.pid === process.pid) fs.rmSync(marcador, { force: true });
    } catch {}
  };
}

async function main() {
  const app = config.caminhosDaAplicacao();

  if (!nomeBackup) {
    console.error("informe o identificador do backup");
    return 2;
  }

  passo("Validando o backup escolhido");
  let arquivo;
  try {
    // Identifier validated against the backup directory: blocks traversal, absolute paths and
    // symlinks pointing outside.
    arquivo = processos.caminhoContidoEm(app.backups, nomeBackup);
  } catch (erro) {
    console.error(`Backup recusado: ${erro.message}`);
    return 2;
  }
  if (!fs.existsSync(arquivo)) {
    console.error(`Backup não encontrado: ${nomeBackup}`);
    return 2;
  }

  let backupService;
  try {
    backupService = require(path.join(config.DIR_SERVIDOR, "src", "services", "backupService"));
  } catch (erro) {
    console.error(`Não foi possível carregar o serviço de backup: ${erro.message}`);
    return 1;
  }

  try {
    backupService.verificarArquivoBackup(arquivo);
    console.log(`Backup verificado: ${path.basename(arquivo)}`);
  } catch (erro) {
    console.error(`Backup inválido — restauração abortada antes de tocar em qualquer coisa: ${erro.message}`);
    return 1;
  }

  passo("Bloqueando a abertura do banco durante a troca");
  let removerMarcador;
  try {
    removerMarcador = publicarMarcador(app.banco, path.basename(arquivo));
  } catch (erro) {
    console.error(`Não foi possível publicar o aviso de restauração ao lado do banco (${erro.message}). Abortando.`);
    return 1;
  }
  console.log("Nenhum processo do RemoteIFES abre o banco até a troca terminar.");
  process.on("exit", removerMarcador);

  const servicoAntes = await plataforma.estadoDoServico();
  const watchdogAntes = await plataforma.estadoDoWatchdog();
  const precisaRestabelecerServico = servicoAntes.disponivel && servicoAntes.ativo;
  const precisaRestabelecerWatchdog = watchdogAntes.disponivel && watchdogAntes.ativo;

  passo("Desligando o watchdog de saúde");
  if (precisaRestabelecerWatchdog) {
    const r = await plataforma.controlarWatchdog("desligar");
    if (!r.disponivel) {
      console.error(`Sem desligar o watchdog a aplicação pode ser reiniciada no meio da troca (${r.motivo}). Abortando.`);
      removerMarcador();
      return 1;
    }
    console.log("Watchdog desligado.");
  } else {
    console.log(watchdogAntes.disponivel ? "Watchdog não estava ativo." : `Watchdog: ${watchdogAntes.motivo}`);
  }

  let restaurou = false;
  let erroRestauracao = null;
  try {
    passo("Parando a aplicação");
    if (servicoAntes.disponivel) {
      const r = await plataforma.controlarServico("parar");
      if (!r.disponivel) throw new Error(`não foi possível parar o serviço: ${r.motivo}`);
      // Confirms through the service manager, not through /health silence.
      let parou = false;
      for (let i = 0; i < 20; i += 1) {
        const atual = await plataforma.estadoDoServico();
        if (atual.disponivel && !atual.ativo) {
          parou = true;
          break;
        }
        await esperar(1000);
      }
      if (!parou) throw new Error("o gerenciador de serviços não confirmou a parada da aplicação");
      console.log("Serviço parado e confirmado pelo gerenciador de serviços.");
    } else {
      console.log(`Ciclo de vida não controlável aqui (${servicoAntes.motivo}).`);
      if (await aplicacaoRespondendo()) {
        throw new Error(
          "a aplicação continua respondendo e o console não tem como pará-la nesta plataforma. " +
            "Pare o RemoteIFES manualmente e repita a operação."
        );
      }
    }

    passo("Provando que ninguém mais escreve no banco");
    const prova = provarQuiescencia(app.banco);
    console.log(prova.motivo);
    if (!prova.ok) {
      throw new Error("quiescência não comprovada; a restauração não prossegue.");
    }

    passo("Instalando o backup");
    const resultado = backupService.restaurarBackup(arquivo, {
      destino: app.banco,
      dirSeguranca: app.backups,
      quarentenarDanificado: recuperarCorrompido,
    });
    restaurou = true;
    console.log(`Banco restaurado em ${resultado.destino}`);
    if (resultado.copiaSeguranca) console.log(`Cópia do banco anterior: ${path.basename(resultado.copiaSeguranca)}`);
    if (resultado.quarentena) {
      console.log(`Arquivos danificados preservados: ${Object.values(resultado.quarentena).map((a) => path.basename(a)).join(", ")}`);
    }
    console.log("Verificação pós-restauração: ok");
  } catch (erro) {
    erroRestauracao = erro;
    console.error(`\nFalha na restauração: ${erro.message}`);
  }

  passo("Restabelecendo o ciclo de vida anterior");
  // The swap is over (or was abandoned): the application may open the database again.
  removerMarcador();
  if (precisaRestabelecerServico) {
    const r = await plataforma.controlarServico("iniciar");
    console.log(r.disponivel ? "Serviço iniciado." : `ATENÇÃO: não foi possível iniciar o serviço (${r.motivo}).`);
  } else {
    console.log("O serviço não estava ativo antes; deixado como estava.");
  }
  if (precisaRestabelecerWatchdog) {
    const r = await plataforma.controlarWatchdog("ligar");
    console.log(r.disponivel ? "Watchdog religado." : `ATENÇÃO: não foi possível religar o watchdog (${r.motivo}).`);
  }

  if (erroRestauracao) return 1;

  // Health is only required if the application was running before: a restore done with the service
  // intentionally stopped ends with it stopped, and that is not a failure.
  if (!precisaRestabelecerServico) {
    console.log("\nA aplicação estava parada antes da operação e continua parada, como esperado.");
    console.log(`CONSOLE_RESULTADO ${JSON.stringify({ restaurado: restaurou, arquivo: path.basename(arquivo), aplicacaoIniciada: false })}`);
    return 0;
  }

  passo("Conferindo a aplicação com o banco restaurado");
  for (let i = 0; i < 20; i += 1) {
    const saude = await coleta.consultarSaude({ timeoutMs: 2000 });
    if (saude.respondeu && saude.ok) {
      console.log(`/health ok — banco ${saude.banco}, commit ${saude.commit ? saude.commit.slice(0, 12) : "não informado"}.`);
      console.log(`\nCONSOLE_RESULTADO ${JSON.stringify({ restaurado: restaurou, arquivo: path.basename(arquivo), aplicacaoIniciada: true })}`);
      return 0;
    }
    await esperar(2000);
  }
  console.error("ATENÇÃO: o banco foi restaurado, mas a aplicação não voltou a responder saudável.");
  console.error("Verifique os registros do serviço. O banco anterior está preservado na pasta de backups.");
  return 1;
}

main()
  .then((codigo) => {
    process.exitCode = codigo;
  })
  .catch((erro) => {
    console.error(`Erro inesperado: ${erro && erro.stack ? erro.stack : erro}`);
    process.exitCode = 1;
  });

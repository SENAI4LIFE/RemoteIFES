#!/usr/bin/env node
// Restauração gerenciada do banco da aplicação.
//
// `restore-backup.js` do servidor avisa que o servidor "precisa estar PARADO", mas não
// verifica nem garante isso: restaurar com a aplicação escrevendo é perder dados. Aqui a
// quiescência é estabelecida e conferida, e o ciclo de vida anterior é restabelecido no fim.
//
// Sequência:
//   1. valida o backup escolhido (identificador validado, nunca caminho livre do navegador);
//   2. desliga o watchdog para que ele não reinicie a aplicação no meio;
//   3. para a aplicação e confirma que o /health parou de responder (quiescência de escritor);
//   4. delega a troca a backupService.restaurarBackup — que preserva o banco anterior,
//      valida antes e depois e faz rollback se a verificação final falhar;
//   5. restabelece o estado anterior do serviço e do watchdog e confere a saúde.
//
// Em qualquer falha depois do passo 3, o ciclo de vida é restabelecido mesmo assim: deixar o
// RemoteIFES parado e o watchdog desligado seria pior que a falha original.

const fs = require("fs");
const path = require("path");

const raizConsole = path.join(__dirname, "..");
const config = require(path.join(raizConsole, "src", "config"));
const processos = require(path.join(raizConsole, "src", "processos"));
const coleta = require(path.join(raizConsole, "src", "coleta"));

const nomeBackup = process.argv[2];
const recuperarCorrompido = process.argv.includes("--recuperar-corrompido");

function passo(texto) {
  console.log(`\n== ${texto}`);
}

async function esperar(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function aplicacaoRespondendo() {
  const saude = await coleta.consultarSaude({ timeoutMs: 2000 });
  return saude.respondeu;
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
    // Identificador validado contra a pasta de backups: bloqueia travessia, caminho absoluto
    // e symlink apontando para fora.
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

  const estadoServicoAntes = await coleta.estadoDoServico();
  const watchdogAntes = await coleta.estadoDoWatchdog();
  const precisaRestabelecerServico = estadoServicoAntes.suportado && estadoServicoAntes.ativo;
  const precisaRestabelecerWatchdog = watchdogAntes.suportado && watchdogAntes.ativo;

  passo("Desligando o watchdog de saúde");
  if (precisaRestabelecerWatchdog) {
    const r = await processos.chamarAuxiliar("watchdog-desligar", [], { timeoutMs: 20_000 });
    console.log(r.ok ? "Watchdog desligado." : `Aviso: não foi possível desligar o watchdog (${r.erro}).`);
    if (!r.ok) {
      console.error("Sem desligar o watchdog a aplicação pode ser reiniciada no meio da troca. Abortando.");
      return 1;
    }
  } else {
    console.log("Watchdog não estava ativo.");
  }

  let restaurou = false;
  let erroRestauracao = null;
  try {
    passo("Parando a aplicação e confirmando que ninguém está escrevendo");
    if (estadoServicoAntes.suportado) {
      const r = await processos.chamarAuxiliar("servico-parar", [], { timeoutMs: 40_000 });
      if (!r.ok) throw new Error(`não foi possível parar o serviço: ${r.erro || r.saida}`);
    } else {
      console.log("systemd indisponível: seguindo apenas com a checagem do /health.");
    }

    let quiesceu = false;
    for (let i = 0; i < 20; i += 1) {
      if (!(await aplicacaoRespondendo())) {
        quiesceu = true;
        break;
      }
      await esperar(1000);
    }
    if (!quiesceu) {
      throw new Error(
        "a aplicação continua respondendo ao /health depois do pedido de parada: há um escritor ativo no banco e a restauração não pode prosseguir"
      );
    }
    console.log("Aplicação parada e sem responder ao /health.");

    // O WAL só é reaproveitável pelo banco original. A troca cuida disso removendo os
    // laterais antes do rename; aqui só registramos o que foi encontrado.
    if (fs.existsSync(`${app.banco}-wal`)) {
      console.log("Aviso: havia arquivo -wal; ele será descartado junto com o banco substituído.");
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
  if (precisaRestabelecerServico) {
    const r = await processos.chamarAuxiliar("servico-iniciar", [], { timeoutMs: 60_000 });
    console.log(r.ok ? "Serviço iniciado." : `ATENÇÃO: não foi possível iniciar o serviço (${r.erro || r.saida}).`);
  } else {
    console.log("O serviço não estava ativo antes; deixado como estava.");
  }
  if (precisaRestabelecerWatchdog) {
    const r = await processos.chamarAuxiliar("watchdog-ligar", [], { timeoutMs: 20_000 });
    console.log(r.ok ? "Watchdog religado." : `ATENÇÃO: não foi possível religar o watchdog (${r.erro}).`);
  }

  if (erroRestauracao) return 1;

  passo("Conferindo a aplicação com o banco restaurado");
  let saudavel = false;
  for (let i = 0; i < 20; i += 1) {
    const saude = await coleta.consultarSaude({ timeoutMs: 2000 });
    if (saude.respondeu && saude.ok) {
      saudavel = true;
      console.log(`/health ok — banco ${saude.banco}, commit ${saude.commit || "não informado"}.`);
      break;
    }
    await esperar(2000);
  }
  if (!saudavel && precisaRestabelecerServico) {
    console.error("ATENÇÃO: o banco foi restaurado, mas a aplicação não voltou a responder saudável.");
    console.error("Verifique 'journalctl -u remoteifes.service -e'. O banco anterior está preservado na pasta de backups.");
    return 1;
  }
  console.log(`\nCONSOLE_RESULTADO ${JSON.stringify({ restaurado: restaurou, arquivo: path.basename(arquivo) })}`);
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

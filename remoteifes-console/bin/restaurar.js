#!/usr/bin/env node
// Restauração gerenciada do banco da aplicação.
//
// `restore-backup.js` do servidor avisa que o servidor "precisa estar PARADO", mas não verifica:
// restaurar com a aplicação escrevendo é perder dados. Aqui a quiescência é **estabelecida e
// provada**, não inferida.
//
// A prova não pode ser "o /health parou de responder". Um processo travado, um servidor com
// outra porta, uma instância iniciada à mão ou um proxy fora do ar produzem o mesmo silêncio
// enquanto o banco continua com um escritor vivo. A prova positiva usada aqui é um **lock
// exclusivo do próprio SQLite**: se alguém ainda tem o banco aberto para escrita, o lock falha
// e a restauração não acontece.
//
// Sequência:
//   1. valida o backup escolhido (identificador validado, nunca caminho livre do navegador);
//   2. desliga o watchdog, onde existe, para que ele não reinicie a aplicação no meio;
//   3. para a aplicação pelo mecanismo da plataforma e confirma pelo gerenciador de serviços;
//   4. **prova** que ninguém mais escreve, tomando o lock exclusivo do banco;
//   5. delega a troca a backupService.restaurarBackup, que preserva o banco anterior, valida
//      antes e depois e faz rollback se a verificação final falhar;
//   6. restabelece o ciclo de vida anterior e confere a saúde.
//
// Em qualquer falha depois do passo 3, o ciclo de vida é restabelecido mesmo assim: deixar o
// RemoteIFES parado e o watchdog desligado seria pior que a falha original.

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
 * Prova positiva de que ninguém mais escreve no banco.
 *
 * Abre o arquivo e tenta um lock exclusivo do SQLite. Com outro escritor vivo — mesmo travado,
 * mesmo em outra porta, mesmo iniciado à mão — o SQLite recusa com SQLITE_BUSY. Ausência de
 * resposta HTTP não prova nada; isto prova.
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
    // WAL permite vários escritores coexistirem; para provar exclusividade é preciso sair dele.
    conexao.exec("PRAGMA journal_mode = DELETE");
    conexao.exec("PRAGMA locking_mode = EXCLUSIVE");
    // Só uma transação de escrita força a tomada do lock exclusivo de verdade.
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

  const servicoAntes = await plataforma.estadoDoServico();
  const watchdogAntes = await plataforma.estadoDoWatchdog();
  const precisaRestabelecerServico = servicoAntes.disponivel && servicoAntes.ativo;
  const precisaRestabelecerWatchdog = watchdogAntes.disponivel && watchdogAntes.ativo;

  passo("Desligando o watchdog de saúde");
  if (precisaRestabelecerWatchdog) {
    const r = await plataforma.controlarWatchdog("desligar");
    if (!r.disponivel) {
      console.error(`Sem desligar o watchdog a aplicação pode ser reiniciada no meio da troca (${r.motivo}). Abortando.`);
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
      // Confirma pelo gerenciador de serviços, não pelo silêncio do /health.
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

  // Só faz sentido exigir saúde se a aplicação estava no ar antes: uma restauração feita com o
  // serviço intencionalmente parado termina com ele parado, e isso não é falha.
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

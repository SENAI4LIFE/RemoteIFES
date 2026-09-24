#!/usr/bin/env node
const fs = require("fs");
const config = require("./src/config");
const estado = require("./src/estado");
const execucao = require("./src/execucao");
const prontidao = require("./src/prontidao");
const servidor = require("./src/servidor");
const identidade = require("./src/identidade");
const atualizador = require("./src/atualizador");

// Ponto de entrada do Console de Operações.
//
// Dois modos de escuta:
//   - **ativação por socket** (produção): o systemd guarda o socket e passa o descritor 3 na
//     primeira conexão. Nenhum processo Node fica residente enquanto ninguém usa o console,
//     que é o que torna o custo ocioso zero num Raspberry Pi 3 de 1 GiB.
//   - **porta TCP** (desenvolvimento, ou host sem systemd): escuta direto em 127.0.0.1.

const SD_LISTEN_FDS_START = 3;

function descritorDoSystemd() {
  const quantos = Number(process.env.LISTEN_FDS || 0);
  const paraQuem = process.env.LISTEN_PID;
  if (!quantos) return null;
  // LISTEN_PID evita herdar por engano o descritor de um pai que não era para nós.
  if (paraQuem && paraQuem !== String(process.pid)) return null;
  if (quantos !== 1) {
    console.error(`esperado exatamente 1 socket do systemd, recebidos ${quantos}`);
    return null;
  }
  return SD_LISTEN_FDS_START;
}

function iniciar() {
  estado.garantirDiretorio();
  fs.mkdirSync(config.DIR_SAIDAS, { recursive: true, mode: 0o700 });

  // Provisiona o segredo do contrato de prontidão. Sem ele a rota da aplicação responde 404 e
  // o console não consegue observar canais de comando nem OTA em andamento.
  try {
    prontidao.garantirTokenProntidao();
  } catch (erro) {
    console.error(`aviso: não foi possível provisionar o contrato de prontidão (${erro.message})`);
  }

  // Reconciliação de uma atualização do console interrompida (queda de energia entre o estágio
  // e a troca do ponteiro). A troca em si é um rename, então nunca há instalação pela metade —
  // o que pode sobrar é estágio a limpar.
  try {
    // Divergência entre o ponteiro e o código que de fato carregou: o bootstrap já caiu para
    // uma versão utilizável, então o console está no ar — e é justamente por isso que precisa
    // ficar registrado, senão o sucesso aparente encobre uma atualização que não pegou.
    const instaladas = atualizador.versoesInstaladas();
    const emExecucao = atualizador.versaoEmExecucao();
    if (instaladas.gerenciadoLadoALado && instaladas.ativa && emExecucao && instaladas.ativa !== emExecucao) {
      estado.auditar("console-versao-divergente", { registrada: instaladas.ativa, emExecucao });
      console.error(
        `aviso: a versão ativa registrada é ${instaladas.ativa}, mas este processo é ${emExecucao}. ` +
          "A versão apontada não subiu; reinstale ou reverta."
      );
    }

    const t = atualizador.reconciliar();
    if (t.reconciliado && t.etapaInterrompida) {
      console.error(`atualização do console interrompida na etapa "${t.etapaInterrompida}" (versão ${t.versao}); estágio descartado.`);
    }
  } catch (erro) {
    console.error(`aviso: não foi possível reconciliar a atualização do console (${erro.message})`);
  }

  // Reconciliação: o processo pode ter saído por ociosidade, caído ou sido reiniciado por uma
  // auto-atualização enquanto um trabalho corria.
  const desconhecidos = execucao.reconciliar();
  if (desconhecidos) {
    console.error(`${desconhecidos} operação(ões) ficaram com desfecho desconhecido e estão marcadas como tal.`);
  }

  const app = servidor.criarServidor();
  const fd = descritorDoSystemd();

  const encerrar = (codigo = 0) => {
    try {
      identidade.limparContrato();
    } catch {}
    try {
      app.close();
    } catch {}
    process.exit(codigo);
  };

  app.on("error", (erro) => {
    if (erro.code === "EADDRINUSE") {
      console.error(
        `porta ${config.PORTA} já está em uso. Se o console já estiver rodando, use essa instância; ` +
          `caso contrário identifique o processo com "ss -ltnp 'sport = :${config.PORTA}'".`
      );
      process.exit(1);
    }
    console.error(`erro no servidor do console: ${erro.message}`);
    process.exit(1);
  });

  const publicarContrato = (modo) => {
    const endereco = app.address();
    const porta = endereco && typeof endereco === "object" ? endereco.port : config.PORTA;
    try {
      identidade.publicarContrato({ porta, modo });
    } catch (erro) {
      console.error(`aviso: não foi possível publicar o contrato de identidade (${erro.message}); o lançador não vai confirmar este processo.`);
    }
    return porta;
  };

  // O lançador sabe religar o console; o socket do systemd também. Em execução avulsa não há
  // quem reative, então a saída por ociosidade fica desarmada.
  const reativavel = fd !== null || process.env.CONSOLE_INICIADO_PELO_LANCADOR === "1";

  if (fd !== null) {
    app.listen({ fd }, () => {
      const porta = publicarContrato("socket-systemd");
      estado.auditar("console-iniciado", { modo: "socket-systemd", porta, ociosidadeS: config.OCIOSIDADE_S });
      console.log(`Console de Operações ativo pelo socket do systemd (fd ${fd}).`);
    });
  } else {
    app.listen(config.PORTA, config.ENDERECO, () => {
      publicarContrato("tcp");
      estado.auditar("console-iniciado", { modo: "tcp", endereco: config.ENDERECO, porta: config.PORTA });
      console.log(`Console de Operações em http://${config.ENDERECO}:${config.PORTA}`);
      if (config.ENDERECO === "127.0.0.1") {
        console.log(`De outra máquina: ssh -L ${config.PORTA}:127.0.0.1:${config.PORTA} <usuario>@<host>`);
      }
      if (!reativavel) {
        console.log("Execução avulsa: a saída por ociosidade fica desarmada (ninguém religaria o console).");
      }
    });
  }

  servidor.armarSaidaPorOciosidade(app, () => encerrar(0), { reativavel });

  process.on("SIGTERM", () => encerrar(0));
  process.on("SIGINT", () => encerrar(0));
  process.on("unhandledRejection", (motivo) => {
    estado.auditar("rejeicao-nao-tratada", { mensagem: motivo && motivo.message ? motivo.message : String(motivo) });
  });
  process.on("uncaughtException", (erro) => {
    estado.auditar("excecao-nao-capturada", { mensagem: erro.message });
    console.error(erro);
    encerrar(1);
  });
}

// Entrada explícita. `require.main === module` não vale quando a camada estável de bootstrap
// carrega este arquivo: ali o módulo principal é o bootstrap, e confiar nisso deixaria o
// serviço subir sem escutar nada.
if (require.main === module) iniciar();

module.exports = { iniciar, executar: iniciar, descritorDoSystemd };

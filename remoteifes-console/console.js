#!/usr/bin/env node
const fs = require("fs");
const config = require("./src/config");
const estado = require("./src/estado");
const execucao = require("./src/execucao");
const prontidao = require("./src/prontidao");
const servidor = require("./src/servidor");
const identidade = require("./src/identidade");
const atualizador = require("./src/atualizador");

// Operations Console entry point.
//
// Two listening modes:
//   - **socket activation** (production): systemd holds the socket and passes descriptor 3 on the
//     first connection. No Node process stays resident while nobody uses the Console, which makes
//     the idle cost zero on a 1 GiB Raspberry Pi 3.
//   - **TCP port** (development, or host without systemd): listens directly on 127.0.0.1.

const SD_LISTEN_FDS_START = 3;

function descritorDoSystemd() {
  const quantos = Number(process.env.LISTEN_FDS || 0);
  const paraQuem = process.env.LISTEN_PID;
  if (!quantos) return null;
  // LISTEN_PID prevents inheriting a descriptor meant for another process from a parent by mistake.
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

  // Provisions the readiness contract secret. Without it the application route answers 404 and the
  // Console cannot observe command channels or OTA in progress.
  try {
    prontidao.garantirTokenProntidao();
  } catch (erro) {
    console.error(`aviso: não foi possível provisionar o contrato de prontidão (${erro.message})`);
  }

  // Reconciles an interrupted Console update (power loss between staging and the pointer swap). The
  // swap itself is a rename, so there is never a half installation; what can remain is staging to
  // clean up.
  try {
    // Divergence between the pointer and the code that actually loaded: the bootstrap already fell
    // back to a usable version, so the Console is up, and that is exactly why it must be recorded;
    // otherwise apparent success hides an update that did not take effect.
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

  // Reconciliation: the process may have exited on idle, crashed or been restarted by a self-update
  // while a job was running.
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

  // The launcher can restart the Console, and so can the systemd socket. A standalone run has
  // nothing to reactivate it, so idle exit is disarmed.
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

// Explicit entry. `require.main === module` does not hold when the stable bootstrap layer loads
// this file: there the main module is the bootstrap, and relying on it would start the service
// without listening.
if (require.main === module) iniciar();

module.exports = { iniciar, executar: iniciar, descritorDoSystemd };

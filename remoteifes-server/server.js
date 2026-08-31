const http = require("http");
const app = require("./src/app");
const { iniciarScheduler, pararScheduler } = require("./src/scheduler/schedulerService");
const statusHub = require("./src/services/statusHub");
const deviceHub = require("./src/services/deviceHub");
const { encerrarSessoesAtivasNoInicio } = require("./src/services/tokenService");
const db = require("./src/config/database");
const logger = require("./src/utils/logger");

const PORTA = process.env.PORTA || 8080;
const ENDERECO = process.env.BIND_ADDR || "0.0.0.0";

encerrarSessoesAtivasNoInicio();

const server = http.createServer(app);
statusHub.iniciar(server);
deviceHub.iniciar(server);

server.on("error", (erro) => {
  if (erro.code === "EADDRINUSE") {
    console.error(
      `Porta ${PORTA} já está em uso. Se o RemoteIFES já estiver rodando, use essa instância; ` +
        `caso contrário, identifique o processo com "ss -ltnp 'sport = :${PORTA}'" e encerre-o antes de iniciar de novo.`
    );
    logger.error("startup-porta-em-uso", { porta: PORTA, endereco: ENDERECO });
    process.exit(1);
  }
  if (erro.code === "EACCES") {
    console.error(
      `Sem permissão para escutar na porta ${PORTA}. Use uma porta acima de 1024 (variável PORTA) ou o privilégio adequado.`
    );
    logger.error("startup-porta-sem-permissao", { porta: PORTA });
    process.exit(1);
  }
  logger.error("startup-erro-servidor", { mensagem: erro.message });
  process.exit(1);
});

server.listen(PORTA, ENDERECO, () => {
  logger.info("startup", { porta: PORTA, endereco: ENDERECO, ambiente: process.env.NODE_ENV || "development" });
  console.log(`Servidor RemoteIFES rodando em http://localhost:${PORTA}`);
  iniciarScheduler();
});

let encerrando = false;

function encerrarComGraciosidade(sinal) {
  if (encerrando) return;
  encerrando = true;
  logger.info("shutdown", { sinal });

  try {
    pararScheduler();
  } catch (erro) {
    logger.error("shutdown-scheduler", { mensagem: erro.message });
  }
  try {
    statusHub.encerrar();
  } catch (erro) {
    logger.error("shutdown-status-ws", { mensagem: erro.message });
  }
  try {
    deviceHub.encerrar();
  } catch (erro) {
    logger.error("shutdown-device-ws", { mensagem: erro.message });
  }

  server.close(() => {
    try {
      db.close();
    } catch (erro) {
      logger.error("shutdown-db-close", { mensagem: erro.message });
    }
    process.exit(0);
  });
  // Descarta conexões keep-alive/WebSocket remanescentes para que a porta seja
  // liberada de imediato, sem depender do timeout de segurança abaixo.
  if (typeof server.closeAllConnections === "function") server.closeAllConnections();
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGTERM", () => encerrarComGraciosidade("SIGTERM"));
process.on("SIGINT", () => encerrarComGraciosidade("SIGINT"));

process.on("unhandledRejection", (motivo) => {
  logger.error("unhandled-rejection", { mensagem: motivo && motivo.message ? motivo.message : String(motivo) });
});

process.on("uncaughtException", (erro) => {
  logger.error("uncaught-exception", { mensagem: erro.message, stack: erro.stack });
  process.exit(1);
});

const http = require("http");
const app = require("./src/app");
const { iniciarScheduler } = require("./src/scheduler/schedulerService");
const statusHub = require("./src/services/statusHub");
const { encerrarSessoesAtivasNoInicio } = require("./src/services/tokenService");
const db = require("./src/config/database");
const logger = require("./src/utils/logger");

const PORTA = process.env.PORTA || 8080;

encerrarSessoesAtivasNoInicio();

const server = http.createServer(app);
statusHub.iniciar(server);

server.listen(PORTA, () => {
  logger.info("startup", { porta: PORTA, ambiente: process.env.NODE_ENV || "development" });
  console.log(`Servidor RemoteIFES rodando em http://localhost:${PORTA}`);
  iniciarScheduler();
});

let encerrando = false;

function encerrarComGraciosidade(sinal) {
  if (encerrando) return;
  encerrando = true;
  logger.info("shutdown", { sinal });
  server.close(() => {
    try {
      db.close();
    } catch (erro) {
      logger.error("shutdown-db-close", { mensagem: erro.message });
    }
    process.exit(0);
  });
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

const http = require("http");
const app = require("./src/app");
const { iniciarScheduler } = require("./src/scheduler/schedulerService");
const statusHub = require("./src/services/statusHub");
const { encerrarSessoesAtivasNoInicio } = require("./src/services/tokenService");

const PORTA = process.env.PORTA || 8080;

encerrarSessoesAtivasNoInicio();

const server = http.createServer(app);
statusHub.iniciar(server);

server.listen(PORTA, () => {
  console.log(`Servidor RemoteIFES rodando em http://localhost:${PORTA}`);
  iniciarScheduler();
});

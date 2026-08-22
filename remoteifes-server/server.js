const http = require("http");
const app = require("./src/app");
const { iniciarScheduler } = require("./src/scheduler/schedulerService");
const statusHub = require("./src/services/statusHub");

const PORTA = process.env.PORTA || 8080;

const server = http.createServer(app);
statusHub.iniciar(server);

server.listen(PORTA, () => {
  console.log(`Servidor RemoteIFES rodando em http://localhost:${PORTA}`);
  iniciarScheduler();
});

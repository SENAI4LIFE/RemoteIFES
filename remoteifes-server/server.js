const app = require("./src/app");
const { iniciarScheduler } = require("./src/scheduler/schedulerService");

const PORTA = process.env.PORTA || 8080;

app.listen(PORTA, () => {
  console.log(`Servidor RemoteIFES rodando em http://localhost:${PORTA}`);
  iniciarScheduler();
});

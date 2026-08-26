process.env.REMOTEIFES_DB_PATH = process.env.REMOTEIFES_DB_PATH || ":memory:";
process.env.NODE_ENV = "test";

const http = require("http");
const test = require("node:test");
const assert = require("node:assert/strict");
const WebSocket = require("ws");

const app = require("../src/app");
const statusHub = require("../src/services/statusHub");
const usuariosService = require("../src/services/usuariosService");
const tokenService = require("../src/services/tokenService");

let server;
let baseWsUrl;

test.before(async () => {
  server = http.createServer(app);
  statusHub.iniciar(server);
  await new Promise((resolve) => server.listen(0, resolve));
  baseWsUrl = `ws://127.0.0.1:${server.address().port}/ws`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function criarClienteComFila(protocolos) {
  const ws = protocolos ? new WebSocket(baseWsUrl, protocolos) : new WebSocket(baseWsUrl);
  const fila = [];
  const aguardando = [];
  let codigoFechamento = null;

  ws.on("message", (dados) => {
    let msg;
    try {
      msg = JSON.parse(dados.toString());
    } catch (err) {
      return;
    }
    if (aguardando.length > 0) {
      aguardando.shift()(msg);
    } else {
      fila.push(msg);
    }
  });

  ws.on("close", (codigo) => {
    codigoFechamento = codigo;
  });

  function proximaMensagem() {
    if (fila.length > 0) return Promise.resolve(fila.shift());
    return new Promise((resolve) => aguardando.push(resolve));
  }

  function aberta() {
    return new Promise((resolve) => ws.once("open", resolve));
  }

  function fechada() {
    if (ws.readyState === WebSocket.CLOSED) return Promise.resolve(codigoFechamento);
    return new Promise((resolve) => ws.once("close", (codigo) => resolve(codigo)));
  }

  return { ws, proximaMensagem, aberta, fechada };
}

test("conexão anônima recebe apenas status do servidor", async () => {
  const cliente = criarClienteComFila();
  await cliente.aberta();
  const msg = await cliente.proximaMensagem();
  assert.equal(msg.tipo, "servidor");
  assert.equal(msg.online, true);
  cliente.ws.close();
});

test("conexão autenticada recebe a lista de salas", async () => {
  const usuario = usuariosService.criar(
    { usuario: "teste-ws-usuario", senha: "senhaSegura123", nome: "Usuário WS", podeControlar: true },
    { nivel: 3 }
  );
  const token = tokenService.gerarToken(usuario.id);

  const cliente = criarClienteComFila([token]);
  await cliente.aberta();
  const primeira = await cliente.proximaMensagem();
  assert.equal(primeira.tipo, "servidor");
  const segunda = await cliente.proximaMensagem();
  assert.equal(segunda.tipo, "salas");
  assert.ok(Array.isArray(segunda.salas));
  cliente.ws.close();
});

test("mensagens de observar acima do limite por janela derrubam a conexão", async () => {
  const usuario = usuariosService.criar(
    { usuario: "teste-ws-flood", senha: "senhaSegura123", nome: "Usuário Flood", podeControlar: true },
    { nivel: 3 }
  );
  const token = tokenService.gerarToken(usuario.id);

  const cliente = criarClienteComFila([token]);
  await cliente.aberta();
  await cliente.proximaMensagem();
  await cliente.proximaMensagem();

  for (let i = 0; i < 30; i++) {
    cliente.ws.send(JSON.stringify({ tipo: "observar", sala: "sala-inexistente" }));
  }
  const codigo = await cliente.fechada();
  assert.equal(codigo, 4008);
});

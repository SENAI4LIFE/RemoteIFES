process.env.REMOTEIFES_DB_PATH = process.env.REMOTEIFES_DB_PATH || ":memory:";
process.env.NODE_ENV = "test";

const http = require("http");
const test = require("node:test");
const assert = require("node:assert/strict");
const WebSocket = require("ws");

const db = require("../src/config/database");
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

test("frame acima do limite de payload derruba a conexão sem processar", async () => {
  const cliente = criarClienteComFila();
  await cliente.aberta();
  await cliente.proximaMensagem();
  cliente.ws.send("x".repeat(9 * 1024));
  const codigo = await cliente.fechada();
  assert.equal(codigo, 1009);
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

test("token invalido no upgrade nao e rebaixado para conexao anonima", async () => {
  const cliente = criarClienteComFila(["0".repeat(48)]);
  const codigo = await cliente.fechada();
  assert.equal(codigo, 4001);
});

test("logout revoga imediatamente uma conexao WebSocket ja aberta", async () => {
  const usuario = usuariosService.criar(
    { usuario: "teste-ws-revogado", senha: "senhaSegura123", nome: "Usuario WS Revogado", podeControlar: true },
    { nivel: 3 }
  );
  const token = tokenService.gerarToken(usuario.id);
  const cliente = criarClienteComFila([token]);
  await cliente.aberta();
  await cliente.proximaMensagem();
  await cliente.proximaMensagem();
  tokenService.removerToken(token);
  cliente.ws.send(JSON.stringify({ tipo: "observar", sala: "A-103a" }));
  const codigo = await cliente.fechada();
  assert.equal(codigo, 4001);
});

test("inatividade expirada revoga a conexão WebSocket autenticada", async () => {
  const usuario = usuariosService.criar(
    { usuario: "teste-ws-expirado", senha: "senhaSegura123", nome: "Usuario WS Expirado", podeControlar: true },
    { nivel: 3 }
  );
  const token = tokenService.gerarToken(usuario.id);
  const cliente = criarClienteComFila([token]);
  await cliente.aberta();
  await cliente.proximaMensagem();
  await cliente.proximaMensagem();
  db.prepare("UPDATE sessoes SET ultimoUso = datetime('now', '-61 minutes') WHERE usuarioId = ?").run(usuario.id);
  cliente.ws.send(JSON.stringify({ tipo: "observar", sala: "A-103a" }));
  assert.equal(await cliente.fechada(), 4001);
});

function coletarPor(cliente, ms) {
  return new Promise((resolve) => {
    const recebidas = [];
    const ouvir = (dados) => {
      try {
        recebidas.push(JSON.parse(dados.toString()));
      } catch (err) {
      }
    };
    cliente.ws.on("message", ouvir);
    setTimeout(() => {
      cliente.ws.off("message", ouvir);
      resolve(recebidas);
    }, ms);
  });
}

async function clienteObservando(sufixo, sala) {
  const usuario = usuariosService.criar(
    { usuario: `teste-ws-hb-${sufixo}`, senha: "senhaSegura123", nome: "Usuario WS HB", podeControlar: true },
    { nivel: 3 }
  );
  const token = tokenService.gerarToken(usuario.id);
  const cliente = criarClienteComFila([token]);
  await cliente.aberta();
  cliente.ws.send(JSON.stringify({ tipo: "observar", sala }));
  await coletarPor(cliente, 300);
  return cliente;
}

test("heartbeat sem mudanca de estado nao retransmite a lista de salas", async () => {
  const salasService = require("../src/services/salasService");
  const sala = salasService.listar()[0].sala;
  salasService.marcarOnline(sala, { ligado: false, temperatura: 24 }, null, "127.0.0.1", { viaCredencial: true });

  const cliente = await clienteObservando("estavel", sala);
  salasService.marcarOnline(sala, { ligado: false, temperatura: 24 }, null, "127.0.0.1", { viaCredencial: true });
  const tipos = (await coletarPor(cliente, 400)).map((m) => m.tipo);
  assert.deepEqual(tipos, [], `heartbeat sem mudanca nao deveria gerar trafego, veio ${JSON.stringify(tipos)}`);
  cliente.ws.close();
});

test("heartbeat que muda so a temperatura avisa apenas quem observa a sala", async () => {
  const salasService = require("../src/services/salasService");
  const sala = salasService.listar()[1].sala;
  salasService.marcarOnline(sala, { ligado: false, temperatura: 24 }, null, "127.0.0.1", { viaCredencial: true });

  const observador = await clienteObservando("observador", sala);
  const alheio = await clienteObservando("alheio", salasService.listar()[2].sala);

  const doObservador = coletarPor(observador, 500);
  const doAlheio = coletarPor(alheio, 500);
  salasService.marcarOnline(sala, { ligado: false, temperatura: 25.5 }, null, "127.0.0.1", { viaCredencial: true });

  const recebidas = await doObservador;
  assert.deepEqual(recebidas.map((m) => m.tipo), ["status"]);
  assert.equal(recebidas[0].status.sala, sala);
  assert.equal(recebidas[0].status.temperatura, 25.5);
  assert.deepEqual((await doAlheio).map((m) => m.tipo), []);

  observador.ws.close();
  alheio.ws.close();
});

test("heartbeat que muda ligado retransmite a lista de salas", async () => {
  const salasService = require("../src/services/salasService");
  const sala = salasService.listar()[3].sala;
  salasService.marcarOnline(sala, { ligado: false, temperatura: 24 }, null, "127.0.0.1", { viaCredencial: true });

  const cliente = await clienteObservando("ligado", sala);
  const coleta = coletarPor(cliente, 500);
  salasService.marcarOnline(sala, { ligado: true, temperatura: 24 }, null, "127.0.0.1", { viaCredencial: true });
  const tipos = (await coleta).map((m) => m.tipo);
  assert.ok(tipos.includes("salas"), `esperava uma retransmissao de salas, veio ${JSON.stringify(tipos)}`);
  cliente.ws.close();
});

async function clienteAutenticado(sufixo, nivel) {
  const usuario = usuariosService.criar(
    { usuario: `teste-ws-cad-${sufixo}`, senha: "senhaSegura123", nome: "Usuario WS Cadastro", podeControlar: true, isAdmin: nivel >= 2 },
    { nivel: 3 }
  );
  if (nivel === 3) db.prepare("UPDATE usuarios SET nivel = 3 WHERE id = ?").run(usuario.id);
  const token = tokenService.gerarToken(usuario.id);
  const cliente = criarClienteComFila([token]);
  await cliente.aberta();
  await coletarPor(cliente, 300);
  return cliente;
}

function salaSemDispositivo() {
  const salasService = require("../src/services/salasService");
  const sala = salasService.listar().find((s) => !s.mac && !s.online);
  assert.ok(sala, "o cenário precisa de uma sala sem ESP32 cadastrado e offline");
  return sala.sala;
}

test("cadastrar o MAC de uma sala avisa em tempo real todas as sessões administrativas", async () => {
  const salasService = require("../src/services/salasService");
  const sala = salaSemDispositivo();

  const superadmin = await clienteAutenticado("super", 3);
  const admin = await clienteAutenticado("admin", 2);
  const comum = await clienteAutenticado("comum", 1);

  try {
    const doSuper = coletarPor(superadmin, 500);
    const doAdmin = coletarPor(admin, 500);
    const doComum = coletarPor(comum, 500);

    salasService.cadastrarMac(sala, "AA:BB:CC:11:22:33");

    const avisosSuper = (await doSuper).filter((m) => m.tipo === "dispositivo_cadastro");
    const avisosAdmin = (await doAdmin).filter((m) => m.tipo === "dispositivo_cadastro");
    const avisosComum = (await doComum).filter((m) => m.tipo === "dispositivo_cadastro");

    assert.equal(avisosSuper.length, 1, "a sessão que cadastrou recebe exatamente um aviso");
    assert.equal(avisosAdmin.length, 1, "uma segunda sessão autorizada recebe o mesmo aviso");
    assert.equal(avisosComum.length, 0, "usuário comum não recebe dados de cadastro de dispositivo");

    const aviso = avisosSuper[0];
    assert.equal(aviso.sala, sala);
    assert.equal(aviso.cadastro.sala, sala);
    assert.equal(aviso.cadastro.mac, "AA:BB:CC:11:22:33");
    assert.equal(aviso.cadastro.online, false, "cadastrado não implica online");
    assert.deepEqual(avisosAdmin[0], aviso);
  } finally {
    superadmin.ws.close();
    admin.ws.close();
    comum.ws.close();
  }
});

test("cadastro recusado não gera aviso de dispositivo cadastrado", async () => {
  const salasService = require("../src/services/salasService");
  const sala = salaSemDispositivo();
  const cliente = await clienteAutenticado("recusa", 3);

  try {
    const coleta = coletarPor(cliente, 400);
    assert.throws(() => salasService.cadastrarMac(sala, "mac-invalido"));
    const avisos = (await coleta).filter((m) => m.tipo === "dispositivo_cadastro");
    assert.deepEqual(avisos, [], "um cadastro recusado não pode ser anunciado como persistido");
    assert.equal(salasService.buscar(sala).mac, null);
  } finally {
    cliente.ws.close();
  }
});

test("cadastrar o mesmo MAC de novo não duplica o vínculo nem troca a sala", async () => {
  const salasService = require("../src/services/salasService");
  const sala = salaSemDispositivo();
  const mac = "AA:BB:CC:44:55:66";
  const cliente = await clienteAutenticado("idempotente", 3);

  try {
    const coleta = coletarPor(cliente, 600);
    salasService.cadastrarMac(sala, mac);
    salasService.cadastrarMac(sala, mac);
    const avisos = (await coleta).filter((m) => m.tipo === "dispositivo_cadastro");

    assert.ok(avisos.length >= 1);
    avisos.forEach((aviso) => {
      assert.equal(aviso.cadastro.sala, sala);
      assert.equal(aviso.cadastro.mac, mac);
    });
    assert.equal(salasService.listar().filter((s) => s.mac === mac).length, 1);
  } finally {
    cliente.ws.close();
  }
});

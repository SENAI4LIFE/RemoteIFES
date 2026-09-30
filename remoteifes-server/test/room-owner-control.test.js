// Room ownership implies control access: an owner counts as authorized for their own restricted room,
// exactly like a user granted access explicitly, on every path (REST, the WebSocket room list and the
// command itself). Admins and explicitly granted users keep their behaviour.
process.env.REMOTEIFES_DB_PATH = ":memory:";
process.env.NODE_ENV = "test";

const http = require("http");
const test = require("node:test");
const assert = require("node:assert/strict");
const WebSocket = require("ws");

const db = require("../src/config/database");
const app = require("../src/app");
const statusHub = require("../src/services/statusHub");
const salasService = require("../src/services/salasService");
const usuariosService = require("../src/services/usuariosService");
const tokenService = require("../src/services/tokenService");

const SUPER = { nivel: 3 };
const SALA = "A-108";
const OUTRA = "A-106";

let server;
let porta;
const abertos = new Set();

function criarUsuario(login, { podeControlar = true } = {}) {
  const criado = usuariosService.criar({ usuario: login, senha: "SenhaDono12345", nome: login, podeControlar }, SUPER);
  return usuariosService.buscarPorId(criado.id);
}

async function requisitar(caminho, token, { method = "GET", body } = {}) {
  return fetch(`http://127.0.0.1:${porta}${caminho}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function listaPeloWebSocket(token) {
  const ws = new WebSocket(`ws://127.0.0.1:${porta}/ws`, [token]);
  abertos.add(ws);
  const lista = await new Promise((resolve, reject) => {
    ws.on("message", (d) => {
      const msg = JSON.parse(d.toString());
      if (msg.tipo === "salas") resolve(msg.salas);
    });
    ws.once("error", reject);
  });
  ws.terminate();
  abertos.delete(ws);
  return lista;
}

test.before(async () => {
  server = http.createServer(app);
  statusHub.iniciar(server);
  await new Promise((r) => server.listen(0, r));
  porta = server.address().port;
  db.prepare("UPDATE salas SET acessoRestrito = 1 WHERE sala IN (?, ?)").run(SALA, OUTRA);
});

test.after(async () => {
  for (const ws of abertos) ws.terminate();
  statusHub.encerrar();
  await new Promise((r) => server.close(r));
});

test("an owner can control their own restricted room, and only that one", () => {
  const dono = criarUsuario("dono-controle");
  salasService.concederDono(SALA, dono.id);

  assert.equal(salasService.usuarioPodeControlarSala(dono, SALA), true);
  assert.equal(salasService.usuarioPodeControlarSala(dono, SALA, salasService.contextoBroadcast()), true);
  assert.equal(salasService.usuarioPodeControlarSala(dono, OUTRA), false, "ownership of one room grants nothing on another");
  assert.equal(salasService.usuarioPodeControlarSala(dono, OUTRA, salasService.contextoBroadcast()), false);
  assert.equal(salasService.usuarioTemAcessoSala(dono.id, SALA), false, "ownership does not write an explicit grant");

  salasService.revogarDono(SALA, dono.id);
  assert.equal(salasService.usuarioPodeControlarSala(dono, SALA), false, "revoking ownership revokes control at once");
  assert.equal(salasService.usuarioPodeControlarSala(dono, SALA, salasService.contextoBroadcast()), false);
});

test("ownership does not override the general control permission", () => {
  const dono = criarUsuario("dono-sem-permissao", { podeControlar: false });
  salasService.concederDono(SALA, dono.id);
  assert.equal(salasService.usuarioPodeControlarSala(dono, SALA), false);
  assert.equal(salasService.usuarioPodeControlarSala(dono, SALA, salasService.contextoBroadcast()), false);
});

test("admins and explicitly granted users keep their behaviour", () => {
  const admin = { ...criarUsuario("admin-controle"), isAdmin: true };
  assert.equal(salasService.usuarioPodeControlarSala(admin, SALA), true);

  const autorizado = criarUsuario("autorizado-controle");
  const semAcesso = criarUsuario("sem-acesso-controle");
  salasService.concederAcesso(SALA, autorizado.id);
  for (const contexto of [null, salasService.contextoBroadcast()]) {
    assert.equal(salasService.usuarioPodeControlarSala(autorizado, SALA, contexto), true);
    assert.equal(salasService.usuarioPodeControlarSala(semAcesso, SALA, contexto), false);
    assert.equal(salasService.usuarioPodeControlarSala(semAcesso, "A-201a", contexto), true, "an unrestricted room stays open");
  }
});

test("a batch preload covers ownership, so the broadcast context answers without extra per-user queries", () => {
  const dono = criarUsuario("dono-lote");
  salasService.concederDono(SALA, dono.id);
  const contexto = salasService.contextoBroadcast();
  contexto.precarregarAcessos([dono.id]);
  const preparar = db.prepare.bind(db);
  let consultas = 0;
  db.prepare = (...a) => { consultas += 1; return preparar(...a); };
  try {
    assert.equal(salasService.usuarioPodeControlarSala(dono, SALA, contexto), true);
  } finally {
    db.prepare = preparar;
  }
  assert.equal(consultas, 0);
});

test("an owner sees and uses the control over REST and WebSocket, and loses it with the ownership", async () => {
  const dono = criarUsuario("dono-http");
  salasService.concederDono(SALA, dono.id);
  const token = tokenService.gerarToken(dono.id);

  const salas = await (await requisitar("/salas", token)).json();
  assert.equal(salas.find((s) => s.sala === SALA).podeControlarEsta, true);
  assert.equal(salas.find((s) => s.sala === OUTRA).podeControlarEsta, false);

  const pelaLista = await listaPeloWebSocket(token);
  assert.equal(pelaLista.find((s) => s.sala === SALA).podeControlarEsta, true, "the live room list agrees with REST");
  assert.equal(pelaLista.find((s) => s.sala === OUTRA).podeControlarEsta, false);

  const comando = await requisitar("/comando", token, { method: "POST", body: { sala: SALA, cmd: "ligar" } });
  assert.equal(comando.status, 200, await comando.clone().text());
  const recusado = await requisitar("/comando", token, { method: "POST", body: { sala: OUTRA, cmd: "ligar" } });
  assert.equal(recusado.status, 400);

  salasService.revogarDono(SALA, dono.id);
  const depois = await requisitar("/comando", token, { method: "POST", body: { sala: SALA, cmd: "desligar" } });
  assert.equal(depois.status, 400);
  assert.match((await depois.json()).erro, /permissão/);
});

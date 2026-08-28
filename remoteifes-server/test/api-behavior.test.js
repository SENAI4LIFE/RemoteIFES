process.env.REMOTEIFES_DB_PATH = ":memory:";
process.env.NODE_ENV = "test";

const http = require("http");
const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");

const db = require("../src/config/database");
const app = require("../src/app");
const usuariosService = require("../src/services/usuariosService");
const notificacoesService = require("../src/services/notificacoesService");

let server;
let baseUrl;

test.before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function login(usuario, senha) {
  const resp = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usuario, senha }),
  });
  return { status: resp.status, corpo: await resp.json() };
}

function authFetch(path, token, opcoes = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...opcoes,
    headers: {
      "Content-Type": "application/json",
      ...(opcoes.headers || {}),
      Authorization: token ? `Bearer ${token}` : undefined,
    },
  });
}

function primeiraSala() {
  return db.prepare("SELECT sala FROM salas ORDER BY sala LIMIT 1").get().sala;
}

test("ciclo de sessão: login emite token, /me confirma, logout invalida", async () => {
  usuariosService.criar(
    { usuario: "sessao-user", senha: "senhaSegura123", nome: "Sessão", podeControlar: true },
    { nivel: 3 }
  );

  const entrada = await login("sessao-user", "senhaSegura123");
  assert.equal(entrada.status, 200);
  const token = entrada.corpo.token;
  assert.ok(token && typeof token === "string");

  const me = await authFetch("/me", token);
  assert.equal(me.status, 200);
  assert.equal((await me.json()).usuario, "sessao-user");

  const saiu = await authFetch("/logout", token, { method: "POST" });
  assert.equal(saiu.status, 200);

  const depois = await authFetch("/me", token);
  assert.equal(depois.status, 401);
});

test("controlador: usuário com permissão liga a sala e o servidor registra o comando", async () => {
  usuariosService.criar(
    { usuario: "controlador-ok", senha: "senhaSegura123", nome: "Controlador", podeControlar: true },
    { nivel: 3 }
  );
  const { corpo } = await login("controlador-ok", "senhaSegura123");
  const sala = primeiraSala();

  const antes = db.prepare("SELECT COUNT(*) n FROM comandos_log WHERE sala = ?").get(sala).n;

  const ligar = await authFetch("/comando", corpo.token, {
    method: "POST",
    body: JSON.stringify({ sala, cmd: "ligar" }),
  });
  assert.equal(ligar.status, 200);
  const respLigar = await ligar.json();
  assert.equal(respLigar.ok, true);
  assert.equal(Boolean(respLigar.sala.ligado), true);
  assert.equal(db.prepare("SELECT ligado FROM salas WHERE sala = ?").get(sala).ligado, 1);

  const desligar = await authFetch("/comando", corpo.token, {
    method: "POST",
    body: JSON.stringify({ sala, cmd: "desligar" }),
  });
  assert.equal(Boolean((await desligar.json()).sala.ligado), false);
  assert.equal(db.prepare("SELECT ligado FROM salas WHERE sala = ?").get(sala).ligado, 0);

  const depois = db.prepare("SELECT COUNT(*) n FROM comandos_log WHERE sala = ?").get(sala).n;
  assert.equal(depois, antes + 2);
});

test("controlador: temperatura fora dos limites efetivos é rejeitada com 400", async () => {
  usuariosService.criar(
    { usuario: "controlador-temp", senha: "senhaSegura123", nome: "Controlador Temp", podeControlar: true },
    { nivel: 3 }
  );
  const { corpo } = await login("controlador-temp", "senhaSegura123");
  const sala = primeiraSala();
  const resp = await authFetch("/comando", corpo.token, {
    method: "POST",
    body: JSON.stringify({ sala, cmd: "temperatura", valor: 40 }),
  });
  assert.equal(resp.status, 400);
  assert.match((await resp.json()).erro, /temperatura deve estar entre/);
});

test("controlador: usuário sem podeControlar recebe 403 em /comando", async () => {
  usuariosService.criar(
    { usuario: "sem-controle", senha: "senhaSegura123", nome: "Sem Controle", podeControlar: false },
    { nivel: 3 }
  );
  const { corpo } = await login("sem-controle", "senhaSegura123");
  const resp = await authFetch("/comando", corpo.token, {
    method: "POST",
    body: JSON.stringify({ sala: primeiraSala(), cmd: "ligar" }),
  });
  assert.equal(resp.status, 403);
});

test("comando sem autenticação é rejeitado com 401", async () => {
  const resp = await fetch(`${baseUrl}/comando`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sala: primeiraSala(), cmd: "ligar" }),
  });
  assert.equal(resp.status, 401);
});

test("notificações de dispositivo: usuário comum recebe 403; qualquer admin lê e marca como lida", async () => {
  db.prepare("UPDATE usuarios SET senhaHash = ? WHERE usuario = 'admin'").run(bcrypt.hashSync("superSenha123", 10));

  usuariosService.criar(
    { usuario: "admin-nivel-2", senha: "senhaSegura123", nome: "Admin Nível 2", isAdmin: true },
    { nivel: 3 }
  );
  usuariosService.criar(
    { usuario: "comum-notif", senha: "senhaSegura123", nome: "Comum", podeControlar: true },
    { nivel: 3 }
  );
  const tokenAdmin = (await login("admin-nivel-2", "senhaSegura123")).corpo.token;
  const tokenComum = (await login("comum-notif", "senhaSegura123")).corpo.token;

  notificacoesService.criarEspOffline("A-999", "Sala de Teste");

  const negado = await authFetch("/admin/notificacoes", tokenComum);
  assert.equal(negado.status, 403);

  const lista = await authFetch("/admin/notificacoes", tokenAdmin);
  assert.equal(lista.status, 200);
  const alvo = (await lista.json()).find((n) => n.sala === "A-999" && n.tipo === "esp32_offline");
  assert.ok(alvo, "a notificação de ESP32 offline deve aparecer para o admin");

  const contagemAntes = await (await authFetch("/admin/notificacoes/contagem", tokenAdmin)).json();
  assert.ok(contagemAntes.naoLidas >= 1);

  const marcou = await authFetch(`/admin/notificacoes/${alvo.id}/lida`, tokenAdmin, { method: "POST" });
  assert.equal(marcou.status, 200);

  const contagemDepois = await (await authFetch("/admin/notificacoes/contagem", tokenAdmin)).json();
  assert.equal(contagemDepois.naoLidas, contagemAntes.naoLidas - 1);
});

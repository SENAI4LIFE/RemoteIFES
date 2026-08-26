process.env.REMOTEIFES_DB_PATH = process.env.REMOTEIFES_DB_PATH || ":memory:";
process.env.NODE_ENV = "test";

const http = require("http");
const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");

const db = require("../src/config/database");
const app = require("../src/app");
const usuariosService = require("../src/services/usuariosService");
const senhaAdminInicialValida = bcrypt.compareSync(
  "admin",
  db.prepare(`SELECT senhaHash FROM usuarios WHERE usuario = 'admin'`).get().senhaHash
);

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
  const corpo = await resp.json();
  return { status: resp.status, corpo };
}

function authFetch(path, token, opcoes = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...opcoes,
    headers: {
      ...(opcoes.headers || {}),
      Authorization: token ? `Bearer ${token}` : undefined,
    },
  });
}

test("achado #15 — apenas o administrador principal pode alterar o acesso restrito de uma sala (via HTTP)", async () => {
  db.prepare(`UPDATE usuarios SET senhaHash = ? WHERE usuario = 'admin'`).run(bcrypt.hashSync("superSenha123", 10));
  const loginSuperAdmin = await login("admin", "superSenha123");
  assert.equal(loginSuperAdmin.status, 200);
  const tokenSuperAdmin = loginSuperAdmin.corpo.token;

  const admin = usuariosService.criar(
    { usuario: "teste-admin-http-15", senha: "senhaSegura123", nome: "Admin HTTP 15", isAdmin: true },
    { nivel: 3 }
  );
  const loginAdmin = await login("teste-admin-http-15", "senhaSegura123");
  assert.equal(loginAdmin.status, 200);
  const tokenAdmin = loginAdmin.corpo.token;

  const salaResp = await authFetch("/admin/salas", tokenSuperAdmin);
  const salas = await salaResp.json();
  assert.ok(Array.isArray(salas) && salas.length > 0, "deve haver ao menos uma sala cadastrada");
  const sala = salas[0].sala;

  const tentativaAdmin = await authFetch(`/admin/salas/${encodeURIComponent(sala)}/acesso-restrito`, tokenAdmin, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ restrito: true }),
  });
  assert.equal(tentativaAdmin.status, 403, "um admin comum não pode alterar o acesso restrito de uma sala");

  const tentativaSuperAdmin = await authFetch(`/admin/salas/${encodeURIComponent(sala)}/acesso-restrito`, tokenSuperAdmin, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ restrito: true }),
  });
  assert.equal(tentativaSuperAdmin.status, 200, "o administrador principal pode alterar o acesso restrito de uma sala");

  await authFetch(`/admin/salas/${encodeURIComponent(sala)}/acesso-restrito`, tokenSuperAdmin, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ restrito: false }),
  });
});

test("um usuário sem privilégio de admin não consegue acessar rotas /admin", async () => {
  usuariosService.criar(
    { usuario: "teste-usuario-http-comum", senha: "senhaSegura123", nome: "Usuário Comum", podeControlar: true },
    { nivel: 3 }
  );
  const loginComum = await login("teste-usuario-http-comum", "senhaSegura123");
  assert.equal(loginComum.status, 200);

  const resp = await authFetch("/admin/usuarios", loginComum.corpo.token);
  assert.equal(resp.status, 403);
});

test("login com senha incorreta retorna 401 e não vaza detalhes internos", async () => {
  const resp = await login("admin", "senha-errada-com-certeza");
  assert.equal(resp.status, 401);
  assert.equal(resp.corpo.ok, false);
  assert.doesNotMatch(resp.corpo.erro, /stack|SQLITE|constraint/i);
});

test("a instalação inicial mantém admin/admin", async () => {
  assert.equal(senhaAdminInicialValida, true);
});

test("identificação de dispositivo depende do vínculo MAC e rejeita MAC divergente", async () => {
  db.prepare(`UPDATE usuarios SET senhaHash = ? WHERE usuario = 'admin'`).run(bcrypt.hashSync("superSenha123", 10));
  const loginSuperAdmin = await login("admin", "superSenha123");
  const tokenSuperAdmin = loginSuperAdmin.corpo.token;

  const salaResp = await authFetch("/admin/salas", tokenSuperAdmin);
  const salas = await salaResp.json();
  const sala = salas[0].sala;

  const macLegitimo = "AA:BB:CC:DD:EE:FF";
  const macForjado = "11:22:33:44:55:66";

  const identificacaoPendente = await fetch(`${baseUrl}/dispositivo/identificar`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mac: macLegitimo }),
  });
  assert.equal(identificacaoPendente.status, 202);

  const cadastro = await authFetch(`/admin/salas/${encodeURIComponent(sala)}/mac`, tokenSuperAdmin, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mac: macLegitimo }),
  });
  assert.equal(cadastro.status, 200, "o administrador principal deve conseguir cadastrar o MAC do ESP32 da sala");

  const identificacaoVinculada = await fetch(`${baseUrl}/dispositivo/identificar`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mac: macLegitimo }),
  });
  assert.equal(identificacaoVinculada.status, 200);
  assert.equal((await identificacaoVinculada.json()).sala, sala);

  const heartbeatComMacCorreto = await fetch(`${baseUrl}/dispositivo/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sala, ligado: false, mac: macLegitimo }),
  });
  assert.equal(heartbeatComMacCorreto.status, 200, "o MAC cadastrado deve continuar autenticando normalmente");

  const heartbeatComMacForjado = await fetch(`${baseUrl}/dispositivo/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sala, ligado: false, mac: macForjado }),
  });
  assert.equal(heartbeatComMacForjado.status, 403, "um MAC diferente do cadastrado para a sala deve ser rejeitado");

  const comandoComMacForjado = await fetch(`${baseUrl}/dispositivo/comando`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-device-mac": macForjado },
    body: JSON.stringify({ sala, cmd: "ligar" }),
  });
  assert.equal(comandoComMacForjado.status, 403, "rotas de dispositivo protegidas por exigirMacDaSalaSeCadastrado devem rejeitar MAC forjado");

  await authFetch(`/admin/salas/${encodeURIComponent(sala)}/mac`, tokenSuperAdmin, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mac: null }),
  });
});

test("corpo JSON malformado retorna 400, não 500", async () => {
  const resp = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{ isso nao e json valido",
  });
  assert.equal(resp.status, 400);
});

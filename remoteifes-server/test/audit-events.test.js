process.env.REMOTEIFES_DB_PATH = ":memory:";
process.env.NODE_ENV = "test";

const http = require("http");
const test = require("node:test");
const assert = require("node:assert/strict");

const db = require("../src/config/database");
const app = require("../src/app");
const usuariosService = require("../src/services/usuariosService");
const salasService = require("../src/services/salasService");
const { dataAtualBrasiliaISO } = require("../src/utils/tempo");

let server;
let baseUrl;
let tokenAdmin;
let tokenDono;
let dono;
let convidado;

async function requisitar(caminho, { token, method = "GET", body } = {}) {
  return fetch(`${baseUrl}${caminho}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function login(usuario, senha) {
  const resp = await requisitar("/login", { method: "POST", body: { usuario, senha } });
  return (await resp.json()).token;
}

function eventos(tipo) {
  return db.prepare("SELECT * FROM auditoria_eventos WHERE tipo = ? ORDER BY id").all(tipo);
}

test.before(async () => {
  const superadmin = { nivel: 3 };
  usuariosService.criar({ usuario: "ev-admin", senha: "SenhaAdmin123", nome: "Admin", isAdmin: true }, superadmin);
  dono = usuariosService.criar({ usuario: "ev-dono", senha: "SenhaDono123", nome: "Dono" }, superadmin);
  convidado = usuariosService.criar({ usuario: "ev-convidado", senha: "SenhaConv123", nome: "Convidado" }, superadmin);
  salasService.concederDono("A-108", dono.id);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  tokenAdmin = await login("ev-admin", "SenhaAdmin123");
  tokenDono = await login("ev-dono", "SenhaDono123");
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test("creating, disabling, re-enabling and deleting a schedule leave central audit records", async () => {
  const data = dataAtualBrasiliaISO();
  const criado = await requisitar("/agendamentos", {
    token: tokenAdmin,
    method: "POST",
    body: { sala: "A-108", data, horaInicio: "08:00", horaFim: "09:00", temperatura: 23 },
  });
  assert.equal(criado.status, 200);
  const { agendamento } = await criado.json();

  const criacao = eventos("agendamento_criado");
  assert.equal(criacao.length, 1);
  assert.equal(criacao[0].atorLogin, "ev-admin");
  assert.equal(criacao[0].alvoTipo, "agendamento");
  assert.equal(criacao[0].alvoId, String(agendamento.id));
  assert.equal(criacao[0].alvoRotulo, "A-108");
  assert.match(criacao[0].descricao, /A-108 .* 08:00-09:00/);

  assert.equal((await requisitar(`/agendamentos/${agendamento.id}`, { token: tokenAdmin, method: "PATCH", body: { ativo: false } })).status, 200);
  assert.equal((await requisitar(`/agendamentos/${agendamento.id}`, { token: tokenAdmin, method: "PATCH", body: { ativo: true } })).status, 200);
  assert.equal(eventos("agendamento_desativado").length, 1);
  assert.equal(eventos("agendamento_ativado").length, 1);
  assert.equal(eventos("agendamento_desativado")[0].camposAlterados, "ativo");

  assert.equal((await requisitar(`/agendamentos/${agendamento.id}`, { token: tokenAdmin, method: "DELETE" })).status, 200);
  const exclusao = eventos("agendamento_excluido");
  assert.equal(exclusao.length, 1);
  assert.equal(exclusao[0].alvoId, String(agendamento.id));
  assert.match(exclusao[0].descricao, /A-108/);
});

test("a refused schedule produces no audit record", async () => {
  const antes = db.prepare("SELECT COUNT(*) n FROM auditoria_eventos").get().n;
  const resp = await requisitar("/agendamentos", {
    token: tokenAdmin,
    method: "POST",
    body: { sala: "A-108", data: "data-invalida", horaInicio: "08:00", horaFim: "09:00", temperatura: 23 },
  });
  assert.equal(resp.status, 400);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM auditoria_eventos").get().n, antes);
});

test("an owner granting and revoking access to their room is recorded with the correct actor", async () => {
  const concedido = await requisitar(`/salas/A-108/proprietario/acesso/${convidado.id}`, { token: tokenDono, method: "POST" });
  assert.equal(concedido.status, 200);
  const concessoes = eventos("sala_usuario_autorizado").filter((e) => e.atorLogin === "ev-dono");
  assert.equal(concessoes.length, 1);
  assert.equal(concessoes[0].alvoId, String(convidado.id));
  assert.equal(concessoes[0].alvoRotulo, "ev-convidado");
  assert.match(concessoes[0].descricao, /A-108/);
  assert.match(concessoes[0].descricao, /proprietario/);

  const revogado = await requisitar(`/salas/A-108/proprietario/acesso/${convidado.id}`, { token: tokenDono, method: "DELETE" });
  assert.equal(revogado.status, 200);
  const revogacoes = eventos("sala_usuario_revogado").filter((e) => e.atorLogin === "ev-dono");
  assert.equal(revogacoes.length, 1);
  assert.equal(revogacoes[0].alvoRotulo, "ev-convidado");
  assert.match(revogacoes[0].descricao, /A-108/);
});

test("a grant refused for the owner is not audited", async () => {
  const antes = db.prepare("SELECT COUNT(*) n FROM auditoria_eventos").get().n;
  const resp = await requisitar(`/salas/A-108/proprietario/acesso/${dono.id}`, { token: tokenDono, method: "POST" });
  assert.equal(resp.status, 400);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM auditoria_eventos").get().n, antes);
});

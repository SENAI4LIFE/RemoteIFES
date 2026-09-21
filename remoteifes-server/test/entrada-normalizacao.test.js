process.env.REMOTEIFES_DB_PATH = ":memory:";
process.env.NODE_ENV = "test";

const http = require("http");
const test = require("node:test");
const assert = require("node:assert/strict");

const db = require("../src/config/database");
const app = require("../src/app");
const usuariosService = require("../src/services/usuariosService");
const agendamentos = require("../src/services/agendamentosService");
const { dataAtualBrasiliaISO } = require("../src/utils/tempo");

let server;
let baseUrl;
let tokenSuper;

async function chamar(path, { method = "GET", token, body, bruto } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined || bruto !== undefined) headers["Content-Type"] = "application/json";
  const resp = await fetch(`${baseUrl}${path}`, { method, headers, body: bruto !== undefined ? bruto : body !== undefined ? JSON.stringify(body) : undefined });
  const texto = await resp.text();
  let corpo;
  try { corpo = JSON.parse(texto); } catch { corpo = texto; }
  return { status: resp.status, corpo };
}

async function login(usuario, senha) {
  return chamar("/login", { method: "POST", body: { usuario, senha } });
}

function auditoriaDe(id) {
  return db.prepare("SELECT tipo, camposAlterados FROM auditoria_eventos WHERE alvoTipo = 'usuario' AND alvoId = ? ORDER BY id").all(String(id));
}

test.before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  tokenSuper = (await login("superadmin", "admin")).corpo.token;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
});

test("corpo acima do limite recebe 413 em qualquer rota JSON, sem erro interno; JSON malformado continua 400", async () => {
  const grande = JSON.stringify({ usuario: "x".repeat(200 * 1024), senha: "y" });
  const login = await chamar("/login", { method: "POST", bruto: grande });
  assert.equal(login.status, 413);
  assert.deepEqual(login.corpo, { ok: false, erro: "corpo da requisição muito grande" });

  const comando = await chamar("/comando", { method: "POST", token: tokenSuper, bruto: JSON.stringify({ sala: "A-108", cmd: "ligar", lixo: "z".repeat(200 * 1024) }) });
  assert.equal(comando.status, 413);
  assert.equal(comando.corpo.ok, false);

  const malformado = await chamar("/login", { method: "POST", bruto: "{ isto não é json" });
  assert.equal(malformado.status, 400);
  assert.equal(malformado.corpo.erro, "corpo da requisição inválido");
});

test("GET /agendamentos exige sala escalar: array, chave repetida e objeto recebem 400", async () => {
  for (const consulta of ["sala[]=x", "sala=x&sala=y", "sala[a]=b"]) {
    const resp = await chamar(`/agendamentos?${consulta}`, { token: tokenSuper });
    assert.equal(resp.status, 400, consulta);
    assert.deepEqual(resp.corpo, { ok: false, erro: "sala inválida" });
  }
  assert.equal((await chamar("/agendamentos?sala=A-108", { token: tokenSuper })).status, 200);
  assert.equal((await chamar("/agendamentos", { token: tokenSuper })).status, 200);
});

test("PATCH /agendamentos/:id aceita só booleano em ativo", async () => {
  const superadmin = db.prepare("SELECT * FROM usuarios WHERE nivel = 3").get();
  const ag = agendamentos.criar({ sala: "A-109", usuarioId: superadmin.id, data: dataAtualBrasiliaISO(), horaInicio: "08:00", horaFim: "09:00", temperatura: 24, modo: "reserva" });
  const desativar = await chamar(`/agendamentos/${ag.id}`, { method: "PATCH", token: tokenSuper, body: { ativo: false } });
  assert.equal(desativar.status, 200);
  assert.equal(agendamentos.buscarPorId(ag.id).ativo, 0);

  for (const valor of ["false", "true", 0, 1, null, "sim"]) {
    const resp = await chamar(`/agendamentos/${ag.id}`, { method: "PATCH", token: tokenSuper, body: { ativo: valor } });
    assert.equal(resp.status, 400, JSON.stringify(valor));
    assert.equal(resp.corpo.erro, "ativo deve ser verdadeiro ou falso");
    assert.equal(agendamentos.buscarPorId(ag.id).ativo, 0, `${JSON.stringify(valor)} não pode reativar por coerção`);
  }
  assert.equal((await chamar(`/agendamentos/${ag.id}`, { method: "PATCH", token: tokenSuper, body: {} })).status, 400);

  const reativar = await chamar(`/agendamentos/${ag.id}`, { method: "PATCH", token: tokenSuper, body: { ativo: true } });
  assert.equal(reativar.status, 200);
  assert.equal(agendamentos.buscarPorId(ag.id).ativo, 1);
});

test("desativar uma conta com ativo=false revoga a sessão na hora; representações ambíguas são recusadas; reativar devolve o acesso", async () => {
  const conta = usuariosService.criar({ usuario: "norm-ativo", senha: "senhaSegura123", nome: "Normalização", podeControlar: true }, { nivel: 3 });
  const sessao = (await login("norm-ativo", "senhaSegura123")).corpo.token;
  assert.equal((await chamar("/me", { token: sessao })).status, 200);

  for (const valor of ["false", 0, "0", "não", null]) {
    const resp = await chamar(`/admin/usuarios/${conta.id}`, { method: "PATCH", token: tokenSuper, body: { ativo: valor } });
    assert.equal(resp.status, 400, JSON.stringify(valor));
    assert.equal(resp.corpo.erro, "ativo deve ser verdadeiro ou falso");
    assert.equal(usuariosService.buscarPorId(conta.id).ativo, 1, `${JSON.stringify(valor)} não altera a conta`);
    assert.equal((await chamar("/me", { token: sessao })).status, 200, "e não mexe na sessão");
  }
  assert.equal((await chamar(`/admin/usuarios/${conta.id}`, { method: "PATCH", token: tokenSuper, body: { podeControlar: 1 } })).status, 400);
  assert.equal((await chamar(`/admin/usuarios/${conta.id}`, { method: "PATCH", token: tokenSuper, body: { isAdmin: "true" } })).status, 400);

  const noop = await chamar(`/admin/usuarios/${conta.id}`, { method: "PATCH", token: tokenSuper, body: { ativo: true } });
  assert.equal(noop.status, 200);
  assert.equal((await chamar("/me", { token: sessao })).status, 200, "confirmar o valor já vigente não revoga nada");

  const desativar = await chamar(`/admin/usuarios/${conta.id}`, { method: "PATCH", token: tokenSuper, body: { ativo: false } });
  assert.equal(desativar.status, 200);
  assert.equal(desativar.corpo.usuario.ativo, false);
  assert.equal((await chamar("/me", { token: sessao })).status, 401, "o token antigo é recusado imediatamente");
  assert.equal((await login("norm-ativo", "senhaSegura123")).status, 401, "conta inativa não faz login");

  const reativar = await chamar(`/admin/usuarios/${conta.id}`, { method: "PATCH", token: tokenSuper, body: { ativo: true } });
  assert.equal(reativar.status, 200);
  assert.equal((await chamar("/me", { token: sessao })).status, 401, "reativar não ressuscita a sessão revogada");
  assert.equal((await login("norm-ativo", "senhaSegura123")).status, 200, "mas permite entrar de novo");
});

test("a auditoria de permissões lista exatamente os campos que mudaram", async () => {
  const conta = usuariosService.criar({ usuario: "norm-audit", senha: "senhaSegura123", nome: "Auditoria", podeControlar: true }, { nivel: 3 });
  const patch = (body) => chamar(`/admin/usuarios/${conta.id}`, { method: "PATCH", token: tokenSuper, body });

  assert.equal((await patch({})).status, 200);
  assert.equal((await patch({ ativo: true, podeControlar: true })).status, 200);
  assert.deepEqual(auditoriaDe(conta.id).filter((e) => e.tipo === "conta_permissoes_alteradas"), [], "sem mudança efetiva não há evento");

  assert.equal((await patch({ podeControlar: false })).status, 200);
  assert.equal((await patch({ ativo: false })).status, 200);
  assert.equal((await patch({ ativo: true, podeControlar: true })).status, 200);
  assert.equal((await patch({ isAdmin: true })).status, 200);
  assert.equal((await patch({ isAdmin: false, podeControlar: false, ativo: false })).status, 200);
  assert.deepEqual(
    auditoriaDe(conta.id).filter((e) => e.tipo === "conta_permissoes_alteradas").map((e) => e.camposAlterados),
    ["podeControlar", "ativo", "podeControlar,ativo", "nivel", "nivel,podeControlar,ativo"]
  );
});

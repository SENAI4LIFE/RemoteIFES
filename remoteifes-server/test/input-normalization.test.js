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

test("a body above the limit receives 413 on any JSON route without an internal error; malformed JSON is still 400", async () => {
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

test("GET /agendamentos requires a scalar sala: array, repeated key and object receive 400", async () => {
  for (const consulta of ["sala[]=x", "sala=x&sala=y", "sala[a]=b"]) {
    const resp = await chamar(`/agendamentos?${consulta}`, { token: tokenSuper });
    assert.equal(resp.status, 400, consulta);
    assert.deepEqual(resp.corpo, { ok: false, erro: "sala inválida" });
  }
  assert.equal((await chamar("/agendamentos?sala=A-108", { token: tokenSuper })).status, 200);
  assert.equal((await chamar("/agendamentos", { token: tokenSuper })).status, 200);
});

test("PATCH /agendamentos/:id accepts only a boolean ativo", async () => {
  const superadmin = db.prepare("SELECT * FROM usuarios WHERE nivel = 3").get();
  const ag = agendamentos.criar({ sala: "A-109", usuarioId: superadmin.id, data: dataAtualBrasiliaISO(), horaInicio: "08:00", horaFim: "09:00", temperatura: 24, modo: "reserva" });
  const desativar = await chamar(`/agendamentos/${ag.id}`, { method: "PATCH", token: tokenSuper, body: { ativo: false } });
  assert.equal(desativar.status, 200);
  assert.equal(agendamentos.buscarPorId(ag.id).ativo, 0);

  for (const valor of ["false", "true", 0, 1, null, "sim"]) {
    const resp = await chamar(`/agendamentos/${ag.id}`, { method: "PATCH", token: tokenSuper, body: { ativo: valor } });
    assert.equal(resp.status, 400, JSON.stringify(valor));
    assert.equal(resp.corpo.erro, "ativo deve ser verdadeiro ou falso");
    assert.equal(agendamentos.buscarPorId(ag.id).ativo, 0, `${JSON.stringify(valor)} must not reactivate by coercion`);
  }
  assert.equal((await chamar(`/agendamentos/${ag.id}`, { method: "PATCH", token: tokenSuper, body: {} })).status, 400);

  const reativar = await chamar(`/agendamentos/${ag.id}`, { method: "PATCH", token: tokenSuper, body: { ativo: true } });
  assert.equal(reativar.status, 200);
  assert.equal(agendamentos.buscarPorId(ag.id).ativo, 1);
});

test("disabling an account with ativo=false revokes the session immediately; ambiguous representations are refused; re-enabling restores access", async () => {
  const conta = usuariosService.criar({ usuario: "norm-ativo", senha: "senhaSegura123", nome: "Normalização", podeControlar: true }, { nivel: 3 });
  const sessao = (await login("norm-ativo", "senhaSegura123")).corpo.token;
  assert.equal((await chamar("/me", { token: sessao })).status, 200);

  for (const valor of ["false", 0, "0", "não", null]) {
    const resp = await chamar(`/admin/usuarios/${conta.id}`, { method: "PATCH", token: tokenSuper, body: { ativo: valor } });
    assert.equal(resp.status, 400, JSON.stringify(valor));
    assert.equal(resp.corpo.erro, "ativo deve ser verdadeiro ou falso");
    assert.equal(usuariosService.buscarPorId(conta.id).ativo, 1, `${JSON.stringify(valor)} does not change the account`);
    assert.equal((await chamar("/me", { token: sessao })).status, 200, "and does not touch the session");
  }
  assert.equal((await chamar(`/admin/usuarios/${conta.id}`, { method: "PATCH", token: tokenSuper, body: { podeControlar: 1 } })).status, 400);
  assert.equal((await chamar(`/admin/usuarios/${conta.id}`, { method: "PATCH", token: tokenSuper, body: { isAdmin: "true" } })).status, 400);

  const noop = await chamar(`/admin/usuarios/${conta.id}`, { method: "PATCH", token: tokenSuper, body: { ativo: true } });
  assert.equal(noop.status, 200);
  assert.equal((await chamar("/me", { token: sessao })).status, 200, "confirming the current value revokes nothing");

  const desativar = await chamar(`/admin/usuarios/${conta.id}`, { method: "PATCH", token: tokenSuper, body: { ativo: false } });
  assert.equal(desativar.status, 200);
  assert.equal(desativar.corpo.usuario.ativo, false);
  assert.equal((await chamar("/me", { token: sessao })).status, 401, "the old token is refused immediately");
  assert.equal((await login("norm-ativo", "senhaSegura123")).status, 401, "an inactive account does not log in");

  const reativar = await chamar(`/admin/usuarios/${conta.id}`, { method: "PATCH", token: tokenSuper, body: { ativo: true } });
  assert.equal(reativar.status, 200);
  assert.equal((await chamar("/me", { token: sessao })).status, 401, "reactivating does not revive the revoked session");
  assert.equal((await login("norm-ativo", "senhaSegura123")).status, 200, "mas permite entrar de novo");
});

test("the permissions audit lists exactly the fields that changed", async () => {
  const conta = usuariosService.criar({ usuario: "norm-audit", senha: "senhaSegura123", nome: "Auditoria", podeControlar: true }, { nivel: 3 });
  const patch = (body) => chamar(`/admin/usuarios/${conta.id}`, { method: "PATCH", token: tokenSuper, body });

  assert.equal((await patch({})).status, 200);
  assert.equal((await patch({ ativo: true, podeControlar: true })).status, 200);
  assert.deepEqual(auditoriaDe(conta.id).filter((e) => e.tipo === "conta_permissoes_alteradas"), [], "without an effective change there is no event");

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

test("granting access or ownership to a nonexistent user answers with its own message, not the SQLite error", async () => {
  for (const rota of ["/admin/salas/A-108/acesso/999999", "/admin/salas/A-108/donos/999999"]) {
    const resp = await chamar(rota, { method: "POST", token: tokenSuper });
    assert.equal(resp.status, 400, rota);
    assert.equal(resp.corpo.erro, "usuário não encontrado", rota);
    assert.ok(!JSON.stringify(resp.corpo).includes("constraint"), rota);
  }
});

test("the list of detected ESP32 boards is capped to the most recent, keeping the one that just announced itself", async () => {
  const salasService = require("../src/services/salasService");
  db.prepare("DELETE FROM esp_detectados").run();
  for (let i = 0; i < 130; i += 1) {
    const mac = `02:00:00:00:${String(Math.floor(i / 256)).padStart(2, "0")}:${String(i % 256).padStart(2, "0")}`.toUpperCase();
    db.prepare("INSERT INTO esp_detectados (mac, ip, ultimaDeteccao) VALUES (?, '10.0.0.1', datetime('now', ?))").run(mac, `-${200 - i} minutes`);
  }
  salasService.identificarDispositivo("02:00:00:00:00:00", "10.0.0.2");
  const lista = await chamar("/admin/esp32/detectados", { token: tokenSuper });
  assert.equal(lista.status, 200);
  assert.equal(lista.corpo.length, 100);
  assert.equal(lista.corpo[0].mac, "02:00:00:00:00:00", "the identity that just announced itself comes first");
});

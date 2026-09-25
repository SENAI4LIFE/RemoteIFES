process.env.REMOTEIFES_DB_PATH = ":memory:";
process.env.NODE_ENV = "test";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const test = require("node:test");
const assert = require("node:assert/strict");

const db = require("../src/config/database");
const app = require("../src/app");
const configuracoesService = require("../src/services/configuracoesService");

// Test mode and the authorized ranges decide who reaches the website at all. They are owned by the
// Operations Console and the terminal CLI; the website may display them and resend the current
// values (an older cached frontend does), but never change them.

const SUPERADMIN = { id: 1, nivel: 3, usuario: "superadmin" };
let server;
let baseUrl;
let token;

async function patch(corpo) {
  const resp = await fetch(`${baseUrl}/admin/configuracoes`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(corpo),
  });
  return { status: resp.status, corpo: await resp.json() };
}

function auditorias() {
  return db.prepare("SELECT camposAlterados FROM auditoria_eventos WHERE tipo = 'configuracao_alterada' ORDER BY id").all().map((l) => l.camposAlterados);
}

test.before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const bcrypt = require("bcryptjs");
  db.prepare("UPDATE usuarios SET senhaHash = ? WHERE usuario = 'superadmin'").run(bcrypt.hashSync("senhaRedes123", 10));
  const login = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usuario: "superadmin", senha: "senhaRedes123" }),
  });
  token = (await login.json()).token;
  assert.ok(token);
  configuracoesService.validarEAtualizar({ modoTeste: false, redesAutorizadas: ["10.0.0.0/8"] }, SUPERADMIN, { infraestrutura: true });
  db.exec("DELETE FROM auditoria_eventos");
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test("the website cannot switch test mode or change the authorized ranges", async () => {
  for (const corpo of [
    { modoTeste: true },
    { redesAutorizadas: ["10.0.0.0/8", "192.168.0.0/16"] },
    { redesAutorizadas: [] },
    { modoTeste: true, timeoutInatividadeMinutos: 45 },
  ]) {
    const r = await patch(corpo);
    assert.equal(r.status, 403, JSON.stringify(corpo));
    assert.match(r.corpo.erro, /Console de Operações/);
  }
  assert.deepEqual(configuracoesService.acessoRestritoAtivo(), { modoTeste: false, redesAutorizadas: ["10.0.0.0/8"] });
  assert.notEqual(configuracoesService.obter().timeoutInatividadeMinutos, 45, "a refused request saves nothing, not even its other keys");
  assert.deepEqual(auditorias(), []);
});

test("an older frontend resending the current values still saves its other settings", async () => {
  const r = await patch({ modoTeste: false, redesAutorizadas: [" 10.0.0.0/8 ", ""], timeoutInatividadeMinutos: 45 });
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  assert.equal(r.corpo.configuracoes.timeoutInatividadeMinutos, 45);
  assert.deepEqual(configuracoesService.acessoRestritoAtivo(), { modoTeste: false, redesAutorizadas: ["10.0.0.0/8"] });
  assert.deepEqual(auditorias(), ["timeoutInatividadeMinutos"], "only the setting that changed is audited");
});

test("a website save never writes the network keys, so it cannot undo a concurrent Console change", async () => {
  db.exec("CREATE TEMP TABLE IF NOT EXISTS gravacoes (chave TEXT)");
  db.exec("CREATE TEMP TRIGGER IF NOT EXISTS gravacao_insert AFTER INSERT ON main.configuracoes BEGIN INSERT INTO gravacoes VALUES (NEW.chave); END");
  db.exec("CREATE TEMP TRIGGER IF NOT EXISTS gravacao_update AFTER UPDATE ON main.configuracoes BEGIN INSERT INTO gravacoes VALUES (NEW.chave); END");
  try {
    const r = await patch({ modoTeste: false, redesAutorizadas: ["10.0.0.0/8"], timeoutInatividadeMinutos: 50 });
    assert.equal(r.status, 200, JSON.stringify(r.corpo));
    const chaves = db.prepare("SELECT DISTINCT chave FROM gravacoes").all().map((l) => l.chave);
    assert.ok(chaves.includes("timeoutInatividadeMinutos"));
    assert.ok(!chaves.includes("modoTeste") && !chaves.includes("redesAutorizadas"), chaves.join(","));
  } finally {
    db.exec("DROP TRIGGER IF EXISTS temp.gravacao_insert");
    db.exec("DROP TRIGGER IF EXISTS temp.gravacao_update");
    db.exec("DROP TABLE IF EXISTS temp.gravacoes");
  }
});

test("the website still reads the network policy to display it", async () => {
  const resp = await fetch(`${baseUrl}/admin/configuracoes`, { headers: { Authorization: `Bearer ${token}` } });
  const corpo = await resp.json();
  assert.equal(resp.status, 200);
  assert.equal(corpo.configuracoes.modoTeste, false);
  assert.deepEqual(corpo.configuracoes.redesAutorizadas, ["10.0.0.0/8"]);
});

test("only the infrastructure path changes the policy, and it still requires the superadministrator", () => {
  assert.throws(() => configuracoesService.validarEAtualizar({ modoTeste: true }, SUPERADMIN), (e) => e.permissao === true);
  assert.throws(() => configuracoesService.validarEAtualizar({ modoTeste: true }, { id: 2, nivel: 2 }, { infraestrutura: true }), /superadministrador/);
  configuracoesService.validarEAtualizar({ redesAutorizadas: ["172.16.0.0/12"] }, SUPERADMIN, { infraestrutura: true });
  assert.deepEqual(configuracoesService.acessoRestritoAtivo().redesAutorizadas, ["172.16.0.0/12"]);
  configuracoesService.validarEAtualizar({ redesAutorizadas: ["10.0.0.0/8"] }, SUPERADMIN, { infraestrutura: true });
});

test("the terminal CLI keeps changing the authorized ranges", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redes-cli-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const banco = path.join(dir, "remoteifes.db");
  const env = { ...process.env, REMOTEIFES_DB_PATH: banco, NODE_ENV: "production" };
  const raiz = path.join(__dirname, "..");

  const r = spawnSync(process.execPath, ["redes-autorizadas.js", "10.10.0.0/16"], { cwd: raiz, env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const lido = spawnSync(
    process.execPath,
    ["-e", "process.stdout.write(JSON.stringify(require('./src/services/configuracoesService').acessoRestritoAtivo()))"],
    { cwd: raiz, env, encoding: "utf8" }
  );
  assert.deepEqual(JSON.parse(lido.stdout), { modoTeste: false, redesAutorizadas: ["10.10.0.0/16"] });
});

process.env.NODE_ENV = "production";
process.env.REMOTEIFES_DB_PATH = ":memory:";
delete process.env.SENHA_ADMIN_INICIAL;

const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");

const db = require("../src/config/database");
const { popularBanco } = require("../src/db/seed");
const configuracoesService = require("../src/services/configuracoesService");

require("../src/app");
popularBanco();

test("bootstrap de produção não usa credenciais de desenvolvimento e restringe a rede por padrão", () => {
  const admin = db.prepare("SELECT senhaHash FROM usuarios WHERE usuario = 'superadmin'").get();
  assert.equal(bcrypt.compareSync("admin", admin.senhaHash), false);
  assert.equal(configuracoesService.acessoRestritoAtivo().modoTeste, false);
});

test("bootstrap de produção rejeita senha inicial fraca", () => {
  db.prepare("DELETE FROM usuarios WHERE usuario = 'superadmin'").run();
  process.env.SENHA_ADMIN_INICIAL = "curta";
  assert.throws(() => popularBanco(), /ao menos 8 caracteres em produção/);
});

test.after(() => db.close());

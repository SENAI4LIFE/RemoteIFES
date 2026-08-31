process.env.NODE_ENV = "production";
process.env.REMOTEIFES_DB_PATH = ":memory:";
delete process.env.SENHA_ADMIN_INICIAL;

const fs = require("fs");
const os = require("os");
const path = require("path");
const dirTemporario = fs.mkdtempSync(path.join(os.tmpdir(), "remoteifes-hardening-"));
process.env.REMOTEIFES_DATA_DIR = dirTemporario;

const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");

const db = require("../src/config/database");
const { popularBanco } = require("../src/db/seed");
const configuracoesService = require("../src/services/configuracoesService");
const { ipAutorizado } = require("../src/utils/rede");

require("../src/app");
popularBanco();

test("bootstrap de produção cria a credencial padrão sem enfraquecer os controles de rede e dispositivo", () => {
  const admin = db.prepare("SELECT senhaHash FROM usuarios WHERE usuario = 'superadmin'").get();
  assert.equal(bcrypt.compareSync("admin", admin.senhaHash), true);
  assert.equal(configuracoesService.acessoRestritoAtivo().modoTeste, false);
  assert.equal(configuracoesService.obter().espCredenciaisObrigatorias, true);
});

test("loopback permanece autorizado sem faixas cadastradas para manutenção local", () => {
  assert.equal(ipAutorizado("127.0.0.1", []), true);
  assert.equal(ipAutorizado("::1", []), true);
  assert.equal(ipAutorizado("::ffff:127.0.0.1", []), true);
  assert.equal(ipAutorizado("10.10.1.50", []), false);
});

test("bootstrap aceita uma senha inicial configurada sem alterar contas existentes", () => {
  db.prepare("DELETE FROM usuarios WHERE usuario = 'superadmin'").run();
  process.env.SENHA_ADMIN_INICIAL = "production-test-pass-123";
  assert.doesNotThrow(() => popularBanco());
  assert.equal(bcrypt.compareSync("production-test-pass-123", db.prepare("SELECT senhaHash FROM usuarios WHERE usuario = 'superadmin'").get().senhaHash), true);
});

test("bootstrap preserva a credencial padrão e não cria arquivo de senha", () => {
  db.prepare("UPDATE usuarios SET senhaHash = ? WHERE usuario = 'superadmin'").run(bcrypt.hashSync("admin", 10));
  assert.doesNotThrow(() => popularBanco());
  const admin = db.prepare("SELECT senhaHash FROM usuarios WHERE usuario = 'superadmin'").get();
  assert.equal(bcrypt.compareSync("admin", admin.senhaHash), true);
  assert.equal(fs.existsSync(path.join(dirTemporario, "senha-inicial-superadmin.txt")), false);
});

test.after(() => {
  db.close();
  fs.rmSync(dirTemporario, { recursive: true, force: true });
});

process.env.NODE_ENV = "test";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const bcrypt = require("bcryptjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "remoteifes-bootstrap-"));
process.env.REMOTEIFES_DB_PATH = path.join(tmp, "bootstrap.db");
delete process.env.SENHA_ADMIN_INICIAL;

const db = require("../src/config/database");
const { criarSchema } = require("../src/db/schema");
const { popularBanco } = require("../src/db/seed");
const usuarios = require("../src/services/usuariosService");

function iniciarServidor() {
  criarSchema();
  popularBanco();
}

function contas() {
  return db.prepare("SELECT id, usuario, nivel, senhaHash FROM usuarios ORDER BY id").all();
}

function privilegiadas() {
  return contas().filter((c) => c.nivel === usuarios.NIVEL_SUPERADMIN);
}

test.after(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("a new installation creates exactly one superadmin account with the initial credential", () => {
  iniciarServidor();
  const lista = privilegiadas();
  assert.equal(lista.length, 1);
  assert.equal(lista[0].usuario, "superadmin");
  assert.ok(bcrypt.compareSync("admin", lista[0].senhaHash));
  assert.equal(usuarios.senhaPadraoAtiva(usuarios.buscarPorId(lista[0].id)), true);
});

test("renaming the superadmin and restarting does not recreate the privileged default account", () => {
  const [conta] = privilegiadas();
  const requisitante = usuarios.buscarPorId(conta.id);
  usuarios.trocarLogin(conta.id, "coordenacao.ti", requisitante);
  usuarios.trocarSenha(conta.id, "senha-forte-propria", requisitante);

  iniciarServidor();
  iniciarServidor();

  const lista = privilegiadas();
  assert.equal(lista.length, 1, "não pode existir uma segunda identidade privilegiada");
  assert.equal(lista[0].id, conta.id);
  assert.equal(lista[0].usuario, "coordenacao.ti");
  assert.equal(db.prepare("SELECT id FROM usuarios WHERE usuario = 'superadmin'").get(), undefined);
  assert.equal(usuarios.senhaPadraoAtiva(usuarios.buscarPorId(conta.id)), false);
});

test("the default password is still detected with the login renamed", () => {
  const [conta] = privilegiadas();
  db.prepare("UPDATE usuarios SET senhaHash = ? WHERE id = ?").run(bcrypt.hashSync("admin", 4), conta.id);
  assert.equal(usuarios.senhaPadraoAtiva(usuarios.buscarPorId(conta.id)), true);
  db.prepare("UPDATE usuarios SET senhaHash = ? WHERE id = ?").run(bcrypt.hashSync("outra-senha-123", 4), conta.id);
  assert.equal(usuarios.senhaPadraoAtiva(usuarios.buscarPorId(conta.id)), false);
});

test("an established installation without a superadmin does not receive a silent default credential", () => {
  db.prepare("DELETE FROM usuarios").run();
  db.prepare(
    "INSERT INTO usuarios (usuario, senhaHash, nome, isAdmin, nivel, podeControlar, ativo) VALUES ('professor', 'hash', 'Professor', 0, 1, 1, 1)"
  ).run();
  const erros = [];
  const original = console.error;
  console.error = (linha) => erros.push(String(linha));
  try {
    iniciarServidor();
  } finally {
    console.error = original;
  }
  assert.equal(privilegiadas().length, 0);
  assert.equal(db.prepare("SELECT id FROM usuarios WHERE usuario = 'superadmin'").get(), undefined);
  assert.ok(erros.some((l) => l.includes("seed-superadmin-ausente")), "o operador precisa ser avisado");
});

test("a historical installation with a privileged 'admin' account is migrated without creating a second account", () => {
  db.prepare("DELETE FROM usuarios").run();
  db.prepare(
    "INSERT INTO usuarios (usuario, senhaHash, nome, isAdmin, nivel, podeControlar, ativo) VALUES ('admin', 'hash-historico', 'Administrador', 1, 3, 1, 1)"
  ).run();
  db.prepare(
    "INSERT INTO usuarios (usuario, senhaHash, nome, isAdmin, nivel, podeControlar, ativo) VALUES ('aluno', 'hash-aluno', 'Aluno', 0, 1, 1, 1)"
  ).run();

  iniciarServidor();

  const lista = privilegiadas();
  assert.equal(lista.length, 1);
  assert.equal(lista[0].usuario, "superadmin");
  assert.equal(lista[0].senhaHash, "hash-historico");
  assert.equal(contas().length, 2);
});

test("a regular user named 'admin' is never promoted or renamed by the migration", () => {
  db.prepare("DELETE FROM usuarios").run();
  db.prepare(
    "INSERT INTO usuarios (usuario, senhaHash, nome, isAdmin, nivel, podeControlar, ativo) VALUES ('gestor', 'hash-gestor', 'Gestor', 1, 3, 1, 1)"
  ).run();
  db.prepare(
    "INSERT INTO usuarios (usuario, senhaHash, nome, isAdmin, nivel, podeControlar, ativo) VALUES ('admin', 'hash-comum', 'Comum', 0, 1, 1, 1)"
  ).run();

  iniciarServidor();

  assert.equal(db.prepare("SELECT nivel, usuario FROM usuarios WHERE usuario = 'admin'").get().nivel, 1);
  assert.equal(db.prepare("SELECT id FROM usuarios WHERE usuario = 'superadmin'").get(), undefined);
  assert.equal(privilegiadas().length, 1);
  assert.equal(privilegiadas()[0].usuario, "gestor");
});

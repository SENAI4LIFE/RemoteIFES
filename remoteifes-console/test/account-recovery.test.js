const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { DatabaseSync } = require("node:sqlite");
const ajuda = require("./helpers");

// bin/recuperar-conta.js (Dados e recuperação > senha do superadministrador): the account is the
// level-3 one; with accounts but none at level 3, the superadmin login is promoted back or created,
// and an `admin` login that belongs to someone else is never touched.

function checkoutComBanco() {
  const checkout = ajuda.dirTemporario("console-recuperar-");
  const servidor = path.join(checkout, "remoteifes-server");
  fs.mkdirSync(path.join(servidor, "data"), { recursive: true });
  fs.writeFileSync(path.join(servidor, "package.json"), JSON.stringify({ version: "3.0.0" }));
  // A stand-in for the server's bcryptjs: the runner only needs hashSync.
  const bcrypt = path.join(servidor, "node_modules", "bcryptjs");
  fs.mkdirSync(bcrypt, { recursive: true });
  fs.writeFileSync(path.join(bcrypt, "index.js"), "module.exports = { hashSync: (s) => `teste:${s}` };\n");
  const banco = path.join(servidor, "data", "remoteifes.db");
  const db = new DatabaseSync(banco);
  db.exec(`
    CREATE TABLE usuarios (id INTEGER PRIMARY KEY AUTOINCREMENT, usuario TEXT UNIQUE NOT NULL, senhaHash TEXT NOT NULL,
      nome TEXT NOT NULL, isAdmin INTEGER NOT NULL DEFAULT 0, nivel INTEGER NOT NULL DEFAULT 1,
      podeControlar INTEGER NOT NULL DEFAULT 0, ativo INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE sessoes (id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT, usuarioId INTEGER, logout TEXT);
    INSERT INTO usuarios (usuario, senhaHash, nome, isAdmin, nivel) VALUES ('superadmin', 'antiga', 'Superadministrador', 1, 3);
    INSERT INTO usuarios (usuario, senhaHash, nome, isAdmin, nivel) VALUES ('admin', 'de-outra-pessoa', 'Outra pessoa', 1, 2);
  `);
  db.close();
  return { checkout, banco };
}

function recuperar(checkout, senha) {
  return spawnSync(process.execPath, [path.join(ajuda.RAIZ, "bin", "recuperar-conta.js")], {
    input: `${senha}\n`,
    encoding: "utf8",
    env: { ...process.env, CONSOLE_CHECKOUT_DIR: checkout, CONSOLE_ESTADO_DIR: ajuda.dirTemporario(), CONSOLE_SEM_PRIVILEGIO: "1" },
  });
}

function consultar(banco, sql) {
  const db = new DatabaseSync(banco);
  try {
    return db.prepare(sql).all().map((linha) => ({ ...linha }));
  } finally {
    db.close();
  }
}

test("account recovery resets the level-3 account and restores one when none is left", (t) => {
  const { checkout, banco } = checkoutComBanco();
  t.after(() => fs.rmSync(checkout, { recursive: true, force: true }));

  let r = recuperar(checkout, "senha-nova-console-1");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(consultar(banco, "SELECT usuario, nivel, senhaHash FROM usuarios WHERE nivel = 3"), [
    { usuario: "superadmin", nivel: 3, senhaHash: "teste:senha-nova-console-1" },
  ]);

  const db = new DatabaseSync(banco);
  db.exec("UPDATE usuarios SET nivel = 1, isAdmin = 0 WHERE usuario = 'superadmin'");
  db.close();
  r = recuperar(checkout, "senha-nova-console-2");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /voltou a ser o superadministrador/);
  assert.deepEqual(consultar(banco, "SELECT usuario, nivel, isAdmin FROM usuarios WHERE nivel = 3"), [{ usuario: "superadmin", nivel: 3, isAdmin: 1 }]);

  const db2 = new DatabaseSync(banco);
  db2.exec("DELETE FROM usuarios WHERE usuario = 'superadmin'");
  db2.close();
  r = recuperar(checkout, "senha-nova-console-3");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(consultar(banco, "SELECT usuario, nivel, senhaHash FROM usuarios WHERE nivel = 3"), [
    { usuario: "superadmin", nivel: 3, senhaHash: "teste:senha-nova-console-3" },
  ]);
  assert.deepEqual(consultar(banco, "SELECT nivel, senhaHash FROM usuarios WHERE usuario = 'admin'"), [
    { nivel: 2, senhaHash: "de-outra-pessoa" },
  ], "the admin login is left alone");
});

test("account recovery hashes with the server's own password module when the server has one", (t) => {
  const { checkout, banco } = checkoutComBanco();
  t.after(() => fs.rmSync(checkout, { recursive: true, force: true }));

  // A server that counts every byte of a password longer than bcrypt's 72 ships src/utils/senhas.js;
  // the runner uses it, and plain bcrypt only with an older server (the test above).
  const utils = path.join(checkout, "remoteifes-server", "src", "utils");
  fs.mkdirSync(utils, { recursive: true });
  fs.writeFileSync(path.join(utils, "senhas.js"), "module.exports = { gerarHash: (s) => `servidor:${s}` };\n");
  const longa = "frase-longa-".repeat(7);
  const r = recuperar(checkout, longa);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(consultar(banco, "SELECT senhaHash FROM usuarios WHERE nivel = 3"), [{ senhaHash: `servidor:${longa}` }]);
});

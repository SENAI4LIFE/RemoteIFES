const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const bcrypt = require("bcryptjs");

// npm run reset-admin is the emergency path for the superadministrator's password. The password can
// come from standard input (--stdin), which keeps it out of argv and shell history; argv and the
// no-argument reset keep working as before.

const RAIZ = path.join(__dirname, "..");

function rodar(caminhoBanco, argumentos, entrada) {
  return spawnSync(process.execPath, argumentos, {
    cwd: RAIZ,
    encoding: "utf8",
    input: entrada,
    env: { ...process.env, REMOTEIFES_DB_PATH: caminhoBanco, SENHA_ADMIN_INICIAL: "senha-inicial-do-teste" },
  });
}

function hashDoSuperadmin(caminhoBanco) {
  const r = rodar(caminhoBanco, ["-e", "process.stdout.write(require('./src/config/database').prepare('SELECT senhaHash FROM usuarios WHERE nivel = 3').get().senhaHash)"]);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

test("reset-admin takes the password from standard input with --stdin, keeps argv and the default reset, and never applies an invalid input", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remoteifes-reset-admin-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const banco = path.join(dir, "remoteifes.db");
  const criar = rodar(banco, ["-e", "require('./src/db/schema').criarSchema(); require('./src/db/seed').popularBanco();"]);
  assert.equal(criar.status, 0, criar.stderr);
  assert.ok(bcrypt.compareSync("senha-inicial-do-teste", hashDoSuperadmin(banco)));

  const viaEntrada = rodar(banco, ["reset-admin-senha.js", "--stdin"], "senha-pela-entrada-123\n");
  assert.equal(viaEntrada.status, 0, viaEntrada.stderr);
  assert.ok(bcrypt.compareSync("senha-pela-entrada-123", hashDoSuperadmin(banco)), "the trailing newline is not part of the password");
  assert.ok(!viaEntrada.stdout.includes("senha-pela-entrada-123"), "the password is not printed");

  for (const [entrada, motivo] of [["", "empty input"], ["\n", "only a newline"], ["curta\n", "too short"], ["x".repeat(200), "too long"], ["y".repeat(5000), "beyond the 4 KiB read bound"]]) {
    const recusada = rodar(banco, ["reset-admin-senha.js", "--stdin"], entrada);
    assert.equal(recusada.status, 1, `${motivo}: refused`);
    assert.ok(bcrypt.compareSync("senha-pela-entrada-123", hashDoSuperadmin(banco)), `${motivo}: nothing changed, no fallback to "admin"`);
  }

  const viaArgumento = rodar(banco, ["reset-admin-senha.js", "senha-pelo-argumento-456"]);
  assert.equal(viaArgumento.status, 0, viaArgumento.stderr);
  assert.ok(bcrypt.compareSync("senha-pelo-argumento-456", hashDoSuperadmin(banco)));

  const padrao = rodar(banco, ["reset-admin-senha.js"]);
  assert.equal(padrao.status, 0, padrao.stderr);
  assert.ok(bcrypt.compareSync("admin", hashDoSuperadmin(banco)), "without arguments the documented public default is restored");
});

test("a refused input does not even open the database", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remoteifes-reset-admin-"));
  try {
    const banco = path.join(dir, "subpasta", "remoteifes.db");
    for (const entrada of ["", "curta\n", "z".repeat(5000)]) {
      assert.equal(rodar(banco, ["reset-admin-senha.js", "--stdin"], entrada).status, 1);
    }
    assert.equal(fs.existsSync(path.join(dir, "subpasta")), false, "no directory or database file was created");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reset-admin accepts a CRLF line ending, lets --stdin win over a stray argument, and restores a missing level-3 account", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remoteifes-reset-admin-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const banco = path.join(dir, "remoteifes.db");
  assert.equal(rodar(banco, ["-e", "require('./src/db/schema').criarSchema(); require('./src/db/seed').popularBanco();"]).status, 0);
  const sql = (consulta) => {
    const r = rodar(banco, ["-e", `process.stdout.write(JSON.stringify(require('./src/config/database').prepare(${JSON.stringify(consulta)}).all()))`]);
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const executar = (consulta) => assert.equal(rodar(banco, ["-e", `require('./src/config/database').exec(${JSON.stringify(consulta)})`]).status, 0);

  assert.equal(rodar(banco, ["reset-admin-senha.js", "--stdin", "senha-do-argumento-1"], "senha-com-crlf-123\r\n").status, 0);
  assert.ok(bcrypt.compareSync("senha-com-crlf-123", hashDoSuperadmin(banco)), "stdin wins and CRLF is not part of the password");

  // Someone else's level-2 account named admin must never be touched.
  executar("INSERT INTO usuarios (usuario, senhaHash, nome, isAdmin, nivel, podeControlar, ativo) VALUES ('admin', 'x', 'Outra pessoa', 1, 2, 1, 1)");

  // Demoted: the superadmin login is promoted back.
  executar("UPDATE usuarios SET nivel = 1, isAdmin = 0 WHERE usuario = 'superadmin'");
  assert.equal(rodar(banco, ["reset-admin-senha.js", "--stdin"], "senha-restaurada-456\n").status, 0);
  assert.deepEqual(sql("SELECT usuario, nivel, isAdmin FROM usuarios WHERE nivel = 3"), [{ usuario: "superadmin", nivel: 3, isAdmin: 1 }]);
  assert.ok(bcrypt.compareSync("senha-restaurada-456", hashDoSuperadmin(banco)));

  // Deleted: it is created again.
  executar("DELETE FROM usuarios WHERE usuario = 'superadmin'");
  assert.equal(rodar(banco, ["reset-admin-senha.js", "--stdin"], "senha-recriada-789\n").status, 0);
  assert.deepEqual(sql("SELECT usuario, nivel FROM usuarios WHERE nivel = 3"), [{ usuario: "superadmin", nivel: 3 }]);
  assert.ok(bcrypt.compareSync("senha-recriada-789", hashDoSuperadmin(banco)));
  assert.deepEqual(sql("SELECT nivel, senhaHash FROM usuarios WHERE usuario = 'admin'"), [{ nivel: 2, senhaHash: "x" }], "the admin login is left alone");
});

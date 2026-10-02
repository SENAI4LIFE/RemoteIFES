const fs = require("fs");
const senhas = require("./src/utils/senhas");

// npm run reset-admin                    -> back to the public default "admin" (change it at once)
// npm run reset-admin -- <senha>         -> that password (it stays in shell history and in `ps`)
// ... | npm run reset-admin -- --stdin   -> the password read from standard input, never from argv;
//                                           an empty or invalid input changes nothing (no fallback)
//
// The account is the level-3 one, found by level and not by login (it may have been renamed). A
// database with accounts but none at level 3 gets one back: the `superadmin` login is promoted, or
// created when it does not exist. An `admin` login is never touched: after the automatic
// admin -> superadmin migration it belongs to someone else.

const argumentos = process.argv.slice(2);
let senhaFornecida = argumentos[0];
if (argumentos.includes("--stdin")) {
  // Read in chunks and stop past 4 KiB: a password never comes near it, and nothing larger is held.
  const LIMITE = 4096;
  const pedaco = Buffer.alloc(1024);
  const partes = [];
  let total = 0;
  try {
    for (;;) {
      let lidos;
      try {
        lidos = fs.readSync(0, pedaco, 0, pedaco.length, null);
      } catch (erro) {
        if (erro.code === "EAGAIN") {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
          continue;
        }
        if (erro.code === "EOF") break;
        throw erro;
      }
      if (lidos === 0) break;
      total += lidos;
      if (total > LIMITE) throw new Error("entrada maior que 4 KiB");
      partes.push(Buffer.from(pedaco.subarray(0, lidos)));
    }
  } catch (erro) {
    console.error(`Não foi possível ler a senha da entrada padrão: ${erro.message}; nada foi alterado.`);
    process.exit(1);
  }
  senhaFornecida = Buffer.concat(partes).toString("utf8").replace(/\r?\n$/, "");
  if (!senhaFornecida) {
    console.error("Nenhuma senha recebida pela entrada padrão; nada foi alterado.");
    process.exit(1);
  }
}
const novaSenha = senhaFornecida || "admin";
if ((senhaFornecida && novaSenha.length < 8) || novaSenha.length > 128) {
  console.error("A senha informada deve ter entre 8 e 128 caracteres.");
  process.exit(1);
}
// The database is opened only now, after the input was accepted: a refused input touches nothing.
const db = require("./src/config/database");
require("./src/db/schema").criarSchema();
const senhaHash = senhas.gerarHash(novaSenha);

if (Number(db.prepare("SELECT COUNT(*) n FROM usuarios").get().n) === 0) {
  console.log("Nenhuma conta neste banco — inicie o servidor uma vez (npm start) para criar o superadministrador.");
  process.exit(1);
}

const conta = db.prepare("SELECT id, usuario FROM usuarios WHERE nivel = 3 ORDER BY id LIMIT 1").get();
if (conta) {
  db.prepare("UPDATE usuarios SET senhaHash = ? WHERE id = ?").run(senhaHash, conta.id);
  db.prepare("UPDATE sessoes SET logout = datetime('now') WHERE usuarioId = ? AND logout IS NULL").run(conta.id);
  console.log(`Senha do usuario ${conta.usuario} redefinida.`);
} else {
  const existente = db.prepare("SELECT id FROM usuarios WHERE usuario = 'superadmin'").get();
  if (existente) {
    db.prepare("UPDATE usuarios SET senhaHash = ?, nivel = 3, isAdmin = 1, ativo = 1 WHERE id = ?").run(senhaHash, existente.id);
    db.prepare("UPDATE sessoes SET logout = datetime('now') WHERE usuarioId = ? AND logout IS NULL").run(existente.id);
    console.log("Nenhuma conta de nível 3: a conta superadmin voltou a ser o superadministrador, com a senha redefinida.");
  } else {
    db.prepare(`
      INSERT INTO usuarios (usuario, senhaHash, nome, isAdmin, nivel, podeControlar, ativo)
      VALUES ('superadmin', ?, 'Superadministrador', 1, 3, 1, 1)
    `).run(senhaHash);
    console.log("Nenhuma conta de nível 3: o superadministrador (login superadmin) foi recriado com a senha informada.");
  }
}

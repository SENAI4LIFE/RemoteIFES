const bcrypt = require("bcryptjs");
const db = require("./src/config/database");
const { criarSchema } = require("./src/db/schema");

criarSchema();

const senhaFornecida = process.argv[2];
const novaSenha = senhaFornecida || "admin";
if ((senhaFornecida && novaSenha.length < 8) || novaSenha.length > 128) {
  console.error("A senha informada deve ter entre 8 e 128 caracteres.");
  process.exit(1);
}
const senhaHash = bcrypt.hashSync(novaSenha, 10);

const conta =
  db.prepare("SELECT id, usuario FROM usuarios WHERE usuario = 'superadmin'").get() ||
  db.prepare("SELECT id, usuario FROM usuarios WHERE usuario = 'admin'").get();

if (!conta) {
  console.log("Nenhuma conta de superadministrador encontrada — inicie o servidor uma vez (npm start) para criá-la automaticamente.");
  process.exit(1);
}

db.prepare("UPDATE usuarios SET senhaHash = ? WHERE id = ?").run(senhaHash, conta.id);
db.prepare("UPDATE sessoes SET logout = datetime('now') WHERE usuarioId = ? AND logout IS NULL").run(conta.id);
console.log(`Senha do usuario ${conta.usuario} redefinida.`);

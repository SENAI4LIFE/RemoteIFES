const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const db = require("./src/config/database");
const { criarSchema } = require("./src/db/schema");

criarSchema();

const novaSenha = process.argv[2] || crypto.randomBytes(9).toString("base64url");
const senhaHash = bcrypt.hashSync(novaSenha, 10);

const conta =
  db.prepare("SELECT id, usuario FROM usuarios WHERE usuario = 'superadmin'").get() ||
  db.prepare("SELECT id, usuario FROM usuarios WHERE usuario = 'admin'").get();

if (!conta) {
  console.log("Nenhuma conta de superadministrador encontrada — inicie o servidor uma vez (npm start) para criá-la automaticamente.");
  process.exit(1);
}

db.prepare("UPDATE usuarios SET senhaHash = ? WHERE id = ?").run(senhaHash, conta.id);
console.log(`Senha do usuário ${conta.usuario} redefinida para: ${novaSenha}`);
console.log("Troque essa senha após o login em Admin > Usuários.");

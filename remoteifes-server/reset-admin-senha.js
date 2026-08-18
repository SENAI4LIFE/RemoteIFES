const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const db = require("./src/config/database");
const { criarSchema } = require("./src/db/schema");

criarSchema();

const novaSenha = process.argv[2] || crypto.randomBytes(9).toString("base64url");
const senhaHash = bcrypt.hashSync(novaSenha, 10);

const admin = db.prepare("SELECT id FROM usuarios WHERE usuario = ?").get("admin");

if (!admin) {
  console.log("Nenhum usuário 'admin' encontrado no banco — inicie o servidor uma vez (npm start) para criá-lo automaticamente.");
  process.exit(1);
}

db.prepare("UPDATE usuarios SET senhaHash = ? WHERE id = ?").run(senhaHash, admin.id);
console.log(`Senha do usuário admin redefinida para: ${novaSenha}`);
console.log("Troque essa senha após o login em Admin > Usuários.");

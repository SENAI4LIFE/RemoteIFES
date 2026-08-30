const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const db = require("../config/database");

const SALAS_CAMPUS = require("./salasCampus");

function popularSalas() {
  const inserir = db.prepare(`
    INSERT OR IGNORE INTO salas (sala, nome, bloco, andar, online, ligado, temperatura, temperaturaAlvo)
    VALUES (?, ?, ?, ?, 0, 0, 24, 23)
  `);

  let criadas = 0;
  db.exec("BEGIN");
  try {
    SALAS_CAMPUS.forEach((s) => {
      const resultado = inserir.run(s.codigo, s.nome, s.bloco, s.andar);
      if (resultado.changes > 0) criadas += 1;
    });
    db.exec("COMMIT");
  } catch (erro) {
    db.exec("ROLLBACK");
    throw erro;
  }
  if (criadas > 0) {
    console.log(`Seed: ${criadas} salas criadas a partir da planta baixa do campus (todas offline).`);
  }
}

function popularAdmin() {
  const existe = db.prepare("SELECT id FROM usuarios WHERE usuario = ?").get("superadmin");
  if (existe) return;

  const senhaConfigurada = process.env.SENHA_ADMIN_INICIAL;
  const senhaInicial = senhaConfigurada || (
    process.env.NODE_ENV === "production"
      ? crypto.randomBytes(18).toString("base64url")
      : "admin"
  );
  if (process.env.NODE_ENV === "production" && senhaInicial.length < 8) {
    throw new Error("SENHA_ADMIN_INICIAL deve ter ao menos 8 caracteres em produção");
  }
  const senhaHash = bcrypt.hashSync(senhaInicial, 10);
  db.prepare(`
    INSERT INTO usuarios (usuario, senhaHash, nome, isAdmin, nivel, podeControlar, ativo)
    VALUES ('superadmin', ?, 'Superadministrador', 1, 3, 1, 1)
  `).run(senhaHash);

  console.log(`Seed: usuário superadmin criado (usuario: superadmin / senha: ${senhaInicial}) — troque a senha após o primeiro acesso.`);
}

function popularBanco() {
  popularSalas();
  popularAdmin();
}

module.exports = { popularBanco };

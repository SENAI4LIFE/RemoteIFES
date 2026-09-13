const bcrypt = require("bcryptjs");
const db = require("../config/database");
const logger = require("../utils/logger");

const SALAS_CAMPUS = require("./salasCampus");

const NIVEL_SUPERADMIN = 3;

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
  const privilegiada = db.prepare("SELECT id FROM usuarios WHERE nivel = ? LIMIT 1").get(NIVEL_SUPERADMIN);
  if (privilegiada) return;

  const totalContas = Number(db.prepare("SELECT COUNT(*) n FROM usuarios").get().n);
  if (totalContas > 0) {
    logger.error("seed-superadmin-ausente", {
      contas: totalContas,
      acao: "nenhuma conta padrão foi criada; use 'npm run reset-admin' para restabelecer o superadministrador",
    });
    return;
  }

  const senhaConfigurada = String(process.env.SENHA_ADMIN_INICIAL || "").trim();
  const senhaInicial = senhaConfigurada || "admin";
  const senhaHash = bcrypt.hashSync(senhaInicial, 10);
  db.prepare(`
    INSERT INTO usuarios (usuario, senhaHash, nome, isAdmin, nivel, podeControlar, ativo)
    VALUES ('superadmin', ?, 'Superadministrador', 1, ?, 1, 1)
  `).run(senhaHash, NIVEL_SUPERADMIN);
  console.log("Seed: usuario superadmin criado.");
}

function popularBanco() {
  popularSalas();
  popularAdmin();
}

module.exports = { popularBanco };

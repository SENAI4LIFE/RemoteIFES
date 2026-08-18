const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const db = require("../config/database");
const presetsService = require("../services/presetsService");
const configuracoesService = require("../services/configuracoesService");

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
  const existe = db.prepare("SELECT id FROM usuarios WHERE usuario = ?").get("admin");
  if (existe) return;

  const senhaInicial = process.env.SENHA_ADMIN_INICIAL || crypto.randomBytes(9).toString("base64url");
  const senhaHash = bcrypt.hashSync(senhaInicial, 10);
  db.prepare(`
    INSERT INTO usuarios (usuario, senhaHash, nome, isAdmin, nivel, podeControlar, ativo)
    VALUES ('admin', ?, 'Administrador', 1, 3, 1, 1)
  `).run(senhaHash);

  console.log(`Seed: usuário admin criado (usuario: admin / senha: ${senhaInicial}) — troque a senha após o primeiro acesso.`);
}

function popularPresetPadrao() {
  const limites = configuracoesService.limitesTemperatura();
  const preset = presetsService.seedPresetPadrao(limites);

  db.prepare(`UPDATE salas SET presetId = ? WHERE presetId IS NULL`).run(preset.id);
}

function popularBanco() {
  popularSalas();
  popularAdmin();
  popularPresetPadrao();
}

module.exports = { popularBanco };

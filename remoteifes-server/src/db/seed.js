const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const db = require("../config/database");
const presetsService = require("../services/presetsService");
const configuracoesService = require("../services/configuracoesService");

const BLOCOS = ["A", "B"];
const ANDARES = [1, 2, 3];
const SALAS_POR_ANDAR = 3;

const CAMPUS_LATITUDE = -20.6809;
const CAMPUS_LONGITUDE = -40.4967;

function popularSalas() {
  const total = db.prepare("SELECT COUNT(*) AS n FROM salas").get().n;
  if (total > 0) return;

  const inserir = db.prepare(`
    INSERT INTO salas (sala, nome, bloco, andar, online, ligado, temperatura, temperaturaAlvo, latitude, longitude)
    VALUES (?, ?, ?, ?, 0, 0, 24, 23, ?, ?)
  `);

  db.exec("BEGIN");
  try {
    BLOCOS.forEach((bloco, blocoIdx) => {
      ANDARES.forEach((andar) => {
        for (let n = 1; n <= SALAS_POR_ANDAR; n++) {
          const codigo = `${bloco}${andar}0${n}`;
          const nome = `Sala ${codigo}`;
          const latitude = CAMPUS_LATITUDE + blocoIdx * 0.0006 + (andar - 1) * 0.00012;
          const longitude = CAMPUS_LONGITUDE + (n - 1) * 0.00018;
          inserir.run(codigo, nome, bloco, andar, latitude, longitude);
        }
      });
    });
    db.exec("COMMIT");
  } catch (erro) {
    db.exec("ROLLBACK");
    throw erro;
  }
  console.log(`Seed: ${BLOCOS.length * ANDARES.length * SALAS_POR_ANDAR} salas criadas (todas offline).`);
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

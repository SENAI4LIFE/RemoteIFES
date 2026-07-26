const bcrypt = require("bcryptjs");
const db = require("../config/database");

const BLOCOS = ["A", "B"];
const ANDARES = [1, 2, 3];
const SALAS_POR_ANDAR = 3;
const ONLINE_INICIAL = ["A101", "B201"];

function popularSalas() {
  const total = db.prepare("SELECT COUNT(*) AS n FROM salas").get().n;
  if (total > 0) return;

  const inserir = db.prepare(`
    INSERT INTO salas (sala, nome, bloco, andar, online, ligado, temperatura, temperaturaAlvo)
    VALUES (?, ?, ?, ?, ?, 0, 24, 23)
  `);

  const inserirVarias = db.transaction(() => {
    for (const bloco of BLOCOS) {
      for (const andar of ANDARES) {
        for (let n = 1; n <= SALAS_POR_ANDAR; n++) {
          const codigo = `${bloco}${andar}0${n}`;
          const nome = `Sala ${codigo}`;
          const online = ONLINE_INICIAL.includes(codigo) ? 1 : 0;
          inserir.run(codigo, nome, bloco, andar, online);
        }
      }
    }
  });

  inserirVarias();
  console.log(`Seed: ${BLOCOS.length * ANDARES.length * SALAS_POR_ANDAR} salas criadas.`);
}

function popularAdmin() {
  const existe = db.prepare("SELECT id FROM usuarios WHERE usuario = ?").get("admin");
  if (existe) return;

  const senhaHash = bcrypt.hashSync("admin", 10);
  db.prepare(`
    INSERT INTO usuarios (usuario, senhaHash, nome, isAdmin, podeControlar, podeAgendar, ativo)
    VALUES ('admin', ?, 'Administrador', 1, 1, 1, 1)
  `).run(senhaHash);

  console.log("Seed: usuário admin criado (usuario: admin / senha: admin) — troque a senha após o primeiro acesso.");
}

function popularBanco() {
  popularSalas();
  popularAdmin();
}

module.exports = { popularBanco };

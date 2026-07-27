const db = require("../config/database");

function criarSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario TEXT NOT NULL UNIQUE,
      senha TEXT NOT NULL,
      senhaHash TEXT NOT NULL,
      nome TEXT NOT NULL,
      isAdmin INTEGER NOT NULL DEFAULT 0,
      nivel INTEGER NOT NULL DEFAULT 1,
      podeControlar INTEGER NOT NULL DEFAULT 1,
      podeAgendar INTEGER NOT NULL DEFAULT 1,
      ativo INTEGER NOT NULL DEFAULT 1,
      criadoEm TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS salas (
      sala TEXT PRIMARY KEY,
      nome TEXT NOT NULL,
      bloco TEXT NOT NULL,
      andar INTEGER NOT NULL,
      online INTEGER NOT NULL DEFAULT 0,
      ligado INTEGER NOT NULL DEFAULT 0,
      temperatura REAL NOT NULL DEFAULT 24,
      temperaturaAlvo INTEGER NOT NULL DEFAULT 23,
      ipEsp32 TEXT,
      ultimoHeartbeat TEXT,
      atualizadoEm TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS esp_eventos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sala TEXT NOT NULL REFERENCES salas(sala),
      status TEXT NOT NULL,
      criadoEm TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS agendamentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sala TEXT NOT NULL REFERENCES salas(sala),
      usuarioId INTEGER NOT NULL REFERENCES usuarios(id),
      diasSemana TEXT NOT NULL,
      horaInicio TEXT NOT NULL,
      horaFim TEXT NOT NULL,
      temperatura INTEGER NOT NULL,
      modo TEXT NOT NULL DEFAULT 'ligar_completo',
      ligarInicio TEXT,
      ligarFim TEXT,
      ativo INTEGER NOT NULL DEFAULT 1,
      criadoEm TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS agendamentos_execucoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agendamentoId INTEGER NOT NULL REFERENCES agendamentos(id),
      tipo TEXT NOT NULL,
      executadoEm TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS comandos_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario TEXT,
      sala TEXT NOT NULL,
      cmd TEXT NOT NULL,
      valor TEXT,
      origem TEXT NOT NULL,
      criadoEm TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL UNIQUE,
      usuarioId INTEGER NOT NULL REFERENCES usuarios(id),
      login TEXT NOT NULL DEFAULT (datetime('now')),
      logout TEXT,
      ultimoUso TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  migrarColunasUsuarios();
}

function migrarColunasUsuarios() {
  const colunas = db.prepare(`PRAGMA table_info(usuarios)`).all().map((c) => c.name);
  if (!colunas.includes("nivel")) {
    db.exec(`ALTER TABLE usuarios ADD COLUMN nivel INTEGER NOT NULL DEFAULT 1`);
    db.exec(`UPDATE usuarios SET nivel = 2 WHERE isAdmin = 1`);
  }
}

module.exports = { criarSchema };

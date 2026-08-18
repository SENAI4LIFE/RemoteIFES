const db = require("../config/database");

function criarSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario TEXT NOT NULL UNIQUE,
      senhaHash TEXT NOT NULL,
      nome TEXT NOT NULL,
      isAdmin INTEGER NOT NULL DEFAULT 0,
      nivel INTEGER NOT NULL DEFAULT 1,
      podeControlar INTEGER NOT NULL DEFAULT 1,
      ativo INTEGER NOT NULL DEFAULT 1,
      criadoEm TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS presets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL UNIQUE,
      padrao INTEGER NOT NULL DEFAULT 0,
      criadoEm TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS preset_funcoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      presetId INTEGER NOT NULL REFERENCES presets(id) ON DELETE CASCADE,
      chave TEXT NOT NULL,
      rotulo TEXT NOT NULL,
      tipo TEXT NOT NULL DEFAULT 'numero',
      opcoes TEXT,
      ordem INTEGER NOT NULL DEFAULT 0,
      UNIQUE(presetId, chave)
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
      mac TEXT,
      presetId INTEGER REFERENCES presets(id),
      latitude REAL,
      longitude REAL,
      acessoRestrito INTEGER NOT NULL DEFAULT 0,
      ultimoHeartbeat TEXT,
      atualizadoEm TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sala_acessos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sala TEXT NOT NULL REFERENCES salas(sala),
      usuarioId INTEGER NOT NULL REFERENCES usuarios(id),
      criadoEm TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(sala, usuarioId)
    );

    CREATE TABLE IF NOT EXISTS esp_detectados (
      mac TEXT PRIMARY KEY,
      ip TEXT,
      sala TEXT,
      primeiraDeteccao TEXT NOT NULL DEFAULT (datetime('now')),
      ultimaDeteccao TEXT NOT NULL DEFAULT (datetime('now'))
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
      data TEXT NOT NULL,
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

    CREATE TABLE IF NOT EXISTS esp_acessos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sala TEXT NOT NULL REFERENCES salas(sala),
      ip TEXT,
      userAgent TEXT,
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

    CREATE TABLE IF NOT EXISTS configuracoes (
      chave TEXT PRIMARY KEY,
      valor TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_salas_mac ON salas(mac) WHERE mac IS NOT NULL;
  `);

  migrarColunasUsuarios();
  migrarColunasAgendamentos();
  migrarColunasSalas();
}

function migrarColunasUsuarios() {
  const colunas = db.prepare(`PRAGMA table_info(usuarios)`).all().map((c) => c.name);
  if (!colunas.includes("nivel")) {
    db.exec(`ALTER TABLE usuarios ADD COLUMN nivel INTEGER NOT NULL DEFAULT 1`);
    db.exec(`UPDATE usuarios SET nivel = 2 WHERE isAdmin = 1`);
  }
  if (colunas.includes("senha")) {
    try {
      db.exec(`ALTER TABLE usuarios DROP COLUMN senha`);
    } catch (erro) {
      db.exec(`UPDATE usuarios SET senha = '' WHERE senha IS NOT NULL AND senha != ''`);
    }
  }
  if (colunas.includes("podeAgendar")) {
    try {
      db.exec(`ALTER TABLE usuarios DROP COLUMN podeAgendar`);
    } catch (erro) {}
  }
}

function migrarColunasAgendamentos() {
  const colunas = db.prepare(`PRAGMA table_info(agendamentos)`).all().map((c) => c.name);
  if (!colunas.includes("data")) {
    db.exec(`ALTER TABLE agendamentos ADD COLUMN data TEXT`);
    if (colunas.includes("dataUnica")) {
      db.exec(`UPDATE agendamentos SET data = dataUnica WHERE dataUnica IS NOT NULL`);
    }
    db.exec(`DELETE FROM agendamentos WHERE data IS NULL`);
  }
  for (const antiga of ["diasSemana", "repeticao", "dataUnica"]) {
    if (colunas.includes(antiga)) {
      try {
        db.exec(`ALTER TABLE agendamentos DROP COLUMN ${antiga}`);
      } catch (erro) {}
    }
  }
}

function migrarColunasSalas() {
  const colunas = db.prepare(`PRAGMA table_info(salas)`).all().map((c) => c.name);
  if (!colunas.includes("mac")) {
    db.exec(`ALTER TABLE salas ADD COLUMN mac TEXT`);
  }
  if (!colunas.includes("presetId")) {
    db.exec(`ALTER TABLE salas ADD COLUMN presetId INTEGER REFERENCES presets(id)`);
  }
  if (!colunas.includes("latitude")) {
    db.exec(`ALTER TABLE salas ADD COLUMN latitude REAL`);
  }
  if (!colunas.includes("longitude")) {
    db.exec(`ALTER TABLE salas ADD COLUMN longitude REAL`);
  }
  if (!colunas.includes("acessoRestrito")) {
    db.exec(`ALTER TABLE salas ADD COLUMN acessoRestrito INTEGER NOT NULL DEFAULT 0`);
  }
}

module.exports = { criarSchema };

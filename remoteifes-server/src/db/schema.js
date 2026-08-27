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

    CREATE TABLE IF NOT EXISTS salas (
      sala TEXT PRIMARY KEY,
      nome TEXT NOT NULL,
      bloco TEXT NOT NULL,
      andar INTEGER NOT NULL,
      online INTEGER NOT NULL DEFAULT 0,
      ligado INTEGER NOT NULL DEFAULT 0,
      temperatura REAL NOT NULL DEFAULT 24,
      temperaturaAlvo INTEGER NOT NULL DEFAULT 23,
      temperaturaMinima REAL,
      temperaturaMaxima REAL,
      turboAtivo INTEGER NOT NULL DEFAULT 0,
      irProtocolo INTEGER,
      ipEsp32 TEXT,
      mac TEXT,
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

    CREATE TABLE IF NOT EXISTS sala_donos (
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
      dataExecucao TEXT,
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

    CREATE TABLE IF NOT EXISTS notificacoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo TEXT NOT NULL,
      sala TEXT,
      mensagem TEXT NOT NULL,
      lida INTEGER NOT NULL DEFAULT 0,
      criadoEm TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS relatos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuarioId INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
      usuarioNome TEXT,
      usuarioLogin TEXT,
      titulo TEXT NOT NULL,
      descricao TEXT NOT NULL,
      categoria TEXT NOT NULL DEFAULT 'outro',
      sala TEXT,
      pagina TEXT,
      contexto TEXT,
      status TEXT NOT NULL DEFAULT 'novo',
      resposta TEXT,
      revisadoPor INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
      revisadoEm TEXT,
      criadoEm TEXT NOT NULL DEFAULT (datetime('now')),
      atualizadoEm TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_relatos_status ON relatos(status);
    CREATE INDEX IF NOT EXISTS idx_relatos_usuario ON relatos(usuarioId);
    CREATE INDEX IF NOT EXISTS idx_relatos_criado ON relatos(criadoEm);

  `);

  migrarColunasUsuarios();
  migrarColunasAgendamentos();
  migrarColunasAgendamentosExecucoes();
  migrarColunasSalas();
  removerTabelasObsoletas();
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_salas_mac ON salas(mac) WHERE mac IS NOT NULL`);
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

function migrarColunasAgendamentosExecucoes() {
  const colunas = db.prepare(`PRAGMA table_info(agendamentos_execucoes)`).all().map((c) => c.name);
  if (!colunas.includes("dataExecucao")) {
    db.exec(`ALTER TABLE agendamentos_execucoes ADD COLUMN dataExecucao TEXT`);
  }
}

function migrarColunasSalas() {
  let colunas = db.prepare(`PRAGMA table_info(salas)`).all().map((c) => c.name);
  if (!colunas.includes("mac")) {
    db.exec(`ALTER TABLE salas ADD COLUMN mac TEXT`);
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
  if (!colunas.includes("temperaturaMinima")) {
    db.exec(`ALTER TABLE salas ADD COLUMN temperaturaMinima REAL`);
  }
  if (!colunas.includes("temperaturaMaxima")) {
    db.exec(`ALTER TABLE salas ADD COLUMN temperaturaMaxima REAL`);
  }
  if (!colunas.includes("turboAtivo")) {
    db.exec(`ALTER TABLE salas ADD COLUMN turboAtivo INTEGER NOT NULL DEFAULT 0`);
  }
  if (!colunas.includes("irProtocolo")) {
    db.exec(`ALTER TABLE salas ADD COLUMN irProtocolo INTEGER`);
  }
  colunas = db.prepare(`PRAGMA table_info(salas)`).all().map((c) => c.name);
  if (colunas.includes("presetId") || colunas.includes("funcoesEstado")) {
    recriarTabelaSalas();
  }
}

function recriarTabelaSalas() {
  db.exec(`PRAGMA foreign_keys = OFF`);
  try {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE salas_nova (
        sala TEXT PRIMARY KEY,
        nome TEXT NOT NULL,
        bloco TEXT NOT NULL,
        andar INTEGER NOT NULL,
        online INTEGER NOT NULL DEFAULT 0,
        ligado INTEGER NOT NULL DEFAULT 0,
        temperatura REAL NOT NULL DEFAULT 24,
        temperaturaAlvo INTEGER NOT NULL DEFAULT 23,
        temperaturaMinima REAL,
        temperaturaMaxima REAL,
        turboAtivo INTEGER NOT NULL DEFAULT 0,
        irProtocolo INTEGER,
        ipEsp32 TEXT,
        mac TEXT,
        latitude REAL,
        longitude REAL,
        acessoRestrito INTEGER NOT NULL DEFAULT 0,
        ultimoHeartbeat TEXT,
        atualizadoEm TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO salas_nova (
        sala, nome, bloco, andar, online, ligado, temperatura, temperaturaAlvo,
        temperaturaMinima, temperaturaMaxima, turboAtivo, irProtocolo, ipEsp32,
        mac, latitude, longitude, acessoRestrito, ultimoHeartbeat, atualizadoEm
      )
      SELECT
        sala, nome, bloco, andar, online, ligado, temperatura, temperaturaAlvo,
        temperaturaMinima, temperaturaMaxima, turboAtivo, irProtocolo, ipEsp32,
        mac, latitude, longitude, acessoRestrito, ultimoHeartbeat, atualizadoEm
      FROM salas;
      DROP TABLE salas;
      ALTER TABLE salas_nova RENAME TO salas;
      COMMIT;
    `);
  } catch (erro) {
    try {
      db.exec(`ROLLBACK`);
    } catch (rollbackErro) {}
    throw erro;
  } finally {
    db.exec(`PRAGMA foreign_keys = ON`);
  }

  const inconsistencias = db.prepare(`PRAGMA foreign_key_check`).all();
  if (inconsistencias.length > 0) {
    throw new Error("migração de salas deixou referências inválidas");
  }
}

function removerTabelasObsoletas() {
  db.exec(`DROP TABLE IF EXISTS preset_funcoes`);
  db.exec(`DROP TABLE IF EXISTS presets`);
  db.exec(`DROP TABLE IF EXISTS dispositivo_tokens`);
}

module.exports = { criarSchema };

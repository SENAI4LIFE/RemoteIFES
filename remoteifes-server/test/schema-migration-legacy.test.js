const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "remoteifes-schema-legado-"));
const dbPath = path.join(tmp, "inicial.db");

const legado = new DatabaseSync(dbPath);
legado.exec(`
  CREATE TABLE usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario TEXT NOT NULL UNIQUE,
    senha TEXT,
    senhaHash TEXT NOT NULL,
    nome TEXT NOT NULL,
    isAdmin INTEGER NOT NULL DEFAULT 0,
    podeControlar INTEGER NOT NULL DEFAULT 1,
    podeAgendar INTEGER NOT NULL DEFAULT 1,
    ativo INTEGER NOT NULL DEFAULT 1,
    criadoEm TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE salas (
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
  CREATE TABLE esp_eventos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sala TEXT NOT NULL REFERENCES salas(sala),
    status TEXT NOT NULL,
    criadoEm TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE agendamentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sala TEXT NOT NULL REFERENCES salas(sala),
    usuarioId INTEGER NOT NULL REFERENCES usuarios(id),
    diasSemana TEXT,
    repeticao TEXT,
    dataUnica TEXT,
    horaInicio TEXT NOT NULL,
    horaFim TEXT NOT NULL,
    temperatura INTEGER NOT NULL,
    modo TEXT NOT NULL DEFAULT 'ligar_completo',
    ligarInicio TEXT,
    ligarFim TEXT,
    ativo INTEGER NOT NULL DEFAULT 1,
    criadoEm TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE agendamentos_execucoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agendamentoId INTEGER NOT NULL REFERENCES agendamentos(id),
    tipo TEXT NOT NULL,
    executadoEm TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE comandos_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario TEXT,
    sala TEXT NOT NULL,
    cmd TEXT NOT NULL,
    valor TEXT,
    origem TEXT NOT NULL,
    criadoEm TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE sessoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL UNIQUE,
    usuarioId INTEGER NOT NULL REFERENCES usuarios(id),
    login TEXT NOT NULL DEFAULT (datetime('now')),
    logout TEXT,
    ultimoUso TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE configuracoes (chave TEXT PRIMARY KEY, valor TEXT);
  CREATE TABLE presets (id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL);
  CREATE TABLE preset_funcoes (id INTEGER PRIMARY KEY AUTOINCREMENT, presetId INTEGER NOT NULL REFERENCES presets(id), nome TEXT);

  INSERT INTO usuarios (usuario, senha, senhaHash, nome, isAdmin) VALUES ('admin', 'texto-claro', 'hash-admin', 'Administrador', 1);
  INSERT INTO usuarios (usuario, senha, senhaHash, nome, isAdmin) VALUES ('professor', '', 'hash-prof', 'Professor', 0);
  INSERT INTO salas (sala, nome, bloco, andar, ligado, temperaturaAlvo) VALUES ('A-101', 'Sala 101', 'A', 1, 1, 22);
  INSERT INTO agendamentos (sala, usuarioId, dataUnica, horaInicio, horaFim, temperatura) VALUES ('A-101', 1, '2026-01-05', '08:00', '10:00', 23);
  INSERT INTO agendamentos (sala, usuarioId, diasSemana, horaInicio, horaFim, temperatura) VALUES ('A-101', 1, '1,2,3', '13:00', '15:00', 24);
  INSERT INTO agendamentos_execucoes (agendamentoId, tipo) VALUES (1, 'ligar');
  INSERT INTO agendamentos_execucoes (agendamentoId, tipo) VALUES (2, 'ligar');
  INSERT INTO comandos_log (usuario, sala, cmd, valor, origem) VALUES ('admin', 'A-101', 'ligar', NULL, 'manual');
  INSERT INTO sessoes (token, usuarioId) VALUES ('tok', 1);
`);
legado.close();

process.env.REMOTEIFES_DB_PATH = dbPath;
process.env.NODE_ENV = "test";

const db = require("../src/config/database");
const { criarSchema } = require("../src/db/schema");
const { popularBanco } = require("../src/db/seed");

test.after(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("a database in the first-release format migrates without error: columns before the indexes that depend on them", () => {
  assert.doesNotThrow(() => criarSchema());
  const colunasAg = db.prepare("PRAGMA table_info(agendamentos)").all().map((c) => c.name);
  const colunasEx = db.prepare("PRAGMA table_info(agendamentos_execucoes)").all().map((c) => c.name);
  assert.ok(colunasAg.includes("data"));
  assert.ok(colunasEx.includes("dataExecucao"));
  for (const indice of ["idx_agendamentos_data", "idx_ag_execucoes_ag_tipo_data", "idx_salas_mac", "idx_sessoes_logout", "idx_mon_amostras_criado"]) {
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(indice), `index ${indice} missing`);
  }
});

test("historical data is preserved and the privileged account is not duplicated", () => {
  popularBanco();
  const sala = db.prepare("SELECT * FROM salas WHERE sala = 'A-101'").get();
  assert.equal(sala.nome, "Sala 101");
  assert.equal(sala.ligado, 1);
  assert.equal(sala.temperaturaAlvo, 22);
  assert.equal(sala.mac, null);
  assert.equal(sala.fwVersao, null);

  const datado = db.prepare("SELECT * FROM agendamentos WHERE horaInicio = '08:00'").get();
  assert.equal(datado.data, "2026-01-05");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM agendamentos").get().n, 1, "a schedule without a date cannot be represented and is removed with its executions");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM agendamentos_execucoes").get().n, 1);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);

  const contas = db.prepare("SELECT usuario, nivel, senhaHash FROM usuarios ORDER BY id").all();
  assert.deepEqual(contas.map((c) => c.usuario), ["superadmin", "professor"]);
  assert.equal(contas[0].nivel, 3, "the bootstrap account from before levels is the superadministrator");
  assert.equal(contas[1].nivel, 1);
  assert.equal(contas[0].senhaHash, "hash-admin");
  assert.ok(!db.prepare("PRAGMA table_info(usuarios)").all().some((c) => c.name === "senha"));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM usuarios").get().n, 2);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('presets', 'preset_funcoes')").all().length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM comandos_log").get().n, 1);
});

test("running the migration again is idempotent", () => {
  assert.doesNotThrow(() => criarSchema());
  assert.doesNotThrow(() => popularBanco());
  assert.equal(db.prepare("SELECT COUNT(*) n FROM usuarios").get().n, 2);
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
});

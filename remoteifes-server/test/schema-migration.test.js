const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "remoteifes-schema-migration-"));
const dbPath = path.join(tmp, "legacy.db");

const legacy = new DatabaseSync(dbPath);
legacy.exec(`
  CREATE TABLE salas (
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
    atualizadoEm TEXT NOT NULL DEFAULT (datetime('now')),
    presetId INTEGER,
    funcoesEstado TEXT
  );
  INSERT INTO salas (
    sala, nome, bloco, andar, online, ligado, temperatura, temperaturaAlvo,
    temperaturaMinima, temperaturaMaxima, turboAtivo, irProtocolo, ipEsp32,
    mac, latitude, longitude, acessoRestrito, ultimoHeartbeat, presetId, funcoesEstado
  ) VALUES (
    'LEGACY-1', 'Sala legada', 'L', 1, 1, 1, 22.5, 24,
    18, 27, 1, 1, '192.0.2.10', 'AA:BB:CC:DD:EE:01', -20.1, -40.2, 1,
    '2026-08-29 12:00:00', 7, '{}'
  );
`);
legacy.close();

process.env.REMOTEIFES_DB_PATH = dbPath;
process.env.NODE_ENV = "test";

const db = require("../src/config/database");
const { criarSchema } = require("../src/db/schema");

test.after(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("migração da tabela legada de salas preserva dados e cria fwVersao", () => {
  criarSchema();

  const colunas = db.prepare("PRAGMA table_info(salas)").all().map((c) => c.name);
  assert.ok(colunas.includes("fwVersao"));
  assert.ok(!colunas.includes("presetId"));
  assert.ok(!colunas.includes("funcoesEstado"));

  const sala = db.prepare("SELECT * FROM salas WHERE sala = ?").get("LEGACY-1");
  assert.equal(sala.nome, "Sala legada");
  assert.equal(sala.mac, "AA:BB:CC:DD:EE:01");
  assert.equal(sala.irProtocolo, 1);
  assert.equal(sala.fwVersao, null);

  db.prepare("UPDATE salas SET fwVersao = ? WHERE sala = ?").run("4.0.0", "LEGACY-1");
  assert.equal(db.prepare("SELECT fwVersao FROM salas WHERE sala = ?").get("LEGACY-1").fwVersao, "4.0.0");
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

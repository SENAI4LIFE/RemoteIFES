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
  CREATE TABLE protocolos_ir (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL COLLATE NOCASE UNIQUE,
    isKnown INTEGER NOT NULL DEFAULT 0,
    protocolId INTEGER,
    protocol TEXT,
    hex TEXT,
    rawJson TEXT NOT NULL,
    carrierHz INTEGER NOT NULL DEFAULT 38000,
    origemSala TEXT,
    criadoEm TEXT NOT NULL DEFAULT (datetime('now')),
    atualizadoEm TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT INTO protocolos_ir (label, isKnown, protocolId, protocol, rawJson, carrierHz, origemSala)
  VALUES ('Legado IR', 1, 5, 'DAIKIN', '[9000,4500,560,560]', 38000, 'LEGACY-1');
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
  assert.ok(colunas.includes("irProtocoloRegistroId"));
  assert.ok(!colunas.includes("presetId"));
  assert.ok(!colunas.includes("funcoesEstado"));

  const sala = db.prepare("SELECT * FROM salas WHERE sala = ?").get("LEGACY-1");
  assert.equal(sala.nome, "Sala legada");
  assert.equal(sala.mac, "AA:BB:CC:DD:EE:01");
  assert.equal(sala.irProtocolo, 1);
  assert.equal(sala.irProtocoloRegistroId, null);
  assert.equal(sala.fwVersao, null);

  db.prepare("UPDATE salas SET fwVersao = ? WHERE sala = ?").run("4.0.0", "LEGACY-1");
  assert.equal(db.prepare("SELECT fwVersao FROM salas WHERE sala = ?").get("LEGACY-1").fwVersao, "4.0.0");
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'auditoria_eventos'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'esp_indisponibilidades'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_auditoria_criado'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_esp_indisp_aberta'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'energia_configuracoes'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'energia_estados'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'energia_resumos_diarios'").get());
});

test("a biblioteca de protocolos IR ganha as colunas de failsafe e origem sem perder registros anteriores", () => {
  const colunas = db.prepare("PRAGMA table_info(protocolos_ir)").all().map((c) => c.name);
  for (const coluna of ["failsafeRawJson", "failsafeCarrierHz", "failsafeAtualizadoEm", "origemMac"]) {
    assert.ok(colunas.includes(coluna), `coluna ${coluna} ausente após a migração`);
  }
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_protocolos_ir_criado'").get());
  const legado = db.prepare("SELECT * FROM protocolos_ir WHERE label = 'Legado IR'").get();
  assert.equal(legado.protocolId, 5);
  assert.equal(legado.failsafeRawJson, null);
  assert.equal(legado.origemMac, null);

  const protocolos = require("../src/services/protocolosIrService");
  const publico = protocolos.buscar(legado.id);
  assert.deepEqual(publico.raw, [9000, 4500, 560, 560]);
  assert.equal(publico.failsafe, null);
  assert.deepEqual(publico.salas, []);

  db.prepare("UPDATE salas SET irProtocoloRegistroId = ? WHERE sala = 'LEGACY-1'").run(legado.id);
  assert.deepEqual(protocolos.salasAtribuidas(legado.id), ["LEGACY-1"]);
  assert.throws(() => db.prepare("INSERT INTO protocolos_ir (label, rawJson) VALUES ('legado ir', '[1]')").run(), /UNIQUE/);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("a conta padrão 'admin' é migrada para 'superadmin' preservando id, nível e hash", () => {
  db.prepare("DELETE FROM usuarios").run();
  const info = db
    .prepare(
      "INSERT INTO usuarios (usuario, senhaHash, nome, isAdmin, nivel, podeControlar, ativo) VALUES ('admin', 'hash-legado', 'Administrador', 1, 3, 1, 1)"
    )
    .run();

  criarSchema();

  assert.equal(db.prepare("SELECT id FROM usuarios WHERE usuario = 'admin'").get(), undefined);
  const conta = db.prepare("SELECT * FROM usuarios WHERE usuario = 'superadmin'").get();
  assert.equal(conta.id, info.lastInsertRowid);
  assert.equal(conta.nivel, 3);
  assert.equal(conta.senhaHash, "hash-legado");
  assert.equal(conta.nome, "Superadministrador");

  criarSchema();
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM usuarios WHERE usuario = 'superadmin'").get().c, 1);
});

test("a migração não sobrescreve uma conta 'superadmin' já existente nem o nome personalizado", () => {
  db.prepare("DELETE FROM usuarios").run();
  db.prepare(
    "INSERT INTO usuarios (usuario, senhaHash, nome, isAdmin, nivel, podeControlar, ativo) VALUES ('superadmin', 'hash-novo', 'Superadministrador', 1, 3, 1, 1)"
  ).run();
  db.prepare(
    "INSERT INTO usuarios (usuario, senhaHash, nome, isAdmin, nivel, podeControlar, ativo) VALUES ('admin', 'hash-antigo', 'Personalizado', 1, 3, 1, 1)"
  ).run();

  criarSchema();

  assert.equal(db.prepare("SELECT senhaHash FROM usuarios WHERE usuario = 'superadmin'").get().senhaHash, "hash-novo");
  assert.equal(db.prepare("SELECT nome FROM usuarios WHERE usuario = 'admin'").get().nome, "Personalizado");
});

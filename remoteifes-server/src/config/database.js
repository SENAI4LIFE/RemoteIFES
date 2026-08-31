const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");
const { CAMINHO_DB } = require("./paths");

const DB_PATH = CAMINHO_DB;

if (DB_PATH !== ":memory:") {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

const db = new DatabaseSync(DB_PATH);
const bancoNovo = Number(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get().n) === 0;
if (bancoNovo) db.exec("PRAGMA auto_vacuum = INCREMENTAL");
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 5000");
db.exec("PRAGMA wal_autocheckpoint = 1000");
db.exec("PRAGMA journal_size_limit = 16777216");

module.exports = db;

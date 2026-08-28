const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");
const { CAMINHO_DB } = require("./paths");

const DB_PATH = CAMINHO_DB;

if (DB_PATH !== ":memory:") {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 5000");

module.exports = db;

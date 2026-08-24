const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");

// Permite isolar o banco em testes automatizados (ver
// remoteifes-server/test/) sem tocar em data/remoteifes.db de
// desenvolvimento. Em uso normal (start/dev), comporta-se exatamente como
// antes.
const DATA_DIR = path.join(__dirname, "..", "..", "data");
const DB_PATH = process.env.REMOTEIFES_DB_PATH || path.join(DATA_DIR, "remoteifes.db");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

module.exports = db;

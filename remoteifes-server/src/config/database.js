const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");

const DATA_DIR = path.join(__dirname, "..", "..", "data");
const DB_PATH = process.env.REMOTEIFES_DB_PATH || path.join(DATA_DIR, "remoteifes.db");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
// Wait (instead of failing immediately) when the database file is momentarily
// locked by another process — e.g. a backup copy or `npm run reset-admin`
// running while the server is up.
db.exec("PRAGMA busy_timeout = 5000");

module.exports = db;

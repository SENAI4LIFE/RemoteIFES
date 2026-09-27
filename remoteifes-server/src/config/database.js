const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");
const { CAMINHO_DB } = require("./paths");
const { restauracaoEmAndamento } = require("./restauracao");

const DB_PATH = CAMINHO_DB;

const restauracao = restauracaoEmAndamento(DB_PATH);
if (restauracao) {
  const erro = new Error(
    `restauração do banco em andamento (processo ${restauracao.pid}, desde ${restauracao.desde}): ` +
      "o RemoteIFES não abre o banco até ela terminar. O serviço volta sozinho quando a restauração acabar."
  );
  erro.code = "RESTAURACAO_EM_ANDAMENTO";
  throw erro;
}

if (DB_PATH !== ":memory:") {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true, mode: 0o700 });
}

const db = new DatabaseSync(DB_PATH);

// The database holds password and device-secret hashes and the mesh keys, and SQLite creates it
// with the umask of whichever process opens it first (0644 under systemd's or a shell's default).
// Like the backups, it is kept to the account that runs RemoteIFES (the Console runs as the same
// account). Only the database files are touched, never a directory the path may share with other
// programs, and a file this user does not own is left as it is.
function restringirArquivosDoBanco() {
  // Windows has no POSIX modes; its file ACLs follow the data directory's.
  if (DB_PATH === ":memory:" || process.platform === "win32") return;
  for (const arquivo of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    try {
      const modo = fs.statSync(arquivo).mode & 0o777;
      if (modo & 0o077) fs.chmodSync(arquivo, modo & 0o700);
    } catch {}
  }
}
const bancoNovo = Number(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get().n) === 0;
if (bancoNovo) db.exec("PRAGMA auto_vacuum = INCREMENTAL");
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 5000");
db.exec("PRAGMA wal_autocheckpoint = 1000");
db.exec("PRAGMA journal_size_limit = 16777216");
// After the WAL switch, so -wal and -shm exist and are covered too.
restringirArquivosDoBanco();

module.exports = db;

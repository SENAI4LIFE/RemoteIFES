const path = require("path");

const DIR_DADOS = path.join(__dirname, "..", "..", "data");
const CAMINHO_DB = process.env.REMOTEIFES_DB_PATH || path.join(DIR_DADOS, "remoteifes.db");
const DIR_BACKUPS = process.env.BACKUP_DIR
  ? path.resolve(process.env.BACKUP_DIR)
  : path.join(DIR_DADOS, "backups");

module.exports = { DIR_DADOS, CAMINHO_DB, DIR_BACKUPS };

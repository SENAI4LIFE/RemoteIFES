const path = require("path");

const DIR_DADOS = process.env.REMOTEIFES_DATA_DIR
  ? path.resolve(process.env.REMOTEIFES_DATA_DIR)
  : path.join(__dirname, "..", "..", "data");
const CAMINHO_DB = process.env.REMOTEIFES_DB_PATH || path.join(DIR_DADOS, "remoteifes.db");
const DIR_BACKUPS = process.env.BACKUP_DIR
  ? path.resolve(process.env.BACKUP_DIR)
  : path.join(DIR_DADOS, "backups");

module.exports = { DIR_DADOS, CAMINHO_DB, DIR_BACKUPS };

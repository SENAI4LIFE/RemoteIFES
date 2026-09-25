const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { spawnSync } = require("child_process");

const RAIZ_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "remoteifes-corrompido-"));
process.env.REMOTEIFES_DB_PATH = path.join(RAIZ_TMP, "remoteifes.db");
process.env.BACKUP_DIR = path.join(RAIZ_TMP, "backups");
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");

const db = require("../src/config/database");
const { criarSchema } = require("../src/db/schema");
const { popularBanco } = require("../src/db/seed");
const backupService = require("../src/services/backupService");

criarSchema();
popularBanco();
db.prepare("INSERT INTO usuarios (usuario, senhaHash, nome, isAdmin, nivel, podeControlar) VALUES ('prof-backup', 'x', 'Prof', 0, 1, 1)").run();
const ponto = backupService.criarBackup({ rotulo: "integro" });
db.close();

const DB = process.env.REMOTEIFES_DB_PATH;

function corromper() {
  const tamanho = fs.statSync(DB).size;
  const fd = fs.openSync(DB, "r+");
  try {
    fs.writeSync(fd, Buffer.alloc(Math.min(4096, tamanho), 0x5a), 0, Math.min(4096, tamanho), 0);
  } finally {
    fs.closeSync(fd);
  }
  fs.writeFileSync(`${DB}-wal`, Buffer.from("lixo de wal"));
  fs.writeFileSync(`${DB}-shm`, Buffer.from("lixo de shm"));
}

function abrirEContar() {
  const conexao = new DatabaseSync(DB, { readOnly: true });
  try {
    assert.equal(conexao.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.deepEqual(conexao.prepare("PRAGMA foreign_key_check").all(), []);
    return conexao.prepare("SELECT COUNT(*) n FROM usuarios").get().n;
  } finally {
    conexao.close();
  }
}

test.after(() => {
  fs.rmSync(RAIZ_TMP, { recursive: true, force: true });
});

test("a corrupted database is diagnosed and a normal restore still refuses to overwrite it", () => {
  corromper();
  const diagnostico = backupService.diagnosticarBancoAtual(DB);
  assert.equal(diagnostico.integro, false);
  assert.throws(() => backupService.restaurarBackup(ponto.arquivo), /recuperação com quarentena/);
  assert.ok(fs.existsSync(DB), "sem a opção explícita nada é movido");
  assert.equal(fs.readFileSync(`${DB}-wal`, "utf8"), "lixo de wal", "a tentativa recusada não pode destruir o WAL forense");
  assert.ok(fs.existsSync(`${DB}-shm`));
  assert.equal(fs.readdirSync(RAIZ_TMP).filter((n) => n.includes(".corrompido-")).length, 0);
});

test("with explicit recovery the damaged database is quarantined, the verified backup is installed and the forensic files are kept", () => {
  const resultado = backupService.restaurarBackup(ponto.arquivo, { quarentenarDanificado: true });
  assert.equal(resultado.copiaSeguranca, null, "não existe cópia de segurança verificada de um banco corrompido");
  assert.ok(resultado.quarentena.banco.includes(".corrompido-"));
  assert.ok(fs.existsSync(resultado.quarentena.banco));
  assert.ok(fs.existsSync(resultado.quarentena.wal));
  assert.ok(fs.existsSync(resultado.quarentena.shm));
  assert.equal(fs.readFileSync(resultado.quarentena.wal, "utf8"), "lixo de wal");
  assert.ok(!fs.existsSync(`${DB}-wal`) && !fs.existsSync(`${DB}-shm`));
  assert.equal(abrirEContar(), 2);
  assert.doesNotThrow(() => backupService.verificarArquivoBackup(DB));
});

test("a sound database is never quarantined, even with the option enabled", () => {
  const resultado = backupService.restaurarBackup(ponto.arquivo, { quarentenarDanificado: true });
  assert.equal(resultado.quarentena, null);
  assert.ok(resultado.copiaSeguranca && fs.existsSync(resultado.copiaSeguranca));
  assert.equal(abrirEContar(), 2);
  assert.equal(fs.readdirSync(RAIZ_TMP).filter((n) => n.includes(".corrompido-")).length, 3);
});

test("the command line exposes recovery and refuses by default", () => {
  corromper();
  const semFlag = spawnSync(process.execPath, ["restore-backup.js", ponto.arquivo, "--sim"], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
    env: { ...process.env },
  });
  assert.notEqual(semFlag.status, 0);
  assert.match(semFlag.stderr, /restauração abortada/);

  const comFlag = spawnSync(process.execPath, ["restore-backup.js", ponto.arquivo, "--sim", "--recuperar-corrompido"], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
    env: { ...process.env },
  });
  assert.equal(comFlag.status, 0, comFlag.stdout + comFlag.stderr);
  assert.match(comFlag.stdout, /quarentena/);
  assert.match(comFlag.stdout, /preservados para análise/);
  assert.equal(abrirEContar(), 2);
});

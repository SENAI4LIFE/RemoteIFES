const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
process.env.NODE_ENV = "test";

const RAIZ_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "remoteifes-recuperacao-"));
process.env.REMOTEIFES_DB_PATH = path.join(RAIZ_TMP, "remoteifes.db");
process.env.BACKUP_DIR = path.join(RAIZ_TMP, "backups");

const test = require("node:test");
const assert = require("node:assert/strict");

const db = require("../src/config/database");
const { criarSchema } = require("../src/db/schema");
const { popularBanco } = require("../src/db/seed");
const backupService = require("../src/services/backupService");

// Failures injected at each boundary of the production backup and restore code
// (src/services/backupService.js): staging the incoming file, swapping it in, checking what was
// installed, taking the safety copy, and writing a backup. The rule each test holds: a failure is
// reported as a failure, the current database is either untouched or put back, and no half-written
// file is left behind. The end-to-end drill with the command-line tools is ensaio-recuperacao.js.

const DB = process.env.REMOTEIFES_DB_PATH;
const DIR_BACKUPS = process.env.BACKUP_DIR;
let backup;
let rodada = 0;

criarSchema();
popularBanco();
backup = backupService.criarBackup({ rotulo: "base" }).arquivo;
db.close();

test.after(() => fs.rmSync(RAIZ_TMP, { recursive: true, force: true }));

const hash = (arquivo) => crypto.createHash("sha256").update(fs.readFileSync(arquivo)).digest("hex");
const sobras = () => [...fs.readdirSync(RAIZ_TMP), ...fs.readdirSync(DIR_BACKUPS)].filter((n) => /\.incoming-|\.rollback-|^\.tmp-/.test(n));

/** A current database that differs from the backup: it has one more account. */
function bancoAtual() {
  rodada += 1;
  for (const s of ["", "-wal", "-shm"]) fs.rmSync(`${DB}${s}`, { force: true });
  fs.copyFileSync(backup, DB);
  const d = new DatabaseSync(DB);
  d.prepare("INSERT INTO usuarios (usuario, senhaHash, nome, isAdmin, nivel, podeControlar) VALUES (?, 'x', 'Atual', 0, 1, 1)").run(`atual-${rodada}`);
  d.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  d.close();
  for (const s of ["-wal", "-shm"]) fs.rmSync(`${DB}${s}`, { force: true });
  return { usuario: `atual-${rodada}`, hash: hash(DB) };
}

function usuarios() {
  const d = new DatabaseSync(DB, { readOnly: true });
  try {
    return d.prepare("SELECT usuario FROM usuarios").all().map((r) => r.usuario);
  } finally {
    d.close();
  }
}

function erroDeSistema(code) {
  return Object.assign(new Error(`${code} (simulado)`), { code });
}

test("a full disk while staging the incoming file aborts the restore with the database untouched", (t) => {
  const atual = bancoAtual();
  const copiar = fs.copyFileSync;
  t.mock.method(fs, "copyFileSync", (origem, destino, ...resto) => {
    if (String(destino).includes(".incoming-")) throw erroDeSistema("ENOSPC");
    return copiar(origem, destino, ...resto);
  });
  assert.throws(() => backupService.restaurarBackup(backup), /não foi possível instalar o backup: ENOSPC/);
  t.mock.restoreAll();
  assert.equal(hash(DB), atual.hash);
  assert.deepEqual(sobras(), []);
});

test("a swap that cannot replace the file (busy or denied) aborts with the database untouched", (t) => {
  for (const code of ["EBUSY", "EPERM"]) {
    const atual = bancoAtual();
    const renomear = fs.renameSync;
    t.mock.method(fs, "renameSync", (origem, destino) => {
      if (String(origem).includes(".incoming-")) throw erroDeSistema(code);
      return renomear(origem, destino);
    });
    assert.throws(() => backupService.restaurarBackup(backup), new RegExp(`não foi possível instalar o backup: ${code}`));
    t.mock.restoreAll();
    assert.equal(hash(DB), atual.hash, code);
    assert.deepEqual(sobras(), []);
  }
});

test("an installed file that fails its check is replaced by the safety copy, and the failure is reported", (t) => {
  const atual = bancoAtual();
  const renomear = fs.renameSync;
  // The swap happens, and the file that lands is damaged (a torn write on the way to the disk).
  t.mock.method(fs, "renameSync", (origem, destino) => {
    const r = renomear(origem, destino);
    if (String(origem).includes(".incoming-")) {
      const fd = fs.openSync(destino, "r+");
      fs.writeSync(fd, Buffer.alloc(100, 0), 0, 100, 0);
      fs.closeSync(fd);
    }
    return r;
  });
  assert.throws(() => backupService.restaurarBackup(backup), /o banco anterior foi recolocado/);
  t.mock.restoreAll();
  assert.ok(usuarios().includes(atual.usuario), "the previous data is back");
  assert.doesNotThrow(() => backupService.verificarArquivoBackup(DB));
  assert.deepEqual(sobras(), []);
});

test("without a verified safety copy of the current database the restore does not start", (t) => {
  const atual = bancoAtual();
  const chmod = fs.chmodSync;
  t.mock.method(fs, "chmodSync", (alvo, modo) => {
    if (path.basename(String(alvo)).startsWith("pre-restauracao-")) throw erroDeSistema("EIO");
    return chmod(alvo, modo);
  });
  assert.throws(() => backupService.restaurarBackup(backup), /não foi possível criar uma cópia de segurança verificada/);
  t.mock.restoreAll();
  assert.equal(hash(DB), atual.hash);
  assert.ok(!fs.readdirSync(DIR_BACKUPS).some((n) => n.startsWith("pre-restauracao-") && fs.statSync(path.join(DIR_BACKUPS, n)).size === 0));
  assert.deepEqual(sobras(), []);
});

test("a restore onto a missing database installs the backup", () => {
  for (const s of ["", "-wal", "-shm"]) fs.rmSync(`${DB}${s}`, { force: true });
  const r = backupService.restaurarBackup(backup);
  assert.equal(r.copiaSeguranca, null, "nothing to keep");
  assert.doesNotThrow(() => backupService.verificarArquivoBackup(DB));
  assert.ok(!usuarios().some((u) => u.startsWith("atual-")));
});

test("a backup that cannot be written leaves no partial file and keeps the existing backups", (t) => {
  const conexao = new DatabaseSync(DB);
  t.after(() => conexao.close());
  const antes = backupService.listarBackups(DIR_BACKUPS).map((b) => b.nome);
  for (const code of ["ENOSPC", "EIO"]) {
    const renomear = fs.renameSync;
    t.mock.method(fs, "renameSync", (origem, destino) => {
      if (path.basename(String(origem)).startsWith(".tmp-")) throw erroDeSistema(code);
      return renomear(origem, destino);
    });
    assert.throws(() => backupService.criarBackup({ conexao, rotulo: "falha" }), new RegExp(code));
    t.mock.restoreAll();
  }
  assert.deepEqual(backupService.listarBackups(DIR_BACKUPS).map((b) => b.nome), antes, "rotation did not run on a failed backup");
  assert.deepEqual(sobras(), []);
  for (const nome of antes) assert.doesNotThrow(() => backupService.verificarArquivoBackup(path.join(DIR_BACKUPS, nome)));
});

test("a backup into a folder that does not exist yet creates it", (t) => {
  const conexao = new DatabaseSync(DB);
  t.after(() => conexao.close());
  const novo = path.join(RAIZ_TMP, "destino-novo", "backups");
  const r = backupService.criarBackup({ conexao, dir: novo, rotulo: "novo" });
  assert.ok(fs.existsSync(r.arquivo));
  assert.doesNotThrow(() => backupService.verificarArquivoBackup(r.arquivo));
});

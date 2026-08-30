const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
process.env.NODE_ENV = "test";

const RAIZ_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "remoteifes-backup-"));
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

let singletonFechado = false;

test.after(() => {
  if (!singletonFechado) {
    try {
      db.close();
    } catch {}
  }
  fs.rmSync(RAIZ_TMP, { recursive: true, force: true });
});

test("criarBackup gera um snapshot verificado, standalone e sem arquivos -wal", () => {
  const { arquivo, bytes } = backupService.criarBackup({ rotulo: "primeiro" });
  assert.ok(fs.existsSync(arquivo));
  assert.ok(bytes > 0);
  assert.equal(fs.existsSync(`${arquivo}-wal`), false);
  assert.equal(fs.existsSync(`${arquivo}-shm`), false);
  assert.doesNotThrow(() => backupService.verificarArquivoBackup(arquivo));

  const listado = backupService.listarBackups();
  assert.equal(listado.length, 1);
  assert.equal(listado[0].arquivo, arquivo);
});

test("o snapshot reflete o estado já gravado enquanto o banco segue ativo", () => {
  db.prepare("INSERT INTO comandos_log (sala, cmd, origem) VALUES ('A-108', 'ligar', 'manual')").run();
  const { arquivo } = backupService.criarBackup({ rotulo: "com-log" });

  const copia = new DatabaseSync(arquivo, { readOnly: true });
  try {
    const { total } = copia.prepare("SELECT COUNT(*) total FROM comandos_log WHERE sala = 'A-108'").get();
    assert.ok(total >= 1);
  } finally {
    copia.close();
  }
});

test("a rotação mantém N backups e nunca remove o recém-criado", () => {
  const dir = path.join(RAIZ_TMP, "rotacao");
  let ultimo;
  for (let i = 0; i < 6; i += 1) {
    ultimo = backupService.criarBackup({ dir, reter: 3, rotulo: `r${i}` });
  }
  const restantes = backupService.listarBackups(dir);
  assert.equal(restantes.length, 3);
  assert.ok(
    restantes.some((b) => b.arquivo === ultimo.arquivo),
    "o backup recém-criado não pode ter sido apagado pela rotação"
  );
  assert.ok(restantes.every((b) => /^remoteifes-\d{8}-\d{6}-[0-9a-f]{6}-r\d\.db$/.test(b.nome)), restantes.map((b) => b.nome).join(", "));
});

test("verificarArquivoBackup rejeita um arquivo corrompido", () => {
  const ruim = path.join(RAIZ_TMP, "corrompido.db");
  fs.writeFileSync(ruim, Buffer.from("isto definitivamente nao e um banco sqlite valido"));
  assert.throws(() => backupService.verificarArquivoBackup(ruim));
});

test("restaurarBackup recusa alvo em memória", () => {
  assert.throws(
    () => backupService.restaurarBackup(backupService.listarBackups()[0].arquivo, { destino: ":memory:" }),
    /memória/
  );
});

test("restaurarBackup verifica, cria cópia de segurança e reverte os dados", () => {
  const ponto = backupService.criarBackup({ rotulo: "ponto-de-restauracao" });
  const usuariosAntes = db.prepare("SELECT COUNT(*) total FROM usuarios").get().total;

  db.prepare(
    "INSERT INTO usuarios (usuario, senhaHash, nome, isAdmin, nivel, podeControlar) VALUES ('temp-restore', 'x', 'Temp', 0, 1, 1)"
  ).run();
  assert.equal(db.prepare("SELECT COUNT(*) total FROM usuarios").get().total, usuariosAntes + 1);

  db.close();
  singletonFechado = true;

  const { copiaSeguranca } = backupService.restaurarBackup(ponto.arquivo);
  assert.ok(copiaSeguranca && fs.existsSync(copiaSeguranca));
  assert.doesNotThrow(() => backupService.verificarArquivoBackup(copiaSeguranca));

  const reaberto = new DatabaseSync(process.env.REMOTEIFES_DB_PATH, { readOnly: true });
  try {
    assert.equal(reaberto.prepare("SELECT COUNT(*) total FROM usuarios").get().total, usuariosAntes);
    assert.equal(
      reaberto.prepare("SELECT COUNT(*) total FROM usuarios WHERE usuario = 'temp-restore'").get().total,
      0
    );
  } finally {
    reaberto.close();
  }
});

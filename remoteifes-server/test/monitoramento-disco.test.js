process.env.NODE_ENV = "test";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const raiz = fs.mkdtempSync(path.join(os.tmpdir(), "remoteifes-disco-"));
const dirDados = path.join(raiz, "dados");
const dirBanco = path.join(raiz, "volume-banco");
const dirBackups = path.join(raiz, "volume-backups");
fs.mkdirSync(dirDados, { recursive: true });
fs.mkdirSync(dirBanco, { recursive: true });
fs.mkdirSync(dirBackups, { recursive: true });
process.env.REMOTEIFES_DATA_DIR = dirDados;
process.env.REMOTEIFES_DB_PATH = path.join(dirBanco, "remoteifes.db");
process.env.BACKUP_DIR = dirBackups;

const db = require("../src/config/database");
const { criarSchema } = require("../src/db/schema");
criarSchema();
const monitoramento = require("../src/services/monitoramentoService");

test.after(() => {
  db.close();
  fs.rmSync(raiz, { recursive: true, force: true });
});

test("o armazenamento medido é o sistema de arquivos que contém o banco, não o diretório de dados", () => {
  const arm = monitoramento.coletarArmazenamento();
  assert.equal(arm.caminho, dirBanco);
  assert.equal(arm.rotulo, "banco de dados");
  assert.equal(typeof arm.totalBytes, "number");
  assert.equal(arm.backups, undefined, "mesmo dispositivo: não há medição separada de backups");
});

test("quando os backups ficam em outro dispositivo, ele é medido e rotulado separadamente", (t) => {
  const original = fs.statSync;
  t.mock.method(fs, "statSync", (alvo, ...resto) => {
    const st = original(alvo, ...resto);
    if (path.resolve(String(alvo)) === path.resolve(dirBackups)) return { ...st, dev: st.dev + 1 };
    return st;
  });
  const arm = monitoramento.coletarArmazenamento();
  assert.equal(arm.caminho, dirBanco);
  assert.ok(arm.backups, "medição do volume de backups ausente");
  assert.equal(arm.backups.caminho, dirBackups);
  assert.equal(arm.backups.rotulo, "backups");
  assert.equal(typeof arm.backups.livreBytes, "number");
});

test("um alerta de espaço no volume de backups aparece junto dos alertas de monitoramento", (t) => {
  const original = fs.statSync;
  t.mock.method(fs, "statSync", (alvo, ...resto) => {
    const st = original(alvo, ...resto);
    if (path.resolve(String(alvo)) === path.resolve(dirBackups)) return { ...st, dev: st.dev + 1 };
    return st;
  });
  const statfsOriginal = fs.statfsSync;
  t.mock.method(fs, "statfsSync", (alvo) => {
    const st = statfsOriginal(alvo);
    if (path.resolve(String(alvo)) === path.resolve(dirBackups)) return { ...st, blocks: 1000, bavail: 20, bsize: 4096 };
    return st;
  });
  const resumo = monitoramento.coletar();
  assert.ok(resumo.armazenamento.backups.alerta);
  assert.ok(resumo.alertas.some((a) => a.includes(dirBackups)), JSON.stringify(resumo.alertas));
});

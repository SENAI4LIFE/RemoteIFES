const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { restauracaoEmAndamento, caminhoMarcador, IDADE_MAXIMA_MS } = require("../src/config/restauracao");

// While a managed restore swaps the database, no RemoteIFES process may open it: the restore
// publishes `<database>.restauracao` with its PID and src/config/database.js refuses to open the
// file while that process is alive.

const RAIZ = path.join(__dirname, "..");

function abrirBanco(banco) {
  return spawnSync(process.execPath, ["-e", "require('./src/config/database'); console.log('aberto')"], {
    cwd: RAIZ,
    env: { ...process.env, REMOTEIFES_DB_PATH: banco },
    encoding: "utf8",
  });
}

function processoVivo() {
  return spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
}

function cenario(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "restauracao-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "remoteifes.db");
}

test("a server does not open the database while a live restore holds the marker", (t) => {
  const banco = cenario(t);
  const restauracao = processoVivo();
  t.after(() => restauracao.kill("SIGKILL"));
  fs.writeFileSync(caminhoMarcador(banco), JSON.stringify({ pid: restauracao.pid, desde: new Date().toISOString() }));

  const r = abrirBanco(banco);
  assert.notEqual(r.status, 0, "the server must refuse to start");
  assert.match(r.stderr, /restauração do banco em andamento/);
  assert.ok(!fs.existsSync(banco), "the database file was not even created");
  assert.ok(!fs.existsSync(`${banco}-wal`));
});

test("a marker left by a dead or ancient restore does not keep the application down", (t) => {
  const banco = cenario(t);
  const morto = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  fs.writeFileSync(caminhoMarcador(banco), JSON.stringify({ pid: Number(morto.stdout), desde: new Date().toISOString() }));
  assert.equal(restauracaoEmAndamento(banco), null);
  assert.equal(abrirBanco(banco).status, 0);

  const vivo = processoVivo();
  t.after(() => vivo.kill("SIGKILL"));
  const antigo = new Date(Date.now() - IDADE_MAXIMA_MS - 60_000).toISOString();
  fs.writeFileSync(caminhoMarcador(banco), JSON.stringify({ pid: vivo.pid, desde: antigo }));
  assert.equal(restauracaoEmAndamento(banco), null, "older than any restore can last");

  fs.writeFileSync(caminhoMarcador(banco), "não é JSON");
  assert.equal(restauracaoEmAndamento(banco), null);
});

test("the restoring process itself and in-memory databases are not blocked", (t) => {
  const banco = cenario(t);
  fs.writeFileSync(caminhoMarcador(banco), JSON.stringify({ pid: process.pid, desde: new Date().toISOString() }));
  assert.equal(restauracaoEmAndamento(banco), null);
  assert.equal(restauracaoEmAndamento(":memory:"), null);
});

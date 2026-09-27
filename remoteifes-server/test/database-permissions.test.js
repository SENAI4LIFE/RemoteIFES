const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

// The database holds password and device-secret hashes and the mesh keys. Opening it keeps its files
// to the account that runs RemoteIFES, also when an older version or another process left them
// readable by others.

const RAIZ = path.join(__dirname, "..");

function abrirEm(caminho) {
  execFileSync(process.execPath, ["-e", "require('./src/config/database')"], {
    cwd: RAIZ,
    env: { ...process.env, REMOTEIFES_DB_PATH: caminho, NODE_ENV: "test" },
    stdio: "pipe",
  });
}

test("opening the database keeps its files to the account that runs RemoteIFES", { skip: process.platform === "win32" && "POSIX file modes" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remoteifes-perm-"));
  try {
    const banco = path.join(dir, "remoteifes.db");
    abrirEm(banco);
    assert.equal(fs.statSync(banco).mode & 0o777, 0o600, "a new database");
    // An installation from before this change, or a database first opened by a CLI under a 0022 umask.
    fs.chmodSync(banco, 0o644);
    abrirEm(banco);
    assert.equal(fs.statSync(banco).mode & 0o777, 0o600, "an existing world-readable database");
    for (const extra of ["-wal", "-shm"]) {
      if (fs.existsSync(banco + extra)) assert.equal(fs.statSync(banco + extra).mode & 0o077, 0, `${extra} is private too`);
    }
    // A directory the server creates for the database is private to its user.
    const novo = path.join(dir, "novo", "remoteifes.db");
    abrirEm(novo);
    assert.equal(fs.statSync(path.dirname(novo)).mode & 0o077, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

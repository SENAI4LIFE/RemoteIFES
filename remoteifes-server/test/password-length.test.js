process.env.REMOTEIFES_DB_PATH = ":memory:";
process.env.NODE_ENV = "test";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");

const db = require("../src/config/database");
const app = require("../src/app");
const usuariosService = require("../src/services/usuariosService");
const senhas = require("../src/utils/senhas");

// bcrypt reads only the first 72 bytes of what it hashes, and a password may have up to 128
// characters. Two passwords that differ only after byte 72 must still be different passwords.

const BASE = "frase-longa-".repeat(6);
const PARES = [
  [`${BASE}final-A`, `${BASE}final-B`],
  // 80 bytes in UTF-8 in 40 characters: the first 72 bytes are the same.
  ["ç".repeat(40), `${"ç".repeat(39)}c`],
];

let server;
let baseUrl;

async function login(usuario, senha) {
  const resp = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usuario, senha }),
  });
  return resp.status;
}

test.before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
});

test("every byte of a password longer than 72 bytes counts; up to 72 the hash stays plain bcrypt", () => {
  assert.equal(Buffer.byteLength(BASE), 72);
  const curta = "senha-curta-123";
  const hashCurta = senhas.gerarHash(curta);
  assert.match(hashCurta, /^\$2[aby]\$10\$/);
  assert.ok(bcrypt.compareSync(curta, hashCurta), "plain bcrypt, which older versions verify");
  assert.ok(senhas.conferir(curta, hashCurta));

  for (const [longa, outra] of PARES) {
    assert.ok(bcrypt.compareSync(outra, bcrypt.hashSync(longa, 4)), "the case bcrypt alone cannot tell apart");
    const hash = senhas.gerarHash(longa);
    assert.ok(hash.startsWith(senhas.PREFIXO_LONGA));
    assert.ok(senhas.conferir(longa, hash));
    assert.equal(senhas.conferir(outra, hash), false);
    // The reduced value is not a password by itself.
    const sal = hash.slice(senhas.PREFIXO_LONGA.length, senhas.PREFIXO_LONGA.length + 29);
    assert.equal(senhas.conferir(crypto.createHmac("sha256", sal).update(longa, "utf8").digest("base64"), hash), false);
  }

  // A hash stored before this change keeps verifying the password it was made from.
  assert.ok(senhas.conferir(PARES[0][0], bcrypt.hashSync(PARES[0][0], 4)));
  assert.equal(senhas.conferir(PARES[0][0], null), false);
});

test("an account with a long password logs in only with the whole password, when created and when changed", async () => {
  const superadmin = usuariosService.buscarPorUsuario("superadmin");
  const [longa, outra] = PARES[0];
  const conta = usuariosService.criar({ usuario: "frase-longa", senha: longa, nome: "Frase longa" }, superadmin);
  assert.equal(await login("frase-longa", longa), 200);
  assert.equal(await login("frase-longa", outra), 401);

  const [nova, quaseNova] = PARES[1];
  usuariosService.trocarSenha(conta.id, nova, superadmin);
  assert.equal(await login("frase-longa", nova), 200);
  assert.equal(await login("frase-longa", quaseNova), 401);
  assert.equal(await login("frase-longa", longa), 401);
});

test("reset-admin stores a long password in full", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remoteifes-senha-longa-"));
  try {
    const banco = path.join(dir, "remoteifes.db");
    const rodar = (argumentos, entrada) =>
      spawnSync(process.execPath, argumentos, {
        cwd: path.join(__dirname, ".."),
        encoding: "utf8",
        input: entrada,
        env: { ...process.env, REMOTEIFES_DB_PATH: banco, SENHA_ADMIN_INICIAL: "senha-inicial-do-teste" },
      });
    assert.equal(rodar(["-e", "require('./src/db/schema').criarSchema(); require('./src/db/seed').popularBanco();"]).status, 0);
    const [longa, outra] = PARES[0];
    const r = rodar(["reset-admin-senha.js", "--stdin"], `${longa}\n`);
    assert.equal(r.status, 0, r.stderr);
    const lido = rodar(["-e", "process.stdout.write(require('./src/config/database').prepare('SELECT senhaHash FROM usuarios WHERE nivel = 3').get().senhaHash)"]);
    assert.equal(lido.status, 0, lido.stderr);
    assert.ok(senhas.conferir(longa, lido.stdout));
    assert.equal(senhas.conferir(outra, lido.stdout), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

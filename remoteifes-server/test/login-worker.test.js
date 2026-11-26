process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");

const senhas = require("../src/utils/senhas");

// A malformed stored hash makes bcrypt throw inside the verification worker. Only the login that
// carried it may fail: the other logins queued on the same worker must still be answered.

test("a malformed hash fails only its own login; the logins queued with it still verify", async () => {
  const senha = "senha-valida-123";
  const hash = senhas.gerarHash(senha);
  const malformado = `$2b$10$${"!".repeat(53)}`;
  assert.throws(() => senhas.conferir(senha, malformado));

  const pedidos = [
    senhas.conferirLogin(senha, malformado),
    senhas.conferirLogin(senha, hash),
    senhas.conferirLogin(senha, hash),
    senhas.conferirLogin("outra-senha-123", hash),
    senhas.conferirLogin(senha, malformado),
    senhas.conferirLogin(senha, hash),
  ];
  assert.ok(pedidos.every(Boolean), "the queue has room for every request");
  const resultados = await Promise.allSettled(pedidos);

  assert.equal(resultados[0].status, "rejected");
  assert.equal(resultados[4].status, "rejected");
  assert.deepEqual(
    [1, 2, 3, 5].map((i) => resultados[i]),
    [true, true, false, true].map((value) => ({ status: "fulfilled", value })),
  );

  // The workers are still serving afterwards.
  assert.equal(await senhas.conferirLogin(senha, hash), true);
});

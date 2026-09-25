const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const ajuda = require("./helpers");

// Post-activation verification of a Console self-update. A version that loads but then fails (a
// crash once running) used to be restarted into the same failure forever, because the stable
// bootstrap only falls back when loading throws. Now the bootstrap counts the starts of a pending
// activation and reverts to the previous version once the limit is reached, unless the new version
// confirmed that it stays up.

const BOOTSTRAP = path.join(ajuda.RAIZ, "instalacao", "console-bootstrap.js");

function instalacao(t, { ativacao, bootstrap = fs.readFileSync(BOOTSTRAP) } = {}) {
  const raiz = ajuda.dirTemporario("console-ativacao-");
  t.after(() => fs.rmSync(raiz, { recursive: true, force: true }));
  fs.writeFileSync(path.join(raiz, "console-bootstrap.js"), bootstrap);
  const marcas = path.join(raiz, "partidas.log");
  const versao = (numero, corpo) => {
    const dir = path.join(raiz, "versoes", numero);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: numero }));
    fs.writeFileSync(
      path.join(dir, "console.js"),
      `module.exports = { executar() { require("fs").appendFileSync(${JSON.stringify(marcas)}, "${numero}\\n"); ${corpo} } };`
    );
  };
  versao("1.0.0", "");
  // Loads fine, then fails asynchronously, like a server that crashes once listening.
  versao("2.0.0", "setTimeout(() => { throw new Error('falha depois de iniciar'); }, 20);");
  fs.writeFileSync(
    path.join(raiz, "estado-instalacao.json"),
    JSON.stringify({ versaoAtiva: "2.0.0", versaoAnterior: "1.0.0", transacao: null, ativacao })
  );
  const partir = (env = {}) =>
    spawnSync(process.execPath, [path.join(raiz, "console-bootstrap.js")], {
      env: { ...process.env, CONSOLE_BOOTSTRAP_ALVO: "", ...env },
      encoding: "utf8",
    });
  const estado = () => JSON.parse(fs.readFileSync(path.join(raiz, "estado-instalacao.json"), "utf8"));
  const iniciadas = () => fs.readFileSync(marcas, "utf8").trim().split("\n");
  return { raiz, partir, estado, iniciadas };
}

const PENDENTE = { versao: "2.0.0", anterior: "1.0.0", partidas: 0, confirmada: false };

test("a self-updated version that keeps failing after it started is reverted to the previous one", (t) => {
  const inst = instalacao(t, { ativacao: PENDENTE });

  assert.notEqual(inst.partir().status, 0);
  assert.notEqual(inst.partir().status, 0);
  assert.equal(inst.estado().ativacao.partidas, 2);

  const terceira = inst.partir();
  assert.equal(terceira.status, 0, terceira.stderr);
  assert.match(terceira.stderr, /não se manteve no ar em 2 partidas; voltando para 1\.0\.0/);
  assert.deepEqual(inst.iniciadas(), ["2.0.0", "2.0.0", "1.0.0"]);

  const e = inst.estado();
  assert.equal(e.versaoAtiva, "1.0.0");
  assert.equal(e.versaoAnterior, "2.0.0");
  assert.equal(e.ativacao, null);
  assert.equal(e.reversaoAutomatica.de, "2.0.0");
  assert.equal(e.reversaoAutomatica.para, "1.0.0");
  assert.equal(inst.partir().status, 0, "later starts stay on the working version");
});

test("a confirmed version is never reverted, and the launcher entry does not count as a start", (t) => {
  const confirmada = instalacao(t, { ativacao: { ...PENDENTE, confirmada: true } });
  for (let i = 0; i < 4; i += 1) confirmada.partir();
  assert.equal(confirmada.estado().versaoAtiva, "2.0.0", "failures after confirmation are reported, not reverted");

  const lancador = instalacao(t, { ativacao: PENDENTE });
  for (let i = 0; i < 4; i += 1) lancador.partir({ CONSOLE_BOOTSTRAP_ALVO: "launcher" });
  assert.equal(lancador.estado().ativacao.partidas, 0);
});

test("the running version confirms only its own pending activation", (t) => {
  const inst = instalacao(t, { ativacao: PENDENTE });
  const ativacao = require(path.join(ajuda.RAIZ, "src", "ativacao.js"));
  assert.equal(ativacao.confirmar({ raiz: inst.raiz, versao: "1.0.0" }), false);
  assert.equal(ativacao.confirmar({ raiz: inst.raiz, versao: "2.0.0" }), true);
  assert.equal(inst.estado().ativacao.confirmada, true);
  assert.equal(ativacao.confirmar({ raiz: inst.raiz, versao: "2.0.0" }), false, "already confirmed");
  assert.equal(inst.estado().versaoAnterior, "1.0.0", "other fields of the record are preserved");
});

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const ajuda = require("./helpers");

// Network access policy (test mode and authorized ranges). The Console owns it: bin/acesso-rede.js
// writes it into the application database, and the application reads it on every request. The
// website can no longer change it (covered by the server's network-access-ownership tests).

const SERVIDOR = path.join(ajuda.RAIZ, "..", "remoteifes-server");
const RUNNER = path.join(ajuda.RAIZ, "bin", "acesso-rede.js");

function checkoutComBanco({ esquema = true } = {}) {
  const raiz = ajuda.dirTemporario("console-acesso-");
  const dirServidor = path.join(raiz, "remoteifes-server");
  fs.mkdirSync(path.join(dirServidor, "data", "backups"), { recursive: true });
  fs.writeFileSync(path.join(dirServidor, "package.json"), JSON.stringify({ version: "3.0.0" }));
  fs.writeFileSync(path.join(dirServidor, ".env"), "PORTA=8188\nNODE_ENV=production\n");
  const banco = path.join(dirServidor, "data", "remoteifes.db");
  if (esquema) {
    // The application's real schema, created by the application's own code.
    const r = spawnSync(process.execPath, ["-e", "require('./src/db/schema').criarSchema()"], {
      cwd: SERVIDOR,
      env: { ...process.env, REMOTEIFES_DB_PATH: banco },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
  } else {
    const { DatabaseSync } = require("node:sqlite");
    new DatabaseSync(banco).close();
  }
  return { raiz, banco };
}

function executarRunner(checkout, pedido) {
  const estado = ajuda.dirTemporario("console-estado-");
  const r = spawnSync(process.execPath, [RUNNER], {
    input: typeof pedido === "string" ? pedido : JSON.stringify(pedido),
    env: { ...process.env, CONSOLE_CHECKOUT_DIR: checkout, CONSOLE_ESTADO_DIR: estado, CONSOLE_SEM_PRIVILEGIO: "1" },
    encoding: "utf8",
  });
  fs.rmSync(estado, { recursive: true, force: true });
  return r;
}

// What the application itself enforces, read through its own configuration service.
function politicaDaAplicacao(banco) {
  const r = spawnSync(
    process.execPath,
    ["-e", "process.stdout.write(JSON.stringify(require('./src/services/configuracoesService').acessoRestritoAtivo()))"],
    { cwd: SERVIDOR, env: { ...process.env, REMOTEIFES_DB_PATH: banco, NODE_ENV: "production" }, encoding: "utf8" }
  );
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

function eventosDeAuditoria(banco) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(banco);
  try {
    return db.prepare("SELECT tipo, atorId, atorLogin, camposAlterados, descricao FROM auditoria_eventos WHERE tipo = 'configuracao_alterada' ORDER BY id").all();
  } finally {
    db.close();
  }
}

test("the runner writes the policy and one audit event, and the application enforces it", (t) => {
  const { raiz, banco } = checkoutComBanco();
  t.after(() => fs.rmSync(raiz, { recursive: true, force: true }));

  const r = executarRunner(raiz, { operador: "op.redes", modoTeste: false, redesAutorizadas: ["10.10.0.0/16", " 10.10.0.0/16", "192.168.1.0/24"] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /CONSOLE_RESULTADO /);
  assert.deepEqual(politicaDaAplicacao(banco), { modoTeste: false, redesAutorizadas: ["10.10.0.0/16", "192.168.1.0/24"] });

  const eventos = eventosDeAuditoria(banco);
  assert.equal(eventos.length, 1);
  assert.equal(eventos[0].atorLogin, "console:op.redes");
  assert.equal(eventos[0].atorId, null, "the Console operator is not an application account");
  assert.equal(eventos[0].camposAlterados, "modoTeste,redesAutorizadas");

  const repetido = executarRunner(raiz, { operador: "op.redes", modoTeste: false, redesAutorizadas: ["10.10.0.0/16", "192.168.1.0/24"] });
  assert.equal(repetido.status, 0, repetido.stderr);
  assert.match(repetido.stdout, /Nada mudou/);
  assert.equal(eventosDeAuditoria(banco).length, 1, "an unchanged policy is not audited again");

  const soTeste = executarRunner(raiz, { operador: "op.redes", modoTeste: true, redesAutorizadas: ["10.10.0.0/16", "192.168.1.0/24"] });
  assert.equal(soTeste.status, 0, soTeste.stderr);
  assert.equal(politicaDaAplicacao(banco).modoTeste, true);
  assert.equal(eventosDeAuditoria(banco)[1].camposAlterados, "modoTeste");
});

test("an empty range list with test mode off is accepted with an explicit warning", (t) => {
  const { raiz, banco } = checkoutComBanco();
  t.after(() => fs.rmSync(raiz, { recursive: true, force: true }));

  const r = executarRunner(raiz, { operador: "op", modoTeste: false, redesAutorizadas: [] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /só atende localhost/);
  assert.match(r.stdout, /console continua acessível/);
  assert.deepEqual(politicaDaAplicacao(banco), { modoTeste: false, redesAutorizadas: [] });
});

test("the runner refuses invalid input without touching the database", (t) => {
  const { raiz, banco } = checkoutComBanco();
  t.after(() => fs.rmSync(raiz, { recursive: true, force: true }));

  const inicial = executarRunner(raiz, { operador: "op", modoTeste: false, redesAutorizadas: ["10.0.0.0/8"] });
  assert.equal(inicial.status, 0, inicial.stderr);

  for (const ruim of [
    { operador: "op", modoTeste: false, redesAutorizadas: ["10.0.0.256/8"] },
    { operador: "op", modoTeste: false, redesAutorizadas: ["10.0.0.0/33"] },
    { operador: "op", modoTeste: false, redesAutorizadas: ["10.0.0.0"] },
    { operador: "op", modoTeste: false, redesAutorizadas: ["::1/128"] },
    { operador: "op", modoTeste: "sim", redesAutorizadas: [] },
    { operador: "op", modoTeste: false, redesAutorizadas: "10.0.0.0/8" },
    { operador: "op", modoTeste: false, redesAutorizadas: [7] },
    { operador: "op", modoTeste: false, redesAutorizadas: Array.from({ length: 65 }, (_, i) => `10.0.${i}.0/24`) },
    "não é JSON",
  ]) {
    const r = executarRunner(raiz, ruim);
    assert.equal(r.status, 2, `should refuse ${JSON.stringify(ruim).slice(0, 80)}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /Pedido recusado/);
  }
  assert.deepEqual(politicaDaAplicacao(banco), { modoTeste: false, redesAutorizadas: ["10.0.0.0/8"] });
  assert.equal(eventosDeAuditoria(banco).length, 1);
});

test("the runner refuses a database without the application schema and a missing database", (t) => {
  const semEsquema = checkoutComBanco({ esquema: false });
  const semBanco = ajuda.dirTemporario("console-acesso-");
  fs.mkdirSync(path.join(semBanco, "remoteifes-server"), { recursive: true });
  fs.writeFileSync(path.join(semBanco, "remoteifes-server", "package.json"), "{}");
  t.after(() => {
    fs.rmSync(semEsquema.raiz, { recursive: true, force: true });
    fs.rmSync(semBanco, { recursive: true, force: true });
  });

  const r = executarRunner(semEsquema.raiz, { operador: "op", modoTeste: false, redesAutorizadas: [] });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /esquema da aplicação/);

  const r2 = executarRunner(semBanco, { operador: "op", modoTeste: false, redesAutorizadas: [] });
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /Banco não encontrado/);
});

test("the action validates its arguments by schema and checks every range before running", async (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());

  const acao = amb.acoes.obter("rede.acesso-aplicacao");
  assert.ok(acao);
  assert.equal(acao.exigeElevacao, true);

  assert.throws(() => amb.acoes.validarArgumentos(acao, { redesAutorizadas: "10.0.0.0/8" }), /obrigatório/);
  assert.throws(() => amb.acoes.validarArgumentos(acao, { modoTeste: "sim" }), /booleano/);
  for (const ruim of ["10.0.0.0/8; rm -rf /", "$(id)", "`id`", "10.0.0.0/8 && curl evil", "../../etc/passwd", "a".repeat(10)]) {
    assert.throws(() => amb.acoes.validarArgumentos(acao, { modoTeste: false, redesAutorizadas: ruim }), /valor inválido/, ruim);
  }

  const invalida = await amb.acoes.preparar("rede.acesso-aplicacao", { modoTeste: false, redesAutorizadas: "10.0.0.0/8\n10.0.0.300/24" });
  assert.match(invalida.impedimento, /10\.0\.0\.300\/24/);
  const excesso = await amb.acoes.preparar("rede.acesso-aplicacao", {
    modoTeste: false,
    redesAutorizadas: Array.from({ length: 65 }, (_, i) => `10.0.${i}.0/24`).join("\n"),
  });
  assert.match(excesso.impedimento, /no máximo 64/);

  const valida = await amb.acoes.preparar("rede.acesso-aplicacao", { modoTeste: false, redesAutorizadas: "10.0.0.0/8, 192.168.0.0/16\n10.0.0.0/8" });
  assert.equal(valida.impedimento, null);
  const spec = acao.montar({ operador: "op", argumentos: valida.argumentos });
  assert.deepEqual(spec.argumentos, [RUNNER], "the ranges never reach the command line");
  assert.deepEqual(JSON.parse(spec.entrada), { operador: "op", modoTeste: false, redesAutorizadas: ["10.0.0.0/8", "192.168.0.0/16"] });
  assert.equal(spec.exigeTrava, true, "serialized with deploy and restore");
});

test("through the API the policy change requires elevation, runs, is verified and is readable", async (t) => {
  const { raiz, banco } = checkoutComBanco();
  // An open connection stands in for the running application: it keeps the -shm file that allows
  // the Console to read the database without leaving traces.
  const { DatabaseSync } = require("node:sqlite");
  const aplicacao = new DatabaseSync(banco);
  aplicacao.exec("PRAGMA journal_mode = WAL");
  aplicacao.prepare("SELECT COUNT(*) FROM configuracoes").get();

  const amb = ajuda.ambiente({ checkout: raiz });
  const s = await ajuda.subir(amb);
  t.after(async () => {
    await s.fechar();
    amb.restaurar();
    aplicacao.close();
    fs.rmSync(raiz, { recursive: true, force: true });
  });

  const sessao = await ajuda.autenticar(amb, s.porta);
  const pedido = {
    metodo: "POST",
    corpo: { argumentos: { modoTeste: false, redesAutorizadas: "10.20.0.0/16" }, aceitarAvisos: true },
    cookie: sessao.cookie,
    csrf: sessao.csrf,
    origem: s.base,
  };

  const semElevacao = await ajuda.pedir(s.porta, "/api/acoes/rede.acesso-aplicacao/executar", pedido);
  assert.equal(semElevacao.status, 403);
  assert.equal(semElevacao.json.precisaElevacao, true);

  assert.equal((await ajuda.elevar(amb, s.porta, sessao)).status, 200);
  const exec = await ajuda.pedir(s.porta, "/api/acoes/rede.acesso-aplicacao/executar", pedido);
  assert.equal(exec.status, 202, exec.texto);

  let final = null;
  for (let i = 0; i < 150; i += 1) {
    const r = await ajuda.pedir(s.porta, `/api/trabalhos/${exec.json.trabalho.id}`, { cookie: sessao.cookie, origem: s.base });
    const terminou = r.json.estado !== "executando" && (r.json.verificacao || r.json.estado !== "concluido");
    if (terminou && !fs.existsSync(path.join(raiz, "remoteifes-server", "data", ".deploy-lock"))) {
      final = r.json;
      break;
    }
    await new Promise((res) => setTimeout(res, 100));
  }
  assert.ok(final, "the job must finish");
  assert.equal(final.estado, "concluido", JSON.stringify(final));
  assert.match(JSON.stringify(final.verificacao), /releitura do banco confirma/);
  assert.equal(fs.existsSync(path.join(raiz, "remoteifes-server", "data", ".deploy-lock")), false, "the maintenance lock is released");

  const lido = await ajuda.pedir(s.porta, "/api/rede/acesso", { cookie: sessao.cookie, origem: s.base });
  assert.equal(lido.status, 200);
  assert.equal(lido.json.lido, true);
  assert.equal(lido.json.modoTeste, false);
  assert.deepEqual(lido.json.redesAutorizadas, ["10.20.0.0/16"]);
  assert.match(lido.json.dono, /Console de Operações/);
  assert.deepEqual(politicaDaAplicacao(banco), { modoTeste: false, redesAutorizadas: ["10.20.0.0/16"] });
});

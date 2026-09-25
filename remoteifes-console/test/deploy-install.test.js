const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { execFileSync, spawn } = require("child_process");
const ajuda = require("./helpers");

// Portable deploy and installation, including the regression for the Console and the script
// competing for the same lock.

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Teste",
      GIT_AUTHOR_EMAIL: "teste@example.invalid",
      GIT_COMMITTER_NAME: "Teste",
      GIT_COMMITTER_EMAIL: "teste@example.invalid",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  }).trim();
}

function checkoutGit({ porta = 8188 } = {}) {
  const raiz = ajuda.dirTemporario("console-impl-");
  git(raiz, ["init", "--quiet", "--initial-branch=main"]);
  git(raiz, ["config", "user.email", "teste@example.invalid"]);
  git(raiz, ["config", "user.name", "Teste"]);
  const servidor = path.join(raiz, "remoteifes-server");
  fs.mkdirSync(path.join(servidor, "src", "config"), { recursive: true });
  fs.mkdirSync(path.join(servidor, "data", "backups"), { recursive: true });
  fs.writeFileSync(path.join(servidor, "package.json"), JSON.stringify({ version: "3.0.0" }));
  fs.writeFileSync(path.join(servidor, ".env"), `PORTA=${porta}\n`);
  fs.writeFileSync(path.join(servidor, "src", "config", "release.js"), "module.exports={};\n");
  // The real checkout ignores `remoteifes-server/data/`; without it the preflight would see the
  // data directory as untracked local work and refuse every operation, an artifact of the fixture,
  // not of the product.
  fs.writeFileSync(path.join(raiz, ".gitignore"), "remoteifes-server/data/\nremoteifes-server/node_modules/\n");
  git(raiz, ["add", "-A"]);
  git(raiz, ["commit", "--quiet", "-m", "base"]);
  return raiz;
}

function rodar(script, args, env) {
  return new Promise((resolve) => {
    const filho = spawn(process.execPath, [path.join(ajuda.RAIZ, "bin", script), ...args], {
      env: { ...process.env, CONSOLE_SEM_PRIVILEGIO: "1", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let saida = "";
    filho.stdout.on("data", (d) => (saida += d));
    filho.stderr.on("data", (d) => (saida += d));
    filho.on("close", (codigo) => resolve({ codigo, saida }));
  });
}

/**
 * Asynchronous version, required when the test must also SERVE requests while the script runs:
 * `spawnSync` blocks the event loop, and a fake server hosted in the test process would never
 * answer the identity challenge.
 */
function rodarNodeAsync(args, env) {
  return new Promise((resolver) => {
    const filho = spawn(process.execPath, args, {
      env: { ...process.env, CONSOLE_SEM_PRIVILEGIO: "1", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let saida = "";
    filho.stdout.on("data", (d) => (saida += d));
    filho.stderr.on("data", (d) => (saida += d));
    filho.on("close", (codigo) => resolver({ codigo, saida }));
  });
}

/**
 * Runs a Console script and returns output and exit code, without throwing on expected failure.
 */
function rodarNode(args, env) {
  const r = require("child_process").spawnSync(process.execPath, args, {
    env: { ...process.env, CONSOLE_SEM_PRIVILEGIO: "1", ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
  return { codigo: r.status, saida: `${r.stdout || ""}${r.stderr || ""}` };
}

// --- Lock regression --------------------------------------------------------------------

test("REGRESSION: the managed deploy does not compete with itself for the lock", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());

  // If the action declared `exigeTrava: true` (the Console taking .deploy-lock) and then ran
  // `deploy.sh`, which takes the SAME lock with noclobber, deploy would always abort on its first
  // step. The lock is acquired only by the runner.
  const aplicar = amb.acoes.obter("atualizacao.aplicar");
  const reverter = amb.acoes.obter("atualizacao.reverter");
  const specAplicar = aplicar.montar({ operador: "op", argumentos: { commit: "a".repeat(40) } });
  const specReverter = reverter.montar({ operador: "op", argumentos: {} });

  for (const [nome, spec] of [["aplicar", specAplicar], ["reverter", specReverter]]) {
    assert.equal(spec.exigeTrava, false, `${nome}: quem segura a trava é o runner, não a ação`);
    assert.equal(spec.executavel, process.execPath, `${nome}: runner Node portátil, não bash`);
    assert.match(spec.argumentos[0], /implantar\.js$/, `${nome}: usa o runner portátil`);
    assert.ok(!spec.argumentos.some((a) => /deploy\.sh|rollback\.sh/.test(String(a))), `${nome}: não chama os scripts bash`);
  }
});

test("the runner acquires the lock once and releases it when done", async (t) => {
  const checkout = checkoutGit();
  const amb = ajuda.ambiente({ checkout });
  t.after(() => {
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  const trava = path.join(checkout, "remoteifes-server", "data", ".deploy-lock");
  assert.ok(!fs.existsSync(trava));

  // Nonexistent target: fails after acquiring the lock, which is exactly what must be observed: the
  // lock has to be released on the error path too.
  const r = await rodar("implantar.js", ["aplicar", "b".repeat(40)], {
    CONSOLE_CHECKOUT_DIR: checkout,
    CONSOLE_ESTADO_DIR: amb.estadoDir,
  });
  assert.equal(r.codigo, 1);
  assert.match(r.saida, /não foi possível resolver o alvo/);
  assert.ok(!fs.existsSync(trava), "a trava não pode ficar para trás");
});

test("the runner refuses to start while another live maintenance holds the lock", async (t) => {
  const checkout = checkoutGit();
  const amb = ajuda.ambiente({ checkout });
  t.after(() => {
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  const trava = path.join(checkout, "remoteifes-server", "data", ".deploy-lock");
  fs.writeFileSync(trava, `${process.pid} ${new Date().toISOString()}\n`);

  const r = await rodar("implantar.js", ["aplicar", "a".repeat(40)], {
    CONSOLE_CHECKOUT_DIR: checkout,
    CONSOLE_ESTADO_DIR: amb.estadoDir,
  });
  assert.equal(r.codigo, 1);
  assert.match(r.saida, /andamento/);
  assert.equal(fs.readFileSync(trava, "utf8").split(/\s+/)[0], String(process.pid), "a trava alheia fica intacta");
});

// --- Portable deploy --------------------------------------------------------------------

test("deploy refuses a dirty checkout and never discards local work", async (t) => {
  const checkout = checkoutGit();
  const amb = ajuda.ambiente({ checkout });
  t.after(() => {
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  fs.writeFileSync(path.join(checkout, "remoteifes-server", "package.json"), JSON.stringify({ version: "3.0.1" }));
  const head = git(checkout, ["rev-parse", "HEAD"]);

  const implantacao = require(path.join(ajuda.RAIZ, "src", "implantacao.js"));
  const r = await implantacao.implantar({ alvo: head, log: () => {} });
  assert.equal(r.ok, false);
  assert.match(r.erro, /alterações locais não commitadas/);
  assert.match(r.erro, /nunca descarta trabalho local/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(checkout, "remoteifes-server", "package.json"), "utf8")).version, "3.0.1");
});

test("deploy does not use bash or systemctl directly", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());

  const fonte = fs.readFileSync(path.join(ajuda.RAIZ, "src", "implantacao.js"), "utf8");
  assert.ok(!/["']bash["']/.test(fonte), "a implantação portátil não pode depender de bash");
  assert.ok(!/systemctl/.test(fonte), "o controle de serviço é do adaptador de plataforma");
  assert.match(fonte, /plataforma\.controlarServico/, "o reinício vai pelo adaptador");
});

test("aguardarVersao requires the process commit, and accepts a legacy version only with a proven restart", async (t) => {
  const checkout = checkoutGit();
  const amb = ajuda.ambiente({ checkout });
  t.after(() => {
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });
  const implantacao = require(path.join(ajuda.RAIZ, "src", "implantacao.js"));

  // Without the application running no confirmation is possible, and that is failure, not success.
  const r = await implantacao.aguardarVersao("a".repeat(40), { reinicioEm: Date.now(), tentativas: 1, intervaloMs: 10 });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /não respondeu saudável/);
});

test("a version without release.js is treated as legacy, not as an error", async (t) => {
  const checkout = checkoutGit();
  const amb = ajuda.ambiente({ checkout });
  t.after(() => {
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });
  const implantacao = require(path.join(ajuda.RAIZ, "src", "implantacao.js"));

  const comRelease = git(checkout, ["rev-parse", "HEAD"]);
  assert.equal(await implantacao.versaoInformaCommit(comRelease), true);

  fs.rmSync(path.join(checkout, "remoteifes-server", "src", "config", "release.js"));
  git(checkout, ["add", "-A"]);
  git(checkout, ["commit", "--quiet", "-m", "sem release.js"]);
  const semRelease = git(checkout, ["rev-parse", "HEAD"]);
  assert.equal(await implantacao.versaoInformaCommit(semRelease), false, "versão legada não pode confirmar a própria identidade");
});

test("rollback warns that it swaps only the code, without touching the database", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());

  const acao = amb.acoes.obter("atualizacao.reverter");
  assert.match(acao.impacto, /NÃO desfaz mudanças de dados|não desfaz/i);
  const fonte = fs.readFileSync(path.join(ajuda.RAIZ, "src", "implantacao.js"), "utf8");
  assert.match(fonte, /A reversão troca apenas o código/);
});

// --- Installation -------------------------------------------------------------------------------

function instalar(args, env = {}) {
  return new Promise((resolve) => {
    const filho = spawn(process.execPath, [path.join(ajuda.RAIZ, "instalacao", "instalar.js"), ...args], {
      env: { ...process.env, CONSOLE_SEM_PRIVILEGIO: "1", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let saida = "";
    filho.stdout.on("data", (d) => (saida += d));
    filho.stderr.on("data", (d) => (saida += d));
    filho.on("close", (codigo) => resolve({ codigo, saida }));
  });
}

test("installation assembles the side-by-side layout with a stable layer", async (t) => {
  const raiz = ajuda.dirTemporario("console-inst-raiz-");
  const estadoDir = ajuda.dirTemporario("console-inst-estado-");
  t.after(() => {
    fs.rmSync(raiz, { recursive: true, force: true });
    fs.rmSync(estadoDir, { recursive: true, force: true });
  });

  const r = await instalar(["--escopo", "usuario", "--raiz", raiz, "--estado", estadoDir, "--sem-servico"]);
  assert.equal(r.codigo, 0, r.saida);

  const versao = JSON.parse(fs.readFileSync(path.join(ajuda.RAIZ, "package.json"), "utf8")).version;
  assert.ok(fs.existsSync(path.join(raiz, "console-bootstrap.js")), "camada estável presente");
  assert.ok(fs.existsSync(path.join(raiz, "launcher-bootstrap.js")));
  assert.ok(fs.existsSync(path.join(raiz, "versoes", versao, "console.js")), "payload versionado");
  const estadoInstalacao = JSON.parse(fs.readFileSync(path.join(raiz, "estado-instalacao.json"), "utf8"));
  assert.equal(estadoInstalacao.versaoAtiva, versao);
  assert.equal(estadoInstalacao.escopo, "usuario");

  // The bootstrap secret is written to a protected file, not only to the screen.
  assert.ok(fs.existsSync(path.join(estadoDir, "bootstrap-token")));
  assert.match(r.saida, /Segredo de instalação/);
  assert.match(r.saida, /apagado assim que o operador for criado/);
});

test("reinstalling preserves credentials and does not generate a new secret", async (t) => {
  const raiz = ajuda.dirTemporario("console-inst-raiz-");
  const estadoDir = ajuda.dirTemporario("console-inst-estado-");
  t.after(() => {
    fs.rmSync(raiz, { recursive: true, force: true });
    fs.rmSync(estadoDir, { recursive: true, force: true });
  });

  await instalar(["--escopo", "usuario", "--raiz", raiz, "--estado", estadoDir, "--sem-servico"]);
  // Simulates an already created operator.
  fs.writeFileSync(
    path.join(estadoDir, "operadores.json"),
    JSON.stringify({ operadores: [{ nome: "op", senhaHash: "scrypt$1$1$1$a$b", criadoEm: new Date().toISOString() }] })
  );
  fs.rmSync(path.join(estadoDir, "bootstrap-token"), { force: true });

  const r = await instalar(["--escopo", "usuario", "--raiz", raiz, "--estado", estadoDir, "--sem-servico"]);
  assert.equal(r.codigo, 0, r.saida);
  assert.match(r.saida, /Operador já cadastrado; credenciais preservadas/);
  assert.ok(!fs.existsSync(path.join(estadoDir, "bootstrap-token")), "não recria segredo quando já há operador");
  const operadores = JSON.parse(fs.readFileSync(path.join(estadoDir, "operadores.json"), "utf8"));
  assert.equal(operadores.operadores[0].nome, "op", "credencial preservada");
});

test("migrating the old Linux layout moves atual/ to versoes/ without touching state", (t) => {
  const raiz = ajuda.dirTemporario("console-migra-");
  t.after(() => fs.rmSync(raiz, { recursive: true, force: true }));

  // Layout anterior: <raiz>/atual e <raiz>/anterior
  const antigo = path.join(raiz, "atual");
  fs.mkdirSync(antigo, { recursive: true });
  fs.writeFileSync(path.join(antigo, "package.json"), JSON.stringify({ version: "1.0.0" }));
  fs.writeFileSync(path.join(antigo, "console.js"), "module.exports={executar(){}};");
  fs.mkdirSync(path.join(raiz, "anterior"), { recursive: true });
  fs.writeFileSync(path.join(raiz, "anterior", "marcador"), "x");

  const { migrarLayoutAntigo } = require(path.join(ajuda.RAIZ, "instalacao", "instalar.js"));
  const r = migrarLayoutAntigo(raiz, () => {});
  assert.equal(r.migrou, true);
  assert.ok(fs.existsSync(path.join(raiz, "versoes", "1.0.0", "console.js")));
  assert.ok(!fs.existsSync(antigo), "o diretório antigo sai do lugar");
  assert.ok(!fs.existsSync(path.join(raiz, "anterior")), "a cópia antiga de reserva é removida");
});

test("the installer refuses a checkout that is not RemoteIFES", async (t) => {
  const raiz = ajuda.dirTemporario("console-inst-raiz-");
  const estadoDir = ajuda.dirTemporario("console-inst-estado-");
  const falso = ajuda.dirTemporario("nao-remoteifes-");
  t.after(() => {
    for (const d of [raiz, estadoDir, falso]) fs.rmSync(d, { recursive: true, force: true });
  });

  const r = await instalar(["--escopo", "usuario", "--raiz", raiz, "--estado", estadoDir, "--sem-servico", "--checkout", falso]);
  assert.equal(r.codigo, 1);
  assert.match(r.saida, /não parece um checkout do RemoteIFES/);
});

test("the bootstrap picks the active version and survives an invalid pointer", (t) => {
  const raiz = ajuda.dirTemporario("console-boot-");
  t.after(() => fs.rmSync(raiz, { recursive: true, force: true }));

  for (const v of ["1.0.0", "1.1.0"]) {
    const dir = path.join(raiz, "versoes", v);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: v }));
    fs.writeFileSync(path.join(dir, "console.js"), `module.exports={executar(){process.stdout.write("versao=${v}")}};`);
  }
  fs.copyFileSync(path.join(ajuda.RAIZ, "instalacao", "console-bootstrap.js"), path.join(raiz, "console-bootstrap.js"));

  const executar = () =>
    execFileSync(process.execPath, [path.join(raiz, "console-bootstrap.js")], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CONSOLE_SEM_PRIVILEGIO: "1" },
    });

  fs.writeFileSync(path.join(raiz, "estado-instalacao.json"), JSON.stringify({ versaoAtiva: "1.1.0", versaoAnterior: "1.0.0" }));
  assert.match(executar(), /versao=1\.1\.0/);

  // Pointer to a version that does not exist: falls back to the previous one instead of not
  // starting.
  fs.writeFileSync(path.join(raiz, "estado-instalacao.json"), JSON.stringify({ versaoAtiva: "9.9.9", versaoAnterior: "1.0.0" }));
  assert.match(executar(), /versao=1\.0\.0/);

  // No usable pointer: uses the newest present.
  fs.writeFileSync(path.join(raiz, "estado-instalacao.json"), JSON.stringify({}));
  assert.match(executar(), /versao=1\.1\.0/);
});

test("the runners have a shebang and are installed with execute permission", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());

  // The Git index stores these files as 100644; a runner without +x fails with EACCES on the first
  // real operation. The installer restores the bit from the shebang.
  for (const nome of fs.readdirSync(path.join(ajuda.RAIZ, "bin"))) {
    const conteudo = fs.readFileSync(path.join(ajuda.RAIZ, "bin", nome), "utf8");
    assert.match(conteudo.slice(0, 2), /#!/, `${nome} precisa de shebang para ser executável`);
  }

  const raiz = ajuda.dirTemporario("console-perm-");
  const { copiarArvore } = require(path.join(ajuda.RAIZ, "instalacao", "instalar.js"));
  copiarArvore(path.join(ajuda.RAIZ, "bin"), path.join(raiz, "bin"));
  if (process.platform !== "win32") {
    for (const nome of fs.readdirSync(path.join(raiz, "bin"))) {
      const modo = fs.statSync(path.join(raiz, "bin", nome)).mode & 0o777;
      assert.ok(modo & 0o100, `${nome} deveria ficar executável após a instalação (modo ${modo.toString(8)})`);
    }
  }
  fs.rmSync(raiz, { recursive: true, force: true });
});

// --- Uninstall -----------------------------------------------------------------------------

function instalacaoFalsa(prefixo = "console-des-") {
  const raiz = ajuda.dirTemporario(prefixo);
  fs.mkdirSync(path.join(raiz, "versoes", "1.0.0"), { recursive: true });
  fs.writeFileSync(path.join(raiz, "console-bootstrap.js"), "// camada estável\n");
  fs.writeFileSync(path.join(raiz, "estado-instalacao.json"), '{"versaoAtiva":"1.0.0"}\n');
  return raiz;
}

test("uninstall only removes a directory that proves to be a Console installation", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const { autorizarRemocao } = require(path.join(ajuda.RAIZ, "instalacao", "desinstalar.js"));
  const marcas = { marcas: ["console-bootstrap.js", "versoes", "estado-instalacao.json"], rotulo: "instalação do console" };

  const boa = instalacaoFalsa();
  t.after(() => fs.rmSync(boa, { recursive: true, force: true }));
  assert.equal(autorizarRemocao(boa, marcas).ok, true);

  // An arbitrary directory (a mistyped `--raiz`) never becomes a recursive removal.
  const qualquer = ajuda.dirTemporario("console-qualquer-");
  t.after(() => fs.rmSync(qualquer, { recursive: true, force: true }));
  fs.writeFileSync(path.join(qualquer, "documento-importante.txt"), "não me apague\n");
  const r = autorizarRemocao(qualquer, marcas);
  assert.equal(r.ok, false);
  assert.match(r.motivo, /não tem nenhuma marca/);
  assert.ok(fs.existsSync(path.join(qualquer, "documento-importante.txt")));

  // Disk root and home are refused before any other check.
  assert.equal(autorizarRemocao(path.parse(process.cwd()).root, marcas).ok, false);
  assert.match(autorizarRemocao(require("os").homedir(), marcas).motivo, /diretório do usuário|raso demais/);
});

test("uninstall never removes anything inside the RemoteIFES checkout", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const { autorizarRemocao } = require(path.join(ajuda.RAIZ, "instalacao", "desinstalar.js"));

  // Someone installed the Console inside the checkout itself. Recursive removal there would take
  // the application's code and database along, so it is refused even with every mark present.
  const checkout = ajuda.dirTemporario("console-chk-");
  t.after(() => fs.rmSync(checkout, { recursive: true, force: true }));
  fs.mkdirSync(path.join(checkout, "remoteifes-server"), { recursive: true });
  fs.writeFileSync(path.join(checkout, "remoteifes-server", "package.json"), "{}\n");

  const dentro = path.join(checkout, "ferramentas", "console");
  fs.mkdirSync(path.join(dentro, "versoes", "1.0.0"), { recursive: true });
  fs.writeFileSync(path.join(dentro, "console-bootstrap.js"), "// camada estável\n");
  fs.writeFileSync(path.join(dentro, "estado-instalacao.json"), '{"versaoAtiva":"1.0.0"}\n');

  const r = autorizarRemocao(dentro, { marcas: ["console-bootstrap.js", "versoes"], rotulo: "instalação do console" });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /checkout do RemoteIFES/);
});

test("uninstall preserves state by default and says where it was left", (t) => {
  const amb = ajuda.ambiente();
  const raiz = instalacaoFalsa();
  const estadoDir = ajuda.dirTemporario("console-est-");
  fs.writeFileSync(path.join(estadoDir, "operadores.json"), '{"operadores":[{"nome":"op"}]}\n');
  t.after(() => {
    amb.restaurar();
    for (const d of [raiz, estadoDir]) fs.rmSync(d, { recursive: true, force: true });
  });

  const r = rodarNode([path.join(ajuda.RAIZ, "instalacao", "desinstalar.js"), "--raiz", raiz, "--estado", estadoDir, "--sim"]);
  assert.equal(r.codigo, 0, r.saida);
  assert.ok(!fs.existsSync(path.join(raiz, "console-bootstrap.js")), "o programa sai");
  assert.ok(fs.existsSync(path.join(estadoDir, "operadores.json")), "o estado fica");
  assert.match(r.saida, /preservado em/);
  assert.match(r.saida, /--apagar-estado/);
  assert.match(r.saida, /checkout do RemoteIFES, seu banco e seus backups/);
});

test("a simulated uninstall removes nothing", (t) => {
  const amb = ajuda.ambiente();
  const raiz = instalacaoFalsa();
  t.after(() => {
    amb.restaurar();
    fs.rmSync(raiz, { recursive: true, force: true });
  });

  const r = rodarNode([path.join(ajuda.RAIZ, "instalacao", "desinstalar.js"), "--raiz", raiz, "--simular"]);
  assert.equal(r.codigo, 0, r.saida);
  assert.match(r.saida, /\[simulação\] removeria/);
  assert.ok(fs.existsSync(path.join(raiz, "console-bootstrap.js")), "a simulação não apaga o programa");
});

test("without a terminal and without --sim, uninstall refuses instead of assuming consent", (t) => {
  const amb = ajuda.ambiente();
  const raiz = instalacaoFalsa();
  t.after(() => {
    amb.restaurar();
    fs.rmSync(raiz, { recursive: true, force: true });
  });

  const r = rodarNode([path.join(ajuda.RAIZ, "instalacao", "desinstalar.js"), "--raiz", raiz]);
  assert.equal(r.codigo, 1);
  assert.match(r.saida, /exige --sim/);
  assert.ok(fs.existsSync(path.join(raiz, "console-bootstrap.js")));
});

test("REGRESSION: uninstalling from inside the installation removes the whole root", async (t) => {
  // The uninstaller lives inside what it deletes; that is how the documentation says to run it. On
  // Windows the running file keeps an open handle and its directory stays "not empty", so the root
  // would be left behind with EPERM. The uninstaller restarts from a copy outside the installation
  // so this does not depend on handle timing.
  const amb = ajuda.ambiente();
  const raiz = ajuda.dirTemporario("console-auto-");
  const estadoDir = ajuda.dirTemporario("console-auto-est-");
  t.after(() => {
    amb.restaurar();
    for (const d of [raiz, estadoDir]) fs.rmSync(d, { recursive: true, force: true });
  });

  const r = await instalar([
    "--escopo",
    "usuario",
    "--raiz",
    raiz,
    "--estado",
    estadoDir,
    "--sem-servico",
    "--checkout",
    path.join(ajuda.RAIZ, ".."),
  ]);
  assert.equal(r.codigo, 0, r.saida);

  const versao = JSON.parse(fs.readFileSync(path.join(ajuda.RAIZ, "package.json"), "utf8")).version;
  const deDentro = path.join(raiz, "versoes", versao, "instalacao", "desinstalar.js");
  assert.ok(fs.existsSync(deDentro), "o desinstalador viaja dentro do payload");

  const d = rodarNode([deDentro, "--raiz", raiz, "--estado", estadoDir, "--sim"]);
  assert.equal(d.codigo, 0, d.saida);
  assert.ok(!fs.existsSync(raiz), `a raiz inteira precisa sair; restou: ${fs.existsSync(raiz) ? fs.readdirSync(raiz).join(", ") : ""}`);
  assert.ok(fs.existsSync(path.join(estadoDir, "operadores.json")) || fs.existsSync(path.join(estadoDir, "bootstrap-token")), "o estado fica");
});

test("uninstall stops the running Console instead of leaving it orphaned", async (t) => {
  // Uninstall must not leave a live process still serving on loopback, with its identity contract
  // published and able to run privileged operations for a program that no longer exists. On Windows
  // and macOS the launcher starts the Console, so nothing else stops it.
  const amb = ajuda.ambiente();
  const raiz = ajuda.dirTemporario("console-vivo-");
  const estadoDir = ajuda.dirTemporario("console-vivo-est-");
  t.after(() => {
    amb.restaurar();
    for (const d of [raiz, estadoDir]) fs.rmSync(d, { recursive: true, force: true });
  });

  const inst = await instalar(["--escopo", "usuario", "--raiz", raiz, "--estado", estadoDir, "--sem-servico", "--checkout", path.join(ajuda.RAIZ, "..")]);
  assert.equal(inst.codigo, 0, inst.saida);
  const versao = JSON.parse(fs.readFileSync(path.join(ajuda.RAIZ, "package.json"), "utf8")).version;

  // Starts the Console from the installation, as the launcher would.
  const porta = 8531;
  const filho = spawn(process.execPath, [path.join(raiz, "console-bootstrap.js")], {
    env: { ...process.env, CONSOLE_SEM_PRIVILEGIO: "1", CONSOLE_ESTADO_DIR: estadoDir, CONSOLE_PORTA: String(porta), CONSOLE_OCIOSIDADE_S: "120" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    try {
      filho.kill("SIGKILL");
    } catch {}
  });

  const contrato = path.join(estadoDir, "endereco.json");
  let subiu = false;
  for (let i = 0; i < 60 && !subiu; i += 1) {
    if (fs.existsSync(contrato)) subiu = true;
    else await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(subiu, "o console instalado precisa subir para que o teste signifique algo");

  const r = rodarNode([path.join(raiz, "versoes", versao, "instalacao", "desinstalar.js"), "--raiz", raiz, "--estado", estadoDir, "--sim"]);
  assert.equal(r.codigo, 0, r.saida);
  assert.match(r.saida, /encerrando o console em execução/);
  assert.match(r.saida, /console encerrado/);
  assert.ok(!fs.existsSync(raiz), "o programa sai por inteiro");

  // The proof that matters: the port stopped answering.
  const aindaAtende = await new Promise((resolver) => {
    const req = http.request({ host: "127.0.0.1", port: porta, path: "/api/sessao", timeout: 2000 }, () => resolver(true));
    req.on("error", () => resolver(false));
    req.on("timeout", () => {
      req.destroy();
      resolver(false);
    });
    req.end();
  });
  assert.equal(aindaAtende, false, "o console não pode continuar atendendo depois de desinstalado");
});

test("uninstall does not stop an unrelated process that merely holds the port", async (t) => {
  // The contract PID does not authorize a kill by itself: PIDs are recycled and the port may have
  // been taken by another program. The identity proof authorizes it. Without it, nothing dies.
  const amb = ajuda.ambiente();
  const raiz = ajuda.dirTemporario("console-imp-");
  const estadoDir = ajuda.dirTemporario("console-imp-est-");
  t.after(() => {
    amb.restaurar();
    for (const d of [raiz, estadoDir]) fs.rmSync(d, { recursive: true, force: true });
  });

  const inst = await instalar(["--escopo", "usuario", "--raiz", raiz, "--estado", estadoDir, "--sem-servico", "--checkout", path.join(ajuda.RAIZ, "..")]);
  assert.equal(inst.codigo, 0, inst.saida);
  const versao = JSON.parse(fs.readFileSync(path.join(ajuda.RAIZ, "package.json"), "utf8")).version;

  // An arbitrary server on the port, and a contract pointing to it with a secret it does not know:
  // exactly the impostor scenario.
  const intruso = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ prova: "nao-e-a-prova-certa" }));
  });
  await new Promise((r) => intruso.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => intruso.close(() => r())));
  const portaIntruso = intruso.address().port;

  fs.writeFileSync(
    path.join(estadoDir, "endereco.json"),
    `${JSON.stringify({ porta: portaIntruso, pid: process.pid, modo: "tcp", versao, segredo: "c2VncmVkby1xdWUtbmluZ3VlbS1zYWJl" })}\n`
  );

  const r = await rodarNodeAsync([path.join(raiz, "versoes", versao, "instalacao", "desinstalar.js"), "--raiz", raiz, "--estado", estadoDir, "--sim"]);
  assert.match(r.saida, /NÃO é este console/, `esperava recusa de impostor. Saída:\n${r.saida}`);
  assert.match(r.saida, /Nada foi encerrado/);

  // The test process (whose pid was in the contract) is still alive, and so is the intruder.
  assert.equal(intruso.listening, true, "o processo alheio não pode ser encerrado");
});

test("REGRESSION: the installed shortcut starts the CONSOLE, not another copy of the launcher", async (t) => {
  // The system shortcut runs `launcher-bootstrap.js`, which sets CONSOLE_BOOTSTRAP_ALVO=launcher so
  // the bootstrap loads the launcher. If the launcher's backend inherited that environment, the
  // child bootstrap would load `launcher.js` again: a chain of detached launchers, each waiting 30
  // s and giving up, and the Console never starting.
  //
  // This test goes through the bootstrap as the shortcut does; calling `garantirBackend` in-process
  // would never set the variable.
  const amb = ajuda.ambiente();
  const raiz = ajuda.dirTemporario("console-rec-");
  const estadoDir = ajuda.dirTemporario("console-rec-est-");
  t.after(() => {
    amb.restaurar();
    for (const d of [raiz, estadoDir]) fs.rmSync(d, { recursive: true, force: true });
  });

  const inst = await instalar(["--escopo", "usuario", "--raiz", raiz, "--estado", estadoDir, "--sem-servico", "--checkout", path.join(ajuda.RAIZ, "..")]);
  assert.equal(inst.codigo, 0, inst.saida);

  const porta = 8553;
  const ambienteDoAtalho = {
    CONSOLE_ESTADO_DIR: estadoDir,
    CONSOLE_PORTA: String(porta),
    CONSOLE_OCIOSIDADE_S: "120",
    CONSOLE_RAIZ_INSTALACAO: raiz,
  };

  // Exactly what the shortcut does, requesting only the start (no browser).
  const r = await rodarNodeAsync([path.join(raiz, "launcher-bootstrap.js"), "--iniciar"], ambienteDoAtalho);
  assert.equal(r.codigo, 0, `o lançador do atalho precisa subir o console. Saída:\n${r.saida}`);
  assert.match(r.saida, /Console iniciado|Console já estava no ar/);

  // The proof: what started is the CONSOLE, which publishes an identity contract and serves HTTP. A
  // recursive launcher would publish no contract.
  const contrato = path.join(estadoDir, "endereco.json");
  assert.ok(fs.existsSync(contrato), "o console precisa publicar o contrato de identidade");
  const dados = JSON.parse(fs.readFileSync(contrato, "utf8"));
  assert.equal(dados.porta, porta);
  t.after(() => {
    try {
      require(path.join(ajuda.RAIZ, "src", "plataforma")).encerrarArvore(dados.pid, "SIGKILL");
    } catch {}
  });

  const atende = await new Promise((resolver) => {
    const req = http.request({ host: "127.0.0.1", port: porta, path: "/api/sessao", timeout: 5000 }, (res) => resolver(res.statusCode));
    req.on("error", () => resolver(0));
    req.on("timeout", () => {
      req.destroy();
      resolver(0);
    });
    req.end();
  });
  assert.ok(atende > 0, "o console iniciado pelo atalho tem de atender HTTP");
});

test("the Console bootstrap ignores a launcher target inherited from the environment", (t) => {
  // Defense in depth for the same defect: even if someone inherits the variable again, the file
  // must make clear which entry is loaded, and the launcher sends the value.
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());

  const lancador = fs.readFileSync(path.join(ajuda.RAIZ, "launcher.js"), "utf8");
  assert.match(
    lancador,
    /CONSOLE_BOOTSTRAP_ALVO:\s*"console"/,
    "ao subir o backend, o lançador precisa fixar o alvo do bootstrap em vez de herdá-lo"
  );
});

test("REGRESSION: the documented repair reinstalls over itself without destroying the payload", async (t) => {
  // The README and manual repair command runs `versoes/<v>/instalacao/instalar.js --forcar`. There
  // the SOURCE **is** the destination: deleting the destination before copying would remove the
  // source itself and end in ENOENT, leaving the installation unusable exactly when the operator
  // was trying to repair it.
  const amb = ajuda.ambiente();
  const raiz = ajuda.dirTemporario("console-rep-");
  const estadoDir = ajuda.dirTemporario("console-rep-est-");
  t.after(() => {
    amb.restaurar();
    for (const d of [raiz, estadoDir]) fs.rmSync(d, { recursive: true, force: true });
  });

  const inst = await instalar(["--escopo", "usuario", "--raiz", raiz, "--estado", estadoDir, "--sem-servico", "--checkout", path.join(ajuda.RAIZ, "..")]);
  assert.equal(inst.codigo, 0, inst.saida);
  const versao = JSON.parse(fs.readFileSync(path.join(ajuda.RAIZ, "package.json"), "utf8")).version;
  const instaladoEm = path.join(raiz, "versoes", versao);
  const antes = fs.readdirSync(instaladoEm).sort();

  // Exatamente o comando documentado, a partir do payload instalado.
  const r = await rodarNodeAsync([
    path.join(instaladoEm, "instalacao", "instalar.js"),
    "--escopo", "usuario", "--raiz", raiz, "--estado", estadoDir, "--sem-servico", "--forcar",
  ]);
  assert.equal(r.codigo, 0, `o reparo precisa concluir. Saída:\n${r.saida}`);

  assert.ok(fs.existsSync(path.join(instaladoEm, "console.js")), "o payload precisa sobreviver ao reparo");
  assert.ok(fs.existsSync(path.join(instaladoEm, "src", "servidor.js")));
  assert.ok(fs.existsSync(path.join(raiz, "console-bootstrap.js")), "a camada estável sobrevive");
  assert.deepEqual(fs.readdirSync(instaladoEm).sort(), antes, "o conteúdo do payload continua completo");
  assert.ok(!fs.readdirSync(path.join(raiz, "versoes")).some((n) => n.includes("parcial") || n.includes("substituido")), "nenhum estágio fica para trás");
});

test("--simular does not remove the system integration", async (t) => {
  // A rehearsal that changes the system is not a rehearsal. `removerInicializacao` stops the
  // Console and deletes the systemd units, the sudo rule and the privileged helper; it must not run
  // in simulation.
  const amb = ajuda.ambiente();
  const raiz = ajuda.dirTemporario("console-sim-");
  const estadoDir = ajuda.dirTemporario("console-sim-est-");
  t.after(() => {
    amb.restaurar();
    for (const d of [raiz, estadoDir]) fs.rmSync(d, { recursive: true, force: true });
  });

  const inst = await instalar(["--escopo", "usuario", "--raiz", raiz, "--estado", estadoDir, "--sem-servico", "--checkout", path.join(ajuda.RAIZ, "..")]);
  assert.equal(inst.codigo, 0, inst.saida);
  const versao = JSON.parse(fs.readFileSync(path.join(ajuda.RAIZ, "package.json"), "utf8")).version;

  const r = await rodarNodeAsync([path.join(raiz, "versoes", versao, "instalacao", "desinstalar.js"), "--raiz", raiz, "--estado", estadoDir, "--simular"]);
  assert.equal(r.codigo, 0, r.saida);

  assert.match(r.saida, /\[simulação\] removeria o registro de inicialização/, "a simulação precisa declarar o que faria");
  // None of the real path's messages may appear.
  for (const real of ["tarefa agendada removida", "não havia tarefa agendada registrada", "registro de inicialização removido"]) {
    assert.ok(!r.saida.includes(real), `a simulação executou o caminho real: "${real}"`);
  }
  assert.ok(fs.existsSync(path.join(raiz, "console-bootstrap.js")), "a simulação não apaga o programa");
});

test("removal authorization requires ALL installation marks, not just one", (t) => {
  // Accepting "at least one mark" would let an arbitrary directory that happens to contain a
  // `versoes/` be removed recursively. A mistyped `--raiz` is exactly the case this check exists to
  // catch.
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const { autorizarRemocao } = require(path.join(ajuda.RAIZ, "instalacao", "desinstalar.js"));
  const marcas = ["console-bootstrap.js", "versoes", "estado-instalacao.json"];

  const parcial = ajuda.dirTemporario("console-parcial-");
  t.after(() => fs.rmSync(parcial, { recursive: true, force: true }));
  // Only one mark: someone else's working directory that contains a "versoes".
  fs.mkdirSync(path.join(parcial, "versoes"), { recursive: true });
  fs.writeFileSync(path.join(parcial, "planilha-do-setor.csv"), "nao me apague\n");

  const r = autorizarRemocao(parcial, { marcas, rotulo: "instalação do console", exigirTodas: true });
  assert.equal(r.ok, false, "uma marca sozinha não pode autorizar remoção recursiva");
  assert.match(r.motivo, /faltam:/);
  assert.ok(fs.existsSync(path.join(parcial, "planilha-do-setor.csv")));

  // With every mark, it is authorized.
  const completa = ajuda.dirTemporario("console-completa-");
  t.after(() => fs.rmSync(completa, { recursive: true, force: true }));
  fs.mkdirSync(path.join(completa, "versoes"), { recursive: true });
  fs.writeFileSync(path.join(completa, "console-bootstrap.js"), "//\n");
  fs.writeFileSync(path.join(completa, "estado-instalacao.json"), "{}\n");
  assert.equal(autorizarRemocao(completa, { marcas, rotulo: "instalação do console", exigirTodas: true }).ok, true);
});

test("the Windows shortcut uses the .vbs extension, because wscript picks the engine by extension", (t) => {
  // VBScript in a .js file is parsed as JScript and fails; with `//B` the error is silent and the
  // Start Menu shortcut opens nothing. wscript.exe exits 1 for .js and 0 for .vbs with the same
  // content.
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const fonte = fs.readFileSync(path.join(ajuda.RAIZ, "instalacao", "instalar.js"), "utf8");

  assert.match(fonte, /abrir-console\.vbs/, "o script oculto do Windows precisa ser .vbs");
  assert.ok(!/abrir-console\.js/.test(fonte), "não pode sobrar referência ao .js");
  // And the written content is still VBScript, consistent with the extension.
  assert.match(fonte, /CreateObject\("WScript\.Shell"\)/);
});

test("rollback refuses a dirty tree and does not discard local work", async (t) => {
  // `reverter()` must consult the checkout state before `reset --hard`/`checkout --force`, as
  // `implantar()` does. Both operations swap code the same way, so "never discards local work" must
  // hold for both.
  const checkout = checkoutGit();
  const amb = ajuda.ambiente({ checkout });
  t.after(() => {
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });
  const implantacao = require(path.join(ajuda.RAIZ, "src", "implantacao.js"));

  // A second commit, so there is somewhere to go back from and to.
  fs.writeFileSync(path.join(checkout, "remoteifes-server", "novo.js"), "// v2\n");
  git(checkout, ["add", "-A"]);
  git(checkout, ["commit", "--quiet", "-m", "v2"]);
  const destino = git(checkout, ["rev-parse", "HEAD~1"]);

  // TRACKED local work, not committed.
  const rastreado = path.join(checkout, "remoteifes-server", "package.json");
  const conteudoRastreado = `${fs.readFileSync(rastreado, "utf8")}\n// ajuste local em andamento\n`;
  fs.writeFileSync(rastreado, conteudoRastreado);

  const r = await implantacao.reverter({ alvo: destino, offline: true, semReiniciar: true, log: () => {} });
  assert.equal(r.ok, false, "a reversão não pode prosseguir com árvore suja");
  assert.match(r.erro, /nunca descarta trabalho local/);
  assert.equal(fs.readFileSync(rastreado, "utf8"), conteudoRastreado, "o arquivo local fica intacto");
  assert.equal(git(checkout, ["rev-parse", "HEAD"]), git(checkout, ["rev-parse", "main"]), "HEAD não se move");
});

test("an untracked file also counts as local work", async (t) => {
  // With `--untracked-files=no` an untracked file was invisible, and a `checkout --force` to a
  // commit that now contains the same path overwrote it without warning.
  const checkout = checkoutGit();
  const amb = ajuda.ambiente({ checkout });
  t.after(() => {
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });
  const implantacao = require(path.join(ajuda.RAIZ, "src", "implantacao.js"));

  const naoRastreado = path.join(checkout, "remoteifes-server", "rascunho-do-operador.txt");
  fs.writeFileSync(naoRastreado, "medições que eu não quero perder\n");

  const estado = await implantacao.estadoDoCheckout();
  assert.equal(estado.limpo, false, "um arquivo não rastreado deixa a árvore suja");
  assert.ok(
    estado.naoRastreados.some((n) => n.includes("rascunho-do-operador")),
    `o não rastreado precisa ser nomeado; recebi ${JSON.stringify(estado.naoRastreados)}`
  );

  const r = await implantacao.implantar({ commit: git(checkout, ["rev-parse", "HEAD"]), offline: true, semReiniciar: true, log: () => {} });
  assert.equal(r.ok, false);
  assert.equal(fs.readFileSync(naoRastreado, "utf8"), "medições que eu não quero perder\n");
});

test("REGRESSION: the program started from the shortcut finds state where the installer put it", async (t) => {
  // The shortcut runs the bootstrap with no environment variable. Without recording where state
  // lives, a user installation (or one with its own --estado) would look in the platform default,
  // and the first operator would not find the token the installer had just written; on Linux the
  // process would also get EACCES.
  const amb = ajuda.ambiente();
  const raiz = ajuda.dirTemporario("console-pers-");
  const estadoDir = ajuda.dirTemporario("console-pers-est-");
  t.after(() => {
    amb.restaurar();
    for (const d of [raiz, estadoDir]) fs.rmSync(d, { recursive: true, force: true });
  });

  const porta = 8573;
  const inst = await instalar([
    "--escopo", "usuario", "--raiz", raiz, "--estado", estadoDir,
    "--porta", String(porta), "--sem-servico", "--checkout", path.join(ajuda.RAIZ, ".."),
  ]);
  assert.equal(inst.codigo, 0, inst.saida);

  // The record must say where everything is.
  const registro = JSON.parse(fs.readFileSync(path.join(raiz, "estado-instalacao.json"), "utf8"));
  assert.equal(registro.escopo, "usuario");
  assert.equal(path.resolve(registro.estado), path.resolve(estadoDir), "o diretório de estado precisa ficar registrado");
  assert.equal(registro.porta, porta, "a porta escolhida precisa ficar registrada");
  assert.ok(fs.existsSync(path.join(estadoDir, "bootstrap-token")), "o token do primeiro operador está no estado registrado");

  // Start as the shortcut does: WITHOUT CONSOLE_ESTADO_DIR and WITHOUT CONSOLE_PORTA. `undefined`
  // REMOVES the variable in the child; `delete` on an object later spread over `process.env` would
  // remove nothing, and the test would measure the test process's environment instead of the
  // recorded discovery.
  const limpo = {
    CONSOLE_SEM_PRIVILEGIO: "1",
    CONSOLE_OCIOSIDADE_S: "120",
    CONSOLE_ESTADO_DIR: undefined,
    CONSOLE_PORTA: undefined,
    CONSOLE_RAIZ_INSTALACAO: undefined,
    CONSOLE_CHECKOUT_DIR: undefined,
  };

  const r = await rodarNodeAsync([path.join(raiz, "launcher-bootstrap.js"), "--iniciar"], limpo);
  assert.equal(r.codigo, 0, `o atalho precisa subir o console sem ambiente injetado. Saída:\n${r.saida}`);

  // A prova: o contrato aparece no estado REGISTRADO, e na porta registrada.
  const contrato = path.join(estadoDir, "endereco.json");
  assert.ok(fs.existsSync(contrato), "o contrato precisa aparecer no diretório de estado registrado");
  const dados = JSON.parse(fs.readFileSync(contrato, "utf8"));
  assert.equal(dados.porta, porta, "a porta registrada precisa ser a usada");
  t.after(() => {
    try {
      require(path.join(ajuda.RAIZ, "src", "plataforma")).encerrarArvore(dados.pid, "SIGKILL");
    } catch {}
  });
});

test("update and rollback do not erase the recorded scope or state", (t) => {
  // The record holds more than the pointer. Replacing the whole object on each version switch would
  // erase scope, state, logs and port, and the installation would look for state in the platform
  // default on the next start.
  const raiz = ajuda.dirTemporario("console-merge-");
  const amb = ajuda.ambiente({ env: { CONSOLE_RAIZ_INSTALACAO: raiz } });
  t.after(() => {
    amb.restaurar();
    fs.rmSync(raiz, { recursive: true, force: true });
  });
  const atualizador = require(path.join(ajuda.RAIZ, "src", "atualizador.js"));

  fs.writeFileSync(
    path.join(raiz, "estado-instalacao.json"),
    `${JSON.stringify({ versaoAtiva: "1.0.0", versaoAnterior: null, transacao: null, escopo: "usuario", estado: "/caminho/registrado", porta: 8123 })}\n`
  );

  atualizador.gravarEstadoInstalacao({ versaoAtiva: "2.0.0", versaoAnterior: "1.0.0", transacao: null });

  const depois = atualizador.lerEstadoInstalacao();
  assert.equal(depois.versaoAtiva, "2.0.0", "o ponteiro muda");
  assert.equal(depois.escopo, "usuario", "o escopo sobrevive");
  assert.equal(depois.estado, "/caminho/registrado", "o diretório de estado sobrevive");
  assert.equal(depois.porta, 8123, "a porta sobrevive");
});

test("uninstall refuses to delete the program when it cannot prove the Console stopped", async (t) => {
  // A termination exception must not be read as "not stopped" followed by deletion, and a failed
  // identity request during the wait (including a timeout) must not count as "stopped". Deleting
  // the program while an authenticated process stays alive is the worst possible outcome.
  const amb = ajuda.ambiente();
  const raiz = ajuda.dirTemporario("console-prova-");
  const estadoDir = ajuda.dirTemporario("console-prova-est-");
  t.after(() => {
    amb.restaurar();
    for (const d of [raiz, estadoDir]) fs.rmSync(d, { recursive: true, force: true });
  });

  const inst = await instalar(["--escopo", "usuario", "--raiz", raiz, "--estado", estadoDir, "--sem-servico", "--checkout", path.join(ajuda.RAIZ, "..")]);
  assert.equal(inst.codigo, 0, inst.saida);
  const versao = JSON.parse(fs.readFileSync(path.join(ajuda.RAIZ, "package.json"), "utf8")).version;

  // A "Console" that proves identity correctly and NEVER dies: the contract pid belongs to a
  // process the uninstaller cannot kill (itself), so the port stays open.
  const crypto = require("crypto");
  const segredo = crypto.randomBytes(32).toString("base64url");
  const teimoso = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const desafio = url.searchParams.get("desafio");
    if (url.pathname === "/api/identidade" && desafio) {
      const prova = crypto.createHmac("sha256", Buffer.from(segredo, "base64url")).update(desafio).digest("base64url");
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ prova, versao }));
    }
    res.writeHead(200);
    res.end("{}");
  });
  await new Promise((r) => teimoso.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => teimoso.close(() => r())));

  // The contract points to a pid that is NOT the server (a nonexistent pid): termination "succeeds"
  // with nothing dying, and the port keeps accepting connections.
  fs.writeFileSync(
    path.join(estadoDir, "endereco.json"),
    `${JSON.stringify({ porta: teimoso.address().port, pid: 999999, modo: "tcp", versao, segredo })}\n`
  );

  const r = await rodarNodeAsync([path.join(raiz, "versoes", versao, "instalacao", "desinstalar.js"), "--raiz", raiz, "--estado", estadoDir, "--sim"], { CONSOLE_PARADA_MS: "1200" });
  assert.equal(r.codigo, 1, `a desinstalação tem de falhar sem prova de parada. Saída:\n${r.saida}`);
  assert.match(r.saida, /não foi possível confirmar que o console parou/);
  assert.ok(fs.existsSync(path.join(raiz, "console-bootstrap.js")), "o programa NÃO pode ser removido sem prova de parada");
});

test("the uninstaller re-execution forwards the scope instead of letting the copy guess", async (t) => {
  // The temporary copy does not live inside an installation and cannot infer anything. Without the
  // scope being forwarded, a user uninstall would become system scope in the child: it would leave
  // the user integration installed and could touch another installation's system integration.
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const fonte = fs.readFileSync(path.join(ajuda.RAIZ, "instalacao", "desinstalar.js"), "utf8");

  assert.match(fonte, /"--escopo", escopoEfetivo/, "o escopo resolvido precisa ir para a cópia temporária");
  assert.match(
    fonte,
    /a === "--raiz" \|\| a === "--estado" \|\| a === "--escopo"/,
    "o escopo original precisa ser filtrado para não duplicar com o resolvido"
  );
});

test("payload replacement restores the previous version if the second rename fails", (t) => {
  // Between the two renames the active version does not exist. If the second fails, the payload
  // must not remain only under `.substituido-*` with the pointer at a missing directory.
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const fonte = fs.readFileSync(path.join(ajuda.RAIZ, "instalacao", "instalar.js"), "utf8");

  assert.match(fonte, /fs\.renameSync\(aposentado, destinoVersao\)/, "a falha do segundo rename precisa restaurar o anterior");
  assert.match(fonte, /a versão anterior foi restaurada/);
});

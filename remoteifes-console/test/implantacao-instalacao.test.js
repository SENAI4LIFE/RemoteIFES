const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { execFileSync, spawn } = require("child_process");
const ajuda = require("./ajuda");

// Implantação portátil e instalação. Aqui mora a regressão do defeito que tornava a
// implantação gerenciada impossível: console e script disputando a mesma trava.

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
  // O checkout real ignora `remoteifes-server/data/`; sem isso o preflight veria o diretório
  // de dados como trabalho local não rastreado e recusaria toda operação — artefato do
  // fixture, não do produto.
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
 * Versão assíncrona, obrigatória quando o teste também precisa ATENDER requisições enquanto o
 * script roda: `spawnSync` bloqueia o event loop, e um servidor falso hospedado no próprio
 * processo de teste jamais responderia ao desafio de identidade.
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

/** Roda um script do console e devolve saída e código, sem estourar em falha esperada. */
function rodarNode(args, env) {
  const r = require("child_process").spawnSync(process.execPath, args, {
    env: { ...process.env, CONSOLE_SEM_PRIVILEGIO: "1", ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
  return { codigo: r.status, saida: `${r.stdout || ""}${r.stderr || ""}` };
}

// --- Regressão da trava --------------------------------------------------------------------

test("REGRESSÃO: a implantação gerenciada não disputa a trava consigo mesma", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());

  // O defeito: a ação declarava `exigeTrava: true` (o console tomava .deploy-lock) e em
  // seguida executava `deploy.sh`, que tenta tomar a MESMA trava com noclobber. A implantação
  // abortava sempre, no primeiro passo. A trava passou a ser adquirida só pelo runner.
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

test("o runner adquire a trava uma vez e a libera ao terminar", async (t) => {
  const checkout = checkoutGit();
  const amb = ajuda.ambiente({ checkout });
  t.after(() => {
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  const trava = path.join(checkout, "remoteifes-server", "data", ".deploy-lock");
  assert.ok(!fs.existsSync(trava));

  // Alvo inexistente: falha depois de adquirir a trava, o que é justamente o que queremos
  // observar — a trava tem de ser liberada mesmo no caminho de erro.
  const r = await rodar("implantar.js", ["aplicar", "b".repeat(40)], {
    CONSOLE_CHECKOUT_DIR: checkout,
    CONSOLE_ESTADO_DIR: amb.estadoDir,
  });
  assert.equal(r.codigo, 1);
  assert.match(r.saida, /não foi possível resolver o alvo/);
  assert.ok(!fs.existsSync(trava), "a trava não pode ficar para trás");
});

test("o runner recusa começar quando outra manutenção viva detém a trava", async (t) => {
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

// --- Implantação portátil --------------------------------------------------------------------

test("a implantação recusa checkout sujo e nunca descarta trabalho local", async (t) => {
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

test("a implantação não usa bash nem systemctl diretamente", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());

  const fonte = fs.readFileSync(path.join(ajuda.RAIZ, "src", "implantacao.js"), "utf8");
  assert.ok(!/["']bash["']/.test(fonte), "a implantação portátil não pode depender de bash");
  assert.ok(!/systemctl/.test(fonte), "o controle de serviço é do adaptador de plataforma");
  assert.match(fonte, /plataforma\.controlarServico/, "o reinício vai pelo adaptador");
});

test("aguardarVersao exige o commit do processo, e aceita legado só com reinício comprovado", async (t) => {
  const checkout = checkoutGit();
  const amb = ajuda.ambiente({ checkout });
  t.after(() => {
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });
  const implantacao = require(path.join(ajuda.RAIZ, "src", "implantacao.js"));

  // Sem aplicação no ar, nenhuma confirmação é possível — e isso é falha, não sucesso.
  const r = await implantacao.aguardarVersao("a".repeat(40), { reinicioEm: Date.now(), tentativas: 1, intervaloMs: 10 });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /não respondeu saudável/);
});

test("uma versão sem release.js é tratada como legado, não como erro", async (t) => {
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

test("a reversão avisa que troca só o código, sem tocar no banco", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());

  const acao = amb.acoes.obter("atualizacao.reverter");
  assert.match(acao.impacto, /NÃO desfaz mudanças de dados|não desfaz/i);
  const fonte = fs.readFileSync(path.join(ajuda.RAIZ, "src", "implantacao.js"), "utf8");
  assert.match(fonte, /Troca \*\*apenas o código\*\*/);
});

// --- Instalação -------------------------------------------------------------------------------

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

test("a instalação monta o layout lado a lado com camada estável", async (t) => {
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

  // O segredo de bootstrap sai por arquivo protegido, não só pela tela.
  assert.ok(fs.existsSync(path.join(estadoDir, "bootstrap-token")));
  assert.match(r.saida, /Segredo de instalação/);
  assert.match(r.saida, /apagado assim que o operador for criado/);
});

test("reinstalar preserva credenciais e não gera segredo novo", async (t) => {
  const raiz = ajuda.dirTemporario("console-inst-raiz-");
  const estadoDir = ajuda.dirTemporario("console-inst-estado-");
  t.after(() => {
    fs.rmSync(raiz, { recursive: true, force: true });
    fs.rmSync(estadoDir, { recursive: true, force: true });
  });

  await instalar(["--escopo", "usuario", "--raiz", raiz, "--estado", estadoDir, "--sem-servico"]);
  // Simula um operador já criado.
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

test("a migração do layout Linux antigo move atual/ para versoes/ sem tocar no estado", (t) => {
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

test("o instalador recusa um checkout que não é do RemoteIFES", async (t) => {
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

test("o bootstrap escolhe a versão ativa e sobrevive a um ponteiro inválido", (t) => {
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

  // Ponteiro para uma versão que não existe: cai para a anterior em vez de não subir.
  fs.writeFileSync(path.join(raiz, "estado-instalacao.json"), JSON.stringify({ versaoAtiva: "9.9.9", versaoAnterior: "1.0.0" }));
  assert.match(executar(), /versao=1\.0\.0/);

  // Sem ponteiro utilizável: usa a mais recente presente.
  fs.writeFileSync(path.join(raiz, "estado-instalacao.json"), JSON.stringify({}));
  assert.match(executar(), /versao=1\.1\.0/);
});

test("os runners têm shebang e são instalados com permissão de execução", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());

  // O índice do Git guardava estes arquivos como 100644; um runner sem +x falhava com EACCES
  // na primeira operação real. O instalador repõe o bit a partir do shebang.
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

// --- Desinstalação -----------------------------------------------------------------------------

function instalacaoFalsa(prefixo = "console-des-") {
  const raiz = ajuda.dirTemporario(prefixo);
  fs.mkdirSync(path.join(raiz, "versoes", "1.0.0"), { recursive: true });
  fs.writeFileSync(path.join(raiz, "console-bootstrap.js"), "// camada estável\n");
  fs.writeFileSync(path.join(raiz, "estado-instalacao.json"), '{"versaoAtiva":"1.0.0"}\n');
  return raiz;
}

test("a desinstalação só remove um diretório que prove ser uma instalação do console", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const { autorizarRemocao } = require(path.join(ajuda.RAIZ, "instalacao", "desinstalar.js"));
  const marcas = { marcas: ["console-bootstrap.js", "versoes", "estado-instalacao.json"], rotulo: "instalação do console" };

  const boa = instalacaoFalsa();
  t.after(() => fs.rmSync(boa, { recursive: true, force: true }));
  assert.equal(autorizarRemocao(boa, marcas).ok, true);

  // Um diretório qualquer — um `--raiz` digitado errado — nunca vira remoção recursiva.
  const qualquer = ajuda.dirTemporario("console-qualquer-");
  t.after(() => fs.rmSync(qualquer, { recursive: true, force: true }));
  fs.writeFileSync(path.join(qualquer, "documento-importante.txt"), "não me apague\n");
  const r = autorizarRemocao(qualquer, marcas);
  assert.equal(r.ok, false);
  assert.match(r.motivo, /não tem nenhuma marca/);
  assert.ok(fs.existsSync(path.join(qualquer, "documento-importante.txt")));

  // Raiz de disco e home são recusadas antes de qualquer outra verificação.
  assert.equal(autorizarRemocao(path.parse(process.cwd()).root, marcas).ok, false);
  assert.match(autorizarRemocao(require("os").homedir(), marcas).motivo, /diretório do usuário|raso demais/);
});

test("a desinstalação nunca remove nada de dentro do checkout do RemoteIFES", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const { autorizarRemocao } = require(path.join(ajuda.RAIZ, "instalacao", "desinstalar.js"));

  // Alguém instalou o console dentro do próprio checkout. A remoção recursiva ali arrastaria
  // código e banco da aplicação junto, então é recusada mesmo com todas as marcas presentes.
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

test("a desinstalação preserva o estado por padrão e diz onde ele ficou", (t) => {
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

test("a simulação da desinstalação não remove nada", (t) => {
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

test("sem terminal e sem --sim, a desinstalação recusa em vez de assumir consentimento", (t) => {
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

test("REGRESSÃO: desinstalar de dentro da própria instalação remove a raiz inteira", async (t) => {
  // O desinstalador mora dentro do que ele apaga — é assim que a documentação manda rodá-lo.
  // No Windows, o arquivo em execução mantém um handle aberto e o diretório que o contém fica
  // "não vazio": o conteúdo sumia e a raiz ficava para trás com EPERM. O desinstalador recomeça
  // de uma cópia fora da instalação justamente para que isso não dependa de sorte de handle.
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

test("desinstalar encerra o console que está no ar, em vez de deixá-lo órfão", async (t) => {
  // A desinstalação "dava certo" e deixava um processo vivo: ainda atendendo no loopback, ainda
  // com o contrato de identidade publicado, ainda capaz de executar operações privilegiadas de
  // um programa que para o operador já não existe. No Linux o `systemctl disable --now` cobria
  // isso por acidente; no Windows e no macOS, onde quem sobe o console é o lançador, nada
  // parava o processo.
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

  // Sobe o console a partir da instalação, como o lançador faria.
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

  // A prova que importa: a porta parou de atender.
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

test("a desinstalação não encerra um processo alheio que só ocupa a porta", async (t) => {
  // O PID do contrato não autoriza um kill por si só: PID é reciclado, e a porta pode ter sido
  // tomada por outro programa. Quem autoriza é a prova de identidade. Sem ela, nada morre.
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

  // Um servidor qualquer na porta, e um contrato que aponta para ele com um segredo que ele
  // não conhece — exatamente o cenário do impostor.
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

  // O processo do teste (cujo pid estava no contrato) continua vivo, e o intruso também.
  assert.equal(intruso.listening, true, "o processo alheio não pode ser encerrado");
});

test("REGRESSÃO: o atalho instalado sobe o CONSOLE, não outra cópia do lançador", async (t) => {
  // O atalho do sistema executa `launcher-bootstrap.js`, que marca CONSOLE_BOOTSTRAP_ALVO=launcher
  // para que o bootstrap carregue o lançador. O lançador então sobe o backend — e herdava aquele
  // ambiente, de modo que o bootstrap filho carregava `launcher.js` de novo: um lançador subindo
  // outro lançador, destacado, cada um esperando 30 s e desistindo, em cadeia, sem nunca subir o
  // console. Era o caminho normal de quem abre pelo atalho no Windows e no macOS.
  //
  // Os testes anteriores não pegavam porque exercitavam `garantirBackend` dentro do processo, sem
  // passar pelo bootstrap, então a variável nunca estava marcada.
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

  // Exatamente o que o atalho faz, pedindo só a partida (sem abrir navegador).
  const r = await rodarNodeAsync([path.join(raiz, "launcher-bootstrap.js"), "--iniciar"], ambienteDoAtalho);
  assert.equal(r.codigo, 0, `o lançador do atalho precisa subir o console. Saída:\n${r.saida}`);
  assert.match(r.saida, /Console iniciado|Console já estava no ar/);

  // A prova: quem subiu é o CONSOLE — ele publica contrato de identidade e atende HTTP. Um
  // lançador recursivo não publicaria contrato nenhum.
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

test("o bootstrap do console ignora um alvo de lançador herdado do ambiente", (t) => {
  // Defesa em profundidade para o mesmo defeito: mesmo que alguém volte a herdar a variável, é
  // preciso que fique claro no arquivo qual entrada é carregada, e o lançador manda o valor.
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());

  const lancador = fs.readFileSync(path.join(ajuda.RAIZ, "launcher.js"), "utf8");
  assert.match(
    lancador,
    /CONSOLE_BOOTSTRAP_ALVO:\s*"console"/,
    "ao subir o backend, o lançador precisa fixar o alvo do bootstrap em vez de herdá-lo"
  );
});

test("REGRESSÃO: o reparo documentado reinstala por cima de si mesmo sem destruir o payload", async (t) => {
  // O comando de reparo do README e do manual roda `versoes/<v>/instalacao/instalar.js --forcar`.
  // Ali a ORIGEM **é** o destino: apagar o destino antes de copiar removia a própria origem e
  // terminava em ENOENT, deixando a instalação inutilizável — exatamente quando o operador
  // estava tentando consertá-la.
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

test("--simular não remove a integração com o sistema", async (t) => {
  // Um ensaio que mexe no sistema não é ensaio. `removerInicializacao` para o console, apaga
  // unidades do systemd, a regra de sudo e o auxiliar privilegiado: chamá-la em simulação
  // desmontava de verdade a instalação que o operador só queria inspecionar.
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
  // Nenhuma das mensagens do caminho real pode aparecer.
  for (const real of ["tarefa agendada removida", "não havia tarefa agendada registrada", "registro de inicialização removido"]) {
    assert.ok(!r.saida.includes(real), `a simulação executou o caminho real: "${real}"`);
  }
  assert.ok(fs.existsSync(path.join(raiz, "console-bootstrap.js")), "a simulação não apaga o programa");
});

test("a autorização de remoção exige TODAS as marcas da instalação, não apenas uma", (t) => {
  // Aceitar "pelo menos uma marca" deixava um diretório qualquer que por acaso tivesse um
  // `versoes/` dentro ser apagado recursivamente. Um `--raiz` digitado errado é justamente o
  // caso que esta verificação existe para pegar.
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const { autorizarRemocao } = require(path.join(ajuda.RAIZ, "instalacao", "desinstalar.js"));
  const marcas = ["console-bootstrap.js", "versoes", "estado-instalacao.json"];

  const parcial = ajuda.dirTemporario("console-parcial-");
  t.after(() => fs.rmSync(parcial, { recursive: true, force: true }));
  // Só uma marca: um diretório de trabalho alheio que contém um "versoes".
  fs.mkdirSync(path.join(parcial, "versoes"), { recursive: true });
  fs.writeFileSync(path.join(parcial, "planilha-do-setor.csv"), "nao me apague\n");

  const r = autorizarRemocao(parcial, { marcas, rotulo: "instalação do console", exigirTodas: true });
  assert.equal(r.ok, false, "uma marca sozinha não pode autorizar remoção recursiva");
  assert.match(r.motivo, /faltam:/);
  assert.ok(fs.existsSync(path.join(parcial, "planilha-do-setor.csv")));

  // Com todas as marcas, autoriza.
  const completa = ajuda.dirTemporario("console-completa-");
  t.after(() => fs.rmSync(completa, { recursive: true, force: true }));
  fs.mkdirSync(path.join(completa, "versoes"), { recursive: true });
  fs.writeFileSync(path.join(completa, "console-bootstrap.js"), "//\n");
  fs.writeFileSync(path.join(completa, "estado-instalacao.json"), "{}\n");
  assert.equal(autorizarRemocao(completa, { marcas, rotulo: "instalação do console", exigirTodas: true }).ok, true);
});

test("o atalho do Windows usa extensão .vbs, porque o wscript escolhe o motor pela extensão", (t) => {
  // VBScript num arquivo .js é interpretado como JScript e falha; com `//B` o erro é silencioso
  // e o atalho do menu Iniciar simplesmente não abre nada. Verificado empiricamente:
  // wscript.exe sai com 1 no .js e 0 no .vbs para o mesmo conteúdo.
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const fonte = fs.readFileSync(path.join(ajuda.RAIZ, "instalacao", "instalar.js"), "utf8");

  assert.match(fonte, /abrir-console\.vbs/, "o script oculto do Windows precisa ser .vbs");
  assert.ok(!/abrir-console\.js/.test(fonte), "não pode sobrar referência ao .js");
  // E o conteúdo gravado continua sendo VBScript, coerente com a extensão.
  assert.match(fonte, /CreateObject\("WScript\.Shell"\)/);
});

test("a reversão recusa árvore suja e não descarta trabalho local", async (t) => {
  // `implantar()` já recusava; `reverter()` lia o estado do checkout e não o consultava, seguindo
  // para `reset --hard`/`checkout --force`. As duas operações trocam código do mesmo jeito, então
  // a garantia "nunca descarta trabalho local" tem de valer para as duas.
  const checkout = checkoutGit();
  const amb = ajuda.ambiente({ checkout });
  t.after(() => {
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });
  const implantacao = require(path.join(ajuda.RAIZ, "src", "implantacao.js"));

  // Um segundo commit, para haver de onde e para onde voltar.
  fs.writeFileSync(path.join(checkout, "remoteifes-server", "novo.js"), "// v2\n");
  git(checkout, ["add", "-A"]);
  git(checkout, ["commit", "--quiet", "-m", "v2"]);
  const destino = git(checkout, ["rev-parse", "HEAD~1"]);

  // Trabalho local RASTREADO, não commitado.
  const rastreado = path.join(checkout, "remoteifes-server", "package.json");
  const conteudoRastreado = `${fs.readFileSync(rastreado, "utf8")}\n// ajuste local em andamento\n`;
  fs.writeFileSync(rastreado, conteudoRastreado);

  const r = await implantacao.reverter({ alvo: destino, offline: true, semReiniciar: true, log: () => {} });
  assert.equal(r.ok, false, "a reversão não pode prosseguir com árvore suja");
  assert.match(r.erro, /nunca descarta trabalho local/);
  assert.equal(fs.readFileSync(rastreado, "utf8"), conteudoRastreado, "o arquivo local fica intacto");
  assert.equal(git(checkout, ["rev-parse", "HEAD"]), git(checkout, ["rev-parse", "main"]), "HEAD não se move");
});

test("arquivo não rastreado também conta como trabalho local", async (t) => {
  // Com `--untracked-files=no` um arquivo não rastreado era invisível, e um `checkout --force`
  // para um commit que passou a conter aquele mesmo caminho o sobrescrevia sem aviso.
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

test("REGRESSÃO: o programa iniciado pelo atalho acha o estado onde o instalador o pôs", async (t) => {
  // O atalho roda o bootstrap sem variável de ambiente nenhuma. Sem registrar onde o estado
  // mora, uma instalação de usuário (ou com --estado próprio) procurava no padrão da plataforma,
  // e o primeiro operador não encontrava o token que o instalador tinha acabado de gravar — no
  // Linux o processo ainda tomava EACCES. A CI escondia isso porque sempre definia
  // CONSOLE_ESTADO_DIR.
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

  // O registro tem de dizer onde tudo está.
  const registro = JSON.parse(fs.readFileSync(path.join(raiz, "estado-instalacao.json"), "utf8"));
  assert.equal(registro.escopo, "usuario");
  assert.equal(path.resolve(registro.estado), path.resolve(estadoDir), "o diretório de estado precisa ficar registrado");
  assert.equal(registro.porta, porta, "a porta escolhida precisa ficar registrada");
  assert.ok(fs.existsSync(path.join(estadoDir, "bootstrap-token")), "o token do primeiro operador está no estado registrado");

  // Partida como o atalho faz: SEM CONSOLE_ESTADO_DIR e SEM CONSOLE_PORTA.
  // `undefined` REMOVE a variável no filho; `delete` num objeto que depois é espalhado sobre
  // `process.env` não removeria nada, e o teste passaria a medir o ambiente do processo de teste
  // em vez da descoberta registrada.
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

test("atualizar e reverter não apagam o escopo nem o estado registrados", (t) => {
  // O registro guarda mais que o ponteiro. Substituir o objeto inteiro a cada troca de versão
  // apagava escopo, estado, logs e porta, e a instalação voltava a procurar o estado no padrão
  // da plataforma na partida seguinte.
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

test("a desinstalação recusa apagar o programa quando não consegue provar que o console parou", async (t) => {
  // Antes, uma exceção ao encerrar devolvia `encerrado:false` e o chamador seguia apagando; e
  // qualquer falha da requisição de identidade durante a espera — inclusive tempo esgotado —
  // contava como "parou". Apagar o programa deixando um processo vivo e autenticado é o pior
  // desfecho possível.
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

  // Um "console" que prova identidade corretamente e NUNCA morre: o pid do contrato é de um
  // processo que o desinstalador não consegue matar (ele mesmo), então a porta continua aberta.
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

  // O contrato aponta para um pid que NÃO é o servidor (um pid inexistente): encerrar "dá certo"
  // sem nada morrer, e a porta continua aceitando conexão.
  fs.writeFileSync(
    path.join(estadoDir, "endereco.json"),
    `${JSON.stringify({ porta: teimoso.address().port, pid: 999999, modo: "tcp", versao, segredo })}\n`
  );

  const r = await rodarNodeAsync([path.join(raiz, "versoes", versao, "instalacao", "desinstalar.js"), "--raiz", raiz, "--estado", estadoDir, "--sim"], { CONSOLE_PARADA_MS: "1200" });
  assert.equal(r.codigo, 1, `a desinstalação tem de falhar sem prova de parada. Saída:\n${r.saida}`);
  assert.match(r.saida, /não foi possível confirmar que o console parou/);
  assert.ok(fs.existsSync(path.join(raiz, "console-bootstrap.js")), "o programa NÃO pode ser removido sem prova de parada");
});

test("a reexecução do desinstalador repassa o escopo, não deixa a cópia adivinhar", async (t) => {
  // A cópia temporária não mora dentro de uma instalação, então não consegue inferir nada. Sem
  // repassar o escopo, uma desinstalação de usuário virava de sistema no filho: deixava a
  // integração do usuário instalada e podia mexer na de sistema de outra instalação.
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

test("a substituição do payload restaura a versão anterior se o segundo rename falhar", (t) => {
  // Entre os dois renames a versão ativa não existe. Se o segundo falhar, o payload ficava só sob
  // `.substituido-*`, sem restauração automática, e o ponteiro apontava para um diretório ausente.
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());
  const fonte = fs.readFileSync(path.join(ajuda.RAIZ, "instalacao", "instalar.js"), "utf8");

  assert.match(fonte, /fs\.renameSync\(aposentado, destinoVersao\)/, "a falha do segundo rename precisa restaurar o anterior");
  assert.match(fonte, /a versão anterior foi restaurada/);
});

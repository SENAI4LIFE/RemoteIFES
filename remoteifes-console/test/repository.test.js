const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const ajuda = require("./helpers");

// Version and remote discovery, with the states that actually happen on a Pi: dirty checkout,
// detached HEAD, ahead, diverged, no remote, unreachable remote and shallow clone. Each must
// produce an honest reading, never "all good".

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

function repositorio() {
  const raiz = ajuda.dirTemporario("console-git-");
  git(raiz, ["init", "--quiet", "--initial-branch=main"]);
  git(raiz, ["config", "user.email", "teste@example.invalid"]);
  git(raiz, ["config", "user.name", "Teste"]);
  fs.mkdirSync(path.join(raiz, "remoteifes-server", "src", "config"), { recursive: true });
  fs.writeFileSync(path.join(raiz, "remoteifes-server", "package.json"), JSON.stringify({ version: "3.0.0" }));
  fs.writeFileSync(path.join(raiz, "remoteifes-server", ".env"), "PORTA=8188\n");
  fs.writeFileSync(path.join(raiz, "leia.md"), "um\n");
  git(raiz, ["add", "-A"]);
  git(raiz, ["commit", "--quiet", "-m", "primeiro commit"]);
  return raiz;
}

function limpar(raiz) {
  try {
    fs.rmSync(raiz, { recursive: true, force: true });
  } catch {}
}

test("a clean checkout on a branch is reported as clean", async (t) => {
  const raiz = repositorio();
  const amb = ajuda.ambiente({ checkout: raiz });
  t.after(() => {
    amb.restaurar();
    limpar(raiz);
  });

  const estado = await amb.repositorio.estadoLocal();
  assert.equal(estado.repositorio, true);
  assert.equal(estado.limpo, true);
  assert.equal(estado.ramo, "main");
  assert.equal(estado.destacado, false);
  assert.equal(estado.raso, false);
  assert.match(estado.head, /^[0-9a-f]{40}$/);
  assert.match(estado.descricaoHead, /primeiro commit/);
});

test("local changes and new files are counted separately", async (t) => {
  const raiz = repositorio();
  const amb = ajuda.ambiente({ checkout: raiz });
  t.after(() => {
    amb.restaurar();
    limpar(raiz);
  });

  fs.writeFileSync(path.join(raiz, "leia.md"), "modificado\n");
  fs.writeFileSync(path.join(raiz, "novo.txt"), "novo\n");

  const estado = await amb.repositorio.estadoLocal();
  assert.equal(estado.limpo, false);
  assert.equal(estado.totalModificados, 1);
  assert.equal(estado.totalNaoRastreados, 1);
  assert.deepEqual(estado.naoRastreados, ["novo.txt"]);
});

test("an update is refused with a dirty checkout, without offering --force", async (t) => {
  const raiz = repositorio();
  const amb = ajuda.ambiente({ checkout: raiz });
  t.after(() => {
    amb.restaurar();
    limpar(raiz);
  });

  fs.writeFileSync(path.join(raiz, "leia.md"), "mexido à mão\n");
  const commit = git(raiz, ["rev-parse", "HEAD"]);

  const acao = amb.acoes.obter("atualizacao.aplicar");
  const impedimento = await acao.validacaoExtra({ argumentos: { commit } });
  assert.ok(impedimento, "should block");
  assert.match(impedimento, /alterações locais/);
  assert.match(impedimento, /nunca usa --force/);
});

test("a detached HEAD is identified", async (t) => {
  const raiz = repositorio();
  const amb = ajuda.ambiente({ checkout: raiz });
  t.after(() => {
    amb.restaurar();
    limpar(raiz);
  });

  const commit = git(raiz, ["rev-parse", "HEAD"]);
  git(raiz, ["checkout", "--quiet", "--detach", commit]);
  const estado = await amb.repositorio.estadoLocal();
  assert.equal(estado.destacado, true);
  assert.equal(estado.ramo, null);
});

test("without a configured remote the query explains instead of failing silently", async (t) => {
  const raiz = repositorio();
  const amb = ajuda.ambiente({ checkout: raiz });
  t.after(() => {
    amb.restaurar();
    limpar(raiz);
  });

  const estado = await amb.repositorio.estadoLocal();
  assert.equal(estado.remotoOrigin, null);
  const consulta = await amb.repositorio.consultarRemoto();
  assert.equal(consulta.ok, false);
  assert.equal(consulta.classe, "remoto-ausente");
  assert.match(consulta.mensagem, /não está configurado/);
});

test("an unreachable remote is classified as offline, not as 'up to date'", async (t) => {
  const raiz = repositorio();
  const amb = ajuda.ambiente({ checkout: raiz });
  t.after(() => {
    amb.restaurar();
    limpar(raiz);
  });

  git(raiz, ["remote", "add", "origin", "https://host-que-nao-existe.invalid/x.git"]);
  const consulta = await amb.repositorio.consultarRemoto({ timeoutMs: 15_000 });
  assert.equal(consulta.ok, false);
  assert.ok(["offline", "erro", "autenticacao", "remoto-ausente"].includes(consulta.classe), `classe inesperada: ${consulta.classe}`);

  const situacao = await amb.repositorio.situacaoDeAtualizacao({ consultarRede: true });
  assert.ok(situacao.consultaAgora, "the query failure must appear in the status");
  assert.equal(situacao.remoto, null, "without a previous observation, none is invented");
});

test("failure classification distinguishes DNS, connection and authentication", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());

  assert.equal(amb.repositorio.classificarFalhaDeRede("fatal: Could not resolve host: github.com").classe, "offline");
  assert.equal(amb.repositorio.classificarFalhaDeRede("ssh: connect to host ... Connection timed out").classe, "offline");
  assert.equal(amb.repositorio.classificarFalhaDeRede("fatal: Authentication failed for 'https://...'").classe, "autenticacao");
  assert.equal(amb.repositorio.classificarFalhaDeRede("remote: Repository not found.").classe, "remoto-ausente");
});

test("comparison with a missing commit says the objects need to be fetched", async (t) => {
  const raiz = repositorio();
  const amb = ajuda.ambiente({ checkout: raiz });
  t.after(() => {
    amb.restaurar();
    limpar(raiz);
  });

  const comparacao = await amb.repositorio.compararCom("0".repeat(40));
  assert.equal(comparacao.conhecido, false);
  assert.match(comparacao.motivo, /ainda não está no checkout/);
});

test("ahead, behind and diverged are distinguished", async (t) => {
  const raiz = repositorio();
  const amb = ajuda.ambiente({ checkout: raiz });
  t.after(() => {
    amb.restaurar();
    limpar(raiz);
  });

  const base = git(raiz, ["rev-parse", "HEAD"]);
  // Parallel branch simulating what exists on origin.
  git(raiz, ["checkout", "--quiet", "-b", "remoto"]);
  fs.writeFileSync(path.join(raiz, "leia.md"), "remoto\n");
  git(raiz, ["commit", "--quiet", "-am", "commit remoto"]);
  const commitRemoto = git(raiz, ["rev-parse", "HEAD"]);

  git(raiz, ["checkout", "--quiet", "main"]);
  let cmp = await amb.repositorio.compararCom(commitRemoto);
  assert.equal(cmp.conhecido, true);
  assert.equal(cmp.atrasado, true);
  assert.equal(cmp.commitsSoRemotos, 1);

  cmp = await amb.repositorio.compararCom(base);
  assert.equal(cmp.igual, true);

  fs.writeFileSync(path.join(raiz, "local.txt"), "local\n");
  git(raiz, ["add", "-A"]);
  git(raiz, ["commit", "--quiet", "-m", "commit local"]);
  cmp = await amb.repositorio.compararCom(commitRemoto);
  assert.equal(cmp.divergente, true, "one commit on each side is divergence, not 'behind'");
  assert.equal(cmp.commitsSoLocais, 1);
  assert.equal(cmp.commitsSoRemotos, 1);
});

test("a shallow clone is flagged in the comparison", async (t) => {
  const origem = repositorio();
  fs.writeFileSync(path.join(origem, "b.txt"), "b\n");
  git(origem, ["add", "-A"]);
  git(origem, ["commit", "--quiet", "-m", "segundo"]);

  const raso = ajuda.dirTemporario("console-raso-");
  fs.rmSync(raso, { recursive: true, force: true });
  execFileSync("git", ["clone", "--quiet", "--depth", "1", `file://${origem.replace(/\\/g, "/")}`, raso], { stdio: ["ignore", "pipe", "pipe"] });

  const amb = ajuda.ambiente({ checkout: raso });
  t.after(() => {
    amb.restaurar();
    limpar(origem);
    limpar(raso);
  });

  const estado = await amb.repositorio.estadoLocal();
  assert.equal(estado.raso, true);
  const cmp = await amb.repositorio.compararCom(estado.head);
  assert.equal(cmp.historicoRaso, true);
  assert.ok(cmp.ressalvaRaso, "the shallow-history caveat must accompany the comparison");
});

test("a change of the origin URL is recorded and shown", async (t) => {
  const raiz = repositorio();
  const espelho = repositorio();
  const amb = ajuda.ambiente({ checkout: raiz });
  t.after(() => {
    amb.restaurar();
    limpar(raiz);
    limpar(espelho);
  });

  git(raiz, ["remote", "add", "origin", `file://${espelho.replace(/\\/g, "/")}`]);
  const primeira = await amb.repositorio.consultarRemoto();
  assert.equal(primeira.ok, true);

  const outro = repositorio();
  git(raiz, ["remote", "set-url", "origin", `file://${outro.replace(/\\/g, "/")}`]);
  const segunda = await amb.repositorio.consultarRemoto();
  assert.equal(segunda.ok, true);
  assert.ok(segunda.urlAnterior, "the remote change must be flagged");
  const auditoria = amb.estado.lerAuditoria(20);
  assert.ok(auditoria.some((a) => a.evento === "remoto-alterado"));
  limpar(outro);
});

test("the remote observation carries its time and ages", async (t) => {
  const raiz = repositorio();
  const espelho = repositorio();
  const amb = ajuda.ambiente({ checkout: raiz });
  t.after(() => {
    amb.restaurar();
    limpar(raiz);
    limpar(espelho);
  });

  git(raiz, ["remote", "add", "origin", `file://${espelho.replace(/\\/g, "/")}`]);
  await amb.repositorio.consultarRemoto();

  let situacao = await amb.repositorio.situacaoDeAtualizacao();
  assert.ok(situacao.remoto.observadoEm);
  assert.equal(situacao.remoto.recente, true);
  assert.equal(situacao.remoto.ressalva, null);

  // Ages the observation: it is then shown with a caveat instead of as current data.
  const arquivo = path.join(amb.estadoDir, "observacao-remota.json");
  const obs = JSON.parse(fs.readFileSync(arquivo, "utf8"));
  obs.observadoEm = new Date(Date.now() - 4 * 3600 * 1000).toISOString();
  fs.writeFileSync(arquivo, JSON.stringify(obs));

  situacao = await amb.repositorio.situacaoDeAtualizacao();
  assert.equal(situacao.remoto.recente, false);
  assert.match(situacao.remoto.ressalva, /antiga/);
});

test("the change summary groups by component and bounds the list", async (t) => {
  const raiz = repositorio();
  const amb = ajuda.ambiente({ checkout: raiz });
  t.after(() => {
    amb.restaurar();
    limpar(raiz);
  });

  const de = git(raiz, ["rev-parse", "HEAD"]);
  fs.mkdirSync(path.join(raiz, "remoteifes-web"), { recursive: true });
  fs.mkdirSync(path.join(raiz, "remoteifes-console", "src"), { recursive: true });
  fs.writeFileSync(path.join(raiz, "remoteifes-web", "app.js"), "web\n");
  fs.writeFileSync(path.join(raiz, "remoteifes-console", "src", "x.js"), "console\n");
  fs.writeFileSync(path.join(raiz, "README.md"), "docs\n");
  git(raiz, ["add", "-A"]);
  git(raiz, ["commit", "--quiet", "-m", "mexe em web, console e docs"]);
  const para = git(raiz, ["rev-parse", "HEAD"]);

  const resumo = await amb.repositorio.resumoDeMudancas(de, para);
  assert.equal(resumo.disponivel, true);
  assert.equal(resumo.total, 1);
  const chaves = resumo.componentes.map((c) => c.chave).sort();
  assert.deepEqual(chaves, ["console", "docs", "web"]);
  assert.equal(resumo.commits[0].assunto, "mexe em web, console e docs");
});

test("divergence between the running process and the checkout is explained", async (t) => {
  const raiz = repositorio();
  const amb = ajuda.ambiente({ checkout: raiz });
  t.after(() => {
    amb.restaurar();
    limpar(raiz);
  });

  // Without the application running, the running version is unknown, and this is stated explicitly.
  const situacao = await amb.repositorio.situacaoDeAtualizacao();
  assert.equal(situacao.emExecucao.commit, null);
  assert.equal(situacao.emExecucao.confirmadoPeloProcesso, false);
  assert.match(situacao.emExecucao.motivoDesconhecido, /não respondeu/);
  assert.equal(situacao.divergenciaProcessoCheckout.ha, false);
});

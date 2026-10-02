const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const RAIZ = path.join(__dirname, "..");
const temBash = spawnSync("bash", ["-c", "echo ok"], { encoding: "utf8" }).stdout?.trim() === "ok";
const temGit = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
const disponivel = temBash && temGit;

function sh(cwd, comando, extraEnv = {}) {
  return spawnSync("bash", ["-c", comando], { cwd, encoding: "utf8", env: { ...process.env, ...extraEnv } });
}

function git(cwd, ...args) {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function prepararRepo(env = "PORTA=8080\n") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remoteifes-deploy-"));
  fs.mkdirSync(path.join(dir, "src", "config"), { recursive: true });
  for (const arquivo of ["deploy.sh", "rollback.sh", "healthcheck.sh", "verificar-versao.sh"]) {
    fs.copyFileSync(path.join(RAIZ, arquivo), path.join(dir, arquivo));
  }
  fs.copyFileSync(path.join(RAIZ, "src", "config", "paths.js"), path.join(dir, "src", "config", "paths.js"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fake", version: "1.0.0", dependencies: {} }, null, 2));
  fs.writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify({ name: "fake", version: "1.0.0", lockfileVersion: 3, packages: {} }, null, 2));
  fs.writeFileSync(path.join(dir, ".gitignore"), ".env\nnode_modules\ndata\ndados-personalizados\n");
  fs.writeFileSync(path.join(dir, ".env"), env);
  git(dir, "init", "-q");
  git(dir, "symbolic-ref", "HEAD", "refs/heads/main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "A");
  const shaA = git(dir, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fake", version: "2.0.0", dependencies: { "pacote-b": "1.0.0" } }, null, 2));
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "B");
  const shaB = git(dir, "rev-parse", "HEAD");
  git(dir, "reset", "-q", "--hard", shaA);
  fs.mkdirSync(path.join(dir, "node_modules", "antigo"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node_modules", "antigo", "index.js"), "");
  return { dir, shaA, shaB };
}

function npmFalso(dir) {
  const bin = path.join(dir, "bin-falso");
  fs.mkdirSync(bin, { recursive: true });
  const script = path.join(bin, "npm");
  fs.writeFileSync(script, '#!/usr/bin/env bash\nrm -rf node_modules/antigo\nmkdir -p node_modules/.parcial\necho "npm ERR! simulado" >&2\nexit 1\n');
  fs.chmodSync(script, 0o755);
  return `${bin}${path.delimiter}${process.env.PATH}`;
}

test("deploy.sh proceeds when .env does not define REMOTEIFES_DATA_DIR and uses the canonical resolver", { skip: !disponivel }, () => {
  const { dir } = prepararRepo();
  const r = sh(dir, "bash deploy.sh --offline --no-restart");
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /Versão atual:/);
  assert.match(r.stdout, /não foi possível resolver o ref 'origin\/main'/);
  assert.ok(fs.existsSync(path.join(dir, "data")), "the default data directory must have been created");
  assert.ok(!fs.existsSync(path.join(dir, "data", ".deploy-lock")), "the lock must be removed on exit");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a relative REMOTEIFES_DATA_DIR in .env is resolved exactly as the server resolves it", { skip: !disponivel }, () => {
  const { dir } = prepararRepo("PORTA=8080\nREMOTEIFES_DATA_DIR=./dados-personalizados\n");
  const r = sh(dir, "bash deploy.sh --offline --no-restart");
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /Versão atual:/);
  assert.ok(fs.existsSync(path.join(dir, "dados-personalizados")));
  assert.ok(!fs.existsSync(path.join(dir, "data")));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("rollback.sh also completes preparation without REMOTEIFES_DATA_DIR", { skip: !disponivel }, () => {
  const { dir, shaA } = prepararRepo();
  const r = sh(dir, `bash rollback.sh ${shaA} --offline --no-restart`);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Já está em/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("deploy.sh does not accept the update when npm ci fails, even with an old/partial node_modules", { skip: !disponivel }, () => {
  const { dir, shaA, shaB } = prepararRepo();
  const r = sh(dir, `bash deploy.sh ${shaB} --offline --no-restart`, { PATH: npmFalso(dir) });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /npm ci falhou/);
  assert.doesNotMatch(r.stdout, /Atualização aplicada/);
  assert.match(r.stdout, /Revertendo para/);
  assert.equal(git(dir, "rev-parse", "HEAD"), shaA, "the code must return to the previous version");
  assert.ok(fs.existsSync(path.join(dir, "node_modules", ".parcial")), "the scenario simulated a partial node_modules");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("rollback.sh with a failing npm ci exits with an error and does not pretend the service restarted", { skip: !disponivel }, () => {
  const { dir, shaA, shaB } = prepararRepo();
  git(dir, "reset", "-q", "--hard", shaB);
  const r = sh(dir, `bash rollback.sh ${shaA} --offline --no-restart`, { PATH: npmFalso(dir) });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /npm ci falhou/);
  assert.doesNotMatch(r.stdout, /Rollback concluído/);
  assert.doesNotMatch(r.stdout, /Serviço não reiniciado \(--no-restart\)/);
  assert.equal(git(dir, "rev-parse", "HEAD"), shaA);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("rollback.sh refuses uncommitted local changes like deploy.sh, and --force goes past the refusal", { skip: !disponivel }, () => {
  const { dir, shaA, shaB } = prepararRepo();
  try {
    git(dir, "reset", "-q", "--hard", shaB);
    fs.appendFileSync(path.join(dir, ".gitignore"), "ajuste-local\n");
    const recusado = sh(dir, `bash rollback.sh ${shaA} --offline --no-restart`, { PATH: npmFalso(dir) });
    assert.equal(recusado.status, 1, recusado.stdout + recusado.stderr);
    assert.match(recusado.stdout, /alterações locais não commitadas/);
    assert.equal(git(dir, "rev-parse", "HEAD"), shaB, "the code is not touched");
    assert.match(fs.readFileSync(path.join(dir, ".gitignore"), "utf8"), /ajuste-local/, "the local change survives");
    assert.ok(!fs.existsSync(path.join(dir, "data", ".deploy-lock")), "the lock is released");

    // With --force the rollback moves the code (and then stops at the simulated npm ci failure).
    const forcado = sh(dir, `bash rollback.sh ${shaA} --offline --no-restart --force`, { PATH: npmFalso(dir) });
    assert.doesNotMatch(forcado.stdout, /alterações locais não commitadas/);
    assert.equal(git(dir, "rev-parse", "HEAD"), shaA);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("deploy.sh with unchanged dependencies skips npm ci and applies the new version", { skip: !disponivel }, () => {
  const { dir, shaA } = prepararRepo();
  fs.writeFileSync(path.join(dir, "README.txt"), "nova versão");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "C");
  const shaC = git(dir, "rev-parse", "HEAD");
  git(dir, "reset", "-q", "--hard", shaA);
  const r = sh(dir, `bash deploy.sh ${shaC} --offline --no-restart`, { PATH: npmFalso(dir) });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Dependências inalteradas; pulando npm ci/);
  assert.match(r.stdout, /Atualização aplicada/);
  assert.equal(git(dir, "rev-parse", "HEAD"), shaC);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Simulated service: a "running process" that answers /health with the commit it loaded (or without
// a commit, like versions before that field) and the process uptime, and a fake systemctl whose
// "restart" can apply the new version, fail while leaving the old process up (with its old uptime),
// or start a process of another version. The fake sudo only passes through.
const { spawn } = require("child_process");

async function servicoFalso(dir, { commitInicial, semCommit = false, semUptime = false }) {
  const bin = path.join(dir, "bin-servico");
  fs.mkdirSync(bin, { recursive: true });
  const arquivoCommit = path.join(dir, "commit-em-execucao");
  fs.writeFileSync(arquivoCommit, `${commitInicial}\n`);
  const arquivoInicio = path.join(dir, "inicio-em-execucao");
  fs.writeFileSync(arquivoInicio, `${Math.floor(Date.now() / 1000) - 3600}\n`);
  const healthJs = path.join(dir, "health-falso.js");
  fs.writeFileSync(healthJs, `
    const http = require("http");
    const fs = require("fs");
    const [porta, arquivo, arquivoInicio, semCommit, semUptime] = process.argv.slice(2);
    http.createServer((req, res) => {
      const commit = fs.readFileSync(arquivo, "utf8").trim();
      const uptimeSegundos = Math.floor(Date.now() / 1000) - Number(fs.readFileSync(arquivoInicio, "utf8").trim());
      const corpo = { ok: true, banco: "ok" };
      if (semCommit !== "1") corpo.commit = commit;
      if (semUptime !== "1") corpo.uptimeSegundos = uptimeSegundos;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(corpo));
    }).listen(Number(porta), "127.0.0.1", () => process.stdout.write("pronto\\n"));
  `);
  fs.writeFileSync(path.join(bin, "sudo"), '#!/usr/bin/env bash\nexec "$@"\n');
  fs.writeFileSync(path.join(bin, "systemctl"), [
    "#!/usr/bin/env bash",
    'echo "systemctl $*" >> "$FAKE_SYSTEMCTL_LOG"',
    'case "$1" in',
    "  cat) exit 0 ;;",
    "  restart)",
    '    case "$FAKE_RESTART_MODE" in',
    '      ok) git -C "$FAKE_REPO_DIR" rev-parse HEAD > "$FAKE_COMMIT_FILE"; date +%s > "$FAKE_INICIO_FILE"; exit 0 ;;',
    "      falha) exit 1 ;;",
    '      divergente) echo "1111111111111111111111111111111111111111" > "$FAKE_COMMIT_FILE"; date +%s > "$FAKE_INICIO_FILE"; exit 0 ;;',
    "    esac ;;",
    "esac",
    "exit 0",
    "",
  ].join("\n"));
  fs.chmodSync(path.join(bin, "sudo"), 0o755);
  fs.chmodSync(path.join(bin, "systemctl"), 0o755);

  const porta = await new Promise((resolve) => {
    const s = require("net").createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  const processo = spawn(process.execPath, [healthJs, String(porta), arquivoCommit, arquivoInicio, semCommit ? "1" : "0", semUptime ? "1" : "0"], { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise((resolve) => processo.stdout.once("data", resolve));
  return {
    porta,
    arquivoCommit,
    commitEmExecucao: () => fs.readFileSync(arquivoCommit, "utf8").trim(),
    ambiente: (modoRestart) => ({
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      FAKE_SYSTEMCTL_LOG: path.join(dir, "systemctl.log"),
      FAKE_RESTART_MODE: modoRestart,
      FAKE_REPO_DIR: dir,
      FAKE_COMMIT_FILE: arquivoCommit,
      FAKE_INICIO_FILE: arquivoInicio,
      ESPERA_SAUDE_TENTATIVAS: "3",
      ESPERA_SAUDE_INTERVALO: "0.2",
    }),
    chamadasSystemctl: () => (fs.existsSync(path.join(dir, "systemctl.log")) ? fs.readFileSync(path.join(dir, "systemctl.log"), "utf8").trim().split("\n") : []),
    parar: () => processo.kill(),
  };
}

function commitC(dir, shaA) {
  fs.writeFileSync(path.join(dir, "README.txt"), "nova versão");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "C");
  const shaC = git(dir, "rev-parse", "HEAD");
  git(dir, "reset", "-q", "--hard", shaA);
  return shaC;
}

function lerDeployLog(dir) {
  const arquivo = path.join(dir, "data", "deploy.log");
  return fs.existsSync(arquivo) ? fs.readFileSync(arquivo, "utf8") : "";
}

test("deploy.sh does not complete when the restart fails and the old process keeps answering healthy", { skip: !disponivel }, async () => {
  const { dir, shaA } = prepararRepo();
  const shaC = commitC(dir, shaA);
  const servico = await servicoFalso(dir, { commitInicial: shaA });
  fs.writeFileSync(path.join(dir, ".env"), `PORTA=${servico.porta}\n`);
  try {
    const r = sh(dir, `bash deploy.sh ${shaC} --offline`, servico.ambiente("falha"));
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /Deploy concluído/);
    assert.match(r.stdout, new RegExp(`o processo em execução continua em ${shaA}, não em ${shaC}`));
    assert.match(r.stdout, /Revertendo para/);
    assert.match(r.stdout, new RegExp(`Revertido para ${shaA} e o servidor em execução está saudável nessa versão`));
    assert.equal(git(dir, "rev-parse", "HEAD"), shaA, "the code returns to the version actually running");
    assert.ok(!fs.existsSync(path.join(dir, "data", "current-version")), "nothing is recorded as the current version");
    assert.match(lerDeployLog(dir), /FALHOU: o processo em execução continua em/);
    assert.equal(servico.chamadasSystemctl().filter((c) => c.includes("restart")).length, 2, "one restart in deploy and one in the rollback");
  } finally {
    servico.parar();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("deploy.sh does not complete when the started process reports another version", { skip: !disponivel }, async () => {
  const { dir, shaA } = prepararRepo();
  const shaC = commitC(dir, shaA);
  const servico = await servicoFalso(dir, { commitInicial: shaA });
  fs.writeFileSync(path.join(dir, ".env"), `PORTA=${servico.porta}\n`);
  try {
    const r = sh(dir, `bash deploy.sh ${shaC} --offline`, servico.ambiente("divergente"));
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /Deploy concluído/);
    assert.match(r.stdout, /o processo em execução continua em 1{40}/);
    assert.equal(git(dir, "rev-parse", "HEAD"), shaA);
    assert.match(r.stdout, /ATENÇÃO: código revertido para/, "the rollback does not fake success either: the diverging process stays up");
    assert.ok(!fs.existsSync(path.join(dir, "data", "current-version")));
  } finally {
    servico.parar();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("deploy.sh completes when the running process confirms exactly the new version", { skip: !disponivel }, async () => {
  const { dir, shaA } = prepararRepo();
  const shaC = commitC(dir, shaA);
  const servico = await servicoFalso(dir, { commitInicial: shaA });
  fs.writeFileSync(path.join(dir, ".env"), `PORTA=${servico.porta}\n`);
  try {
    const r = sh(dir, `bash deploy.sh ${shaC} --offline`, servico.ambiente("ok"));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`Deploy concluído: ${shaC} \\(confirmado pelo processo em execução\\)`));
    assert.equal(git(dir, "rev-parse", "HEAD"), shaC);
    assert.equal(servico.commitEmExecucao(), shaC);
    assert.equal(fs.readFileSync(path.join(dir, "data", "current-version"), "utf8").trim(), shaC);
    assert.equal(fs.readFileSync(path.join(dir, "data", "previous-version"), "utf8").trim(), shaA);
    assert.match(lerDeployLog(dir), new RegExp(`ok \\(processo em execução confirmou ${shaC}\\)`));
  } finally {
    servico.parar();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rollback.sh does not complete when the restart fails and the current version's process stays up", { skip: !disponivel }, async () => {
  const { dir, shaA } = prepararRepo();
  const shaC = commitC(dir, shaA);
  git(dir, "reset", "-q", "--hard", shaC);
  const servico = await servicoFalso(dir, { commitInicial: shaC });
  fs.writeFileSync(path.join(dir, ".env"), `PORTA=${servico.porta}\n`);
  try {
    const r = sh(dir, `bash rollback.sh ${shaA} --offline`, servico.ambiente("falha"));
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /Rollback concluído/);
    assert.match(r.stdout, new RegExp(`o processo em execução continua em ${shaC}, não em ${shaA} \\(o reinício não aplicou a reversão\\)`));
    assert.equal(git(dir, "rev-parse", "HEAD"), shaA, "the code stays at the requested version for the operator to act");
    assert.ok(!fs.existsSync(path.join(dir, "data", "current-version")));
    assert.match(lerDeployLog(dir), /rollback .* FALHOU: o processo em execução continua em/);
  } finally {
    servico.parar();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rollback.sh completes when the process confirms the target version, and accepts with a warning a version older than the commit field", { skip: !disponivel }, async () => {
  const { dir, shaA } = prepararRepo();
  const shaC = commitC(dir, shaA);
  git(dir, "reset", "-q", "--hard", shaC);
  const servico = await servicoFalso(dir, { commitInicial: shaC });
  fs.writeFileSync(path.join(dir, ".env"), `PORTA=${servico.porta}\n`);
  try {
    const r = sh(dir, `bash rollback.sh ${shaA} --offline`, servico.ambiente("ok"));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`Rollback concluído: ${shaA}`));
    assert.equal(servico.commitEmExecucao(), shaA);
    assert.equal(fs.readFileSync(path.join(dir, "data", "current-version"), "utf8").trim(), shaA);
  } finally {
    servico.parar();
  }

  git(dir, "reset", "-q", "--hard", shaC);
  fs.rmSync(path.join(dir, "data"), { recursive: true, force: true });
  const legado = await servicoFalso(dir, { commitInicial: shaC, semCommit: true });
  fs.writeFileSync(path.join(dir, ".env"), `PORTA=${legado.porta}\n`);
  try {
    const r = sh(dir, `bash rollback.sh ${shaA} --offline`, legado.ambiente("ok"));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /identidade do processo não pôde ser confirmada; aceito porque um processo saudável subiu \d+s atrás, depois do reinício/);
    assert.match(r.stdout, new RegExp(`Rollback concluído: ${shaA} \\(identidade não confirmada`));
    assert.match(lerDeployLog(dir), /rollback .* ok \(identidade não confirmada: .* não informa commit; processo saudável reiniciado há \d+s\)/);
  } finally {
    legado.parar();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rollback.sh to a version without identity does not complete when the old process (also without identity) survived the restart", { skip: !disponivel }, async () => {
  const { dir, shaA } = prepararRepo();
  const shaC = commitC(dir, shaA);
  git(dir, "reset", "-q", "--hard", shaC);
  const legado = await servicoFalso(dir, { commitInicial: shaC, semCommit: true });
  fs.writeFileSync(path.join(dir, ".env"), `PORTA=${legado.porta}\n`);
  try {
    const r = sh(dir, `bash rollback.sh ${shaA} --offline`, legado.ambiente("falha"));
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /Rollback concluído/);
    assert.match(r.stdout, /não informa o commit e está no ar há \d+s, ou seja, sobreviveu ao reinício/);
    assert.match(lerDeployLog(dir), /rollback .* FALHOU: o processo em execução não informa o commit e está no ar há/);
    assert.ok(!fs.existsSync(path.join(dir, "data", "current-version")), "a healthy /health without identity does not become a success record");
  } finally {
    legado.parar();
  }

  // Without a commit or uptime in /health there is no way to verify: that is not success either.
  fs.rmSync(path.join(dir, "data"), { recursive: true, force: true });
  git(dir, "reset", "-q", "--hard", shaC);
  const opaco = await servicoFalso(dir, { commitInicial: shaC, semCommit: true, semUptime: true });
  fs.writeFileSync(path.join(dir, ".env"), `PORTA=${opaco.porta}\n`);
  try {
    const r = sh(dir, `bash rollback.sh ${shaA} --offline`, opaco.ambiente("ok"));
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /não informa commit nem tempo de vida: não é possível verificar/);
    assert.ok(!fs.existsSync(path.join(dir, "data", "current-version")));
  } finally {
    opaco.parar();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a process without identity is not accepted as a target version that would report the commit", { skip: !disponivel }, async () => {
  const { dir, shaA } = prepararRepo();
  // Version D carries the module that puts the commit in /health: a process that does not report it
  // cannot be D.
  fs.writeFileSync(path.join(dir, "src", "config", "release.js"), "module.exports = { COMMIT_EM_EXECUCAO: null };\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "D");
  const shaD = git(dir, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(dir, "README.txt"), "versão E");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "E");
  const shaE = git(dir, "rev-parse", "HEAD");
  const legado = await servicoFalso(dir, { commitInicial: shaE, semCommit: true });
  fs.writeFileSync(path.join(dir, ".env"), `PORTA=${legado.porta}\n`);
  try {
    const r = sh(dir, `bash rollback.sh ${shaD} --offline`, legado.ambiente("falha"));
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`não informa o commit, mas ${shaD} informaria: é outra versão`));
    assert.doesNotMatch(r.stdout, /Rollback concluído/);
    assert.ok(!fs.existsSync(path.join(dir, "data", "current-version")));
  } finally {
    legado.parar();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("deploy.sh with the code already at the target does not mark it complete: it restarts and confirms the process, or does nothing when the process already confirms it", { skip: !disponivel }, async () => {
  const { dir, shaA } = prepararRepo();
  const shaC = commitC(dir, shaA);
  // Interrupted update (or 'deploy --no-restart'): the code is already at C, the service still runs
  // A.
  git(dir, "reset", "-q", "--hard", shaC);
  const servico = await servicoFalso(dir, { commitInicial: shaA });
  fs.writeFileSync(path.join(dir, ".env"), `PORTA=${servico.porta}\n`);
  try {
    let r = sh(dir, `bash deploy.sh ${shaC} --offline --no-restart`, servico.ambiente("ok"));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Já está na versão alvo .* Serviço não reiniciado nem verificado \(--no-restart\)/);
    assert.equal(servico.chamadasSystemctl().filter((c) => c.includes("restart")).length, 0);
    assert.equal(servico.commitEmExecucao(), shaA);

    r = sh(dir, `bash deploy.sh ${shaC} --offline`, servico.ambiente("ok"));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /Nada a fazer/);
    assert.match(r.stdout, new RegExp(`O código já está em ${shaC}, mas o processo em execução está em ${shaA}; reiniciando`));
    assert.match(r.stdout, new RegExp(`Deploy concluído: ${shaC} \\(confirmado pelo processo em execução\\)`));
    assert.equal(servico.commitEmExecucao(), shaC);
    assert.equal(servico.chamadasSystemctl().filter((c) => c.includes("restart")).length, 1);
    assert.equal(fs.readFileSync(path.join(dir, "data", "current-version"), "utf8").trim(), shaC);
    assert.equal(fs.readFileSync(path.join(dir, "data", "previous-version"), "utf8").trim(), shaA, "the version that was running is the rollback target");
    assert.match(lerDeployLog(dir), new RegExp(`deploy ${shaA} -> ${shaC} .* ok \\(código já estava em ${shaC}; processo em execução confirmou`));

    r = sh(dir, `bash deploy.sh ${shaC} --offline`, servico.ambiente("falha"));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Já está na versão alvo .* e o processo em execução a confirma\. Nada a fazer\./);
    assert.equal(servico.chamadasSystemctl().filter((c) => c.includes("restart")).length, 1, "nothing is restarted when the process already confirms the version");
  } finally {
    servico.parar();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("deploy.sh with the code already at the target and a failing restart does not record success", { skip: !disponivel }, async () => {
  const { dir, shaA } = prepararRepo();
  const shaC = commitC(dir, shaA);
  git(dir, "reset", "-q", "--hard", shaC);
  const servico = await servicoFalso(dir, { commitInicial: shaA });
  fs.writeFileSync(path.join(dir, ".env"), `PORTA=${servico.porta}\n`);
  try {
    const r = sh(dir, `bash deploy.sh ${shaC} --offline`, servico.ambiente("falha"));
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /Deploy concluído|Nada a fazer/);
    assert.match(r.stdout, new RegExp(`ATENÇÃO: o código está em ${shaC}, mas o processo em execução continua em ${shaA}`));
    assert.equal(git(dir, "rev-parse", "HEAD"), shaC, "without a known previous checkout version, the code stays for the operator to act");
    assert.ok(!fs.existsSync(path.join(dir, "data", "current-version")));
    assert.match(lerDeployLog(dir), /FALHOU: o processo em execução continua em/);
  } finally {
    servico.parar();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rollback.sh with the code already at the target restarts and confirms instead of marking the rollback done", { skip: !disponivel }, async () => {
  const { dir, shaA } = prepararRepo();
  const shaC = commitC(dir, shaA);
  // Earlier rollback that reverted the code but whose restart was not confirmed: HEAD at A, process
  // at C.
  const servico = await servicoFalso(dir, { commitInicial: shaC });
  fs.writeFileSync(path.join(dir, ".env"), `PORTA=${servico.porta}\n`);
  try {
    let r = sh(dir, `bash rollback.sh ${shaA} --offline --no-restart`, servico.ambiente("ok"));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Já está em .* Serviço não reiniciado nem verificado \(--no-restart\)/);
    assert.equal(servico.commitEmExecucao(), shaC);

    r = sh(dir, `bash rollback.sh ${shaA} --offline`, servico.ambiente("falha"));
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`O código já está em ${shaA}, mas o processo em execução está em ${shaC}; reiniciando`));
    assert.doesNotMatch(r.stdout, /Rollback concluído/);
    assert.match(lerDeployLog(dir), /rollback .* FALHOU: o processo em execução continua em/);

    r = sh(dir, `bash rollback.sh ${shaA} --offline`, servico.ambiente("ok"));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`Rollback concluído: ${shaA} \\(confirmado pelo processo em execução\\)`));
    assert.equal(servico.commitEmExecucao(), shaA);
    assert.equal(fs.readFileSync(path.join(dir, "data", "current-version"), "utf8").trim(), shaA);
    assert.equal(fs.readFileSync(path.join(dir, "data", "previous-version"), "utf8").trim(), shaC);

    r = sh(dir, `bash rollback.sh ${shaA} --offline`, servico.ambiente("falha"));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Já está em .* e o processo em execução a confirma\. Nada a fazer\./);
  } finally {
    servico.parar();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- Deployment lock and the database ------------------------------------------------------------

// PIDs as the scripts record and check them: the operating system's, which is what a process started
// by Node reports. Under Git Bash that is the Windows PID, the one the Console checks too.
function pidMorto(dir) {
  // Windows PIDs are multiples of 4: an odd one never belongs to a process there.
  if (process.platform === "win32") return 4194301;
  const r = sh(dir, "true & p=$!; wait $p; echo $p");
  return Number(r.stdout.trim());
}

function pidVivo() {
  const filho = spawn(process.execPath, ["-e", "setTimeout(() => {}, 300000)"], { stdio: "ignore" });
  filho.unref();
  return filho.pid;
}

function encerrarPid(dir, pid) {
  try {
    process.kill(pid);
  } catch {}
}

// The identity recorded with the PID where /proc has it (Linux): boot and process start time.
const BOOT_ID = (() => {
  try {
    return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
  } catch {
    return null;
  }
})();

function identidadeDe(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  return `${BOOT_ID}:${stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19]}`;
}

function travaEm(dir, idadeMin, pid = pidMorto(dir), identidade = null) {
  const trava = path.join(dir, "data", ".deploy-lock");
  fs.mkdirSync(path.dirname(trava), { recursive: true });
  fs.writeFileSync(trava, `${pid} em-andamento${identidade ? ` ${identidade}` : ""}\n`);
  const quando = new Date(Date.now() - idadeMin * 60_000);
  fs.utimesSync(trava, quando, quando);
  return trava;
}

// The reclamation mutex as the scripts and the Console leave it: a directory with the holder's record
// ("<pid> <identity|-> <nonce>") in `dono`, then `sucessor.<previous nonce>` for each takeover.
function mutexEm(trava, registros, idadeMin = 0) {
  const mutex = `${trava}.reclamacao`;
  fs.mkdirSync(mutex);
  registros.forEach((registro, i) => {
    const nome = i === 0 ? "dono" : `sucessor.${registros[i - 1].split(" ")[2]}`;
    fs.writeFileSync(path.join(mutex, nome), `${registro}\n`);
  });
  if (idadeMin) {
    const quando = new Date(Date.now() - idadeMin * 60_000);
    fs.utimesSync(mutex, quando, quando);
  }
  return mutex;
}

function restosDaReclamacao(dir) {
  return fs.readdirSync(path.join(dir, "data")).filter((n) => n.includes(".reclamacao"));
}

// A `stat` without GNU's -c (BSD and macOS): the lock's age must not depend on it.
function statSemGnu(dir) {
  const bin = path.join(dir, "bin-stat-bsd");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "stat"), '#!/usr/bin/env bash\necho "stat: illegal option -- c" >&2\nexit 1\n');
  fs.chmodSync(path.join(bin, "stat"), 0o755);
  return { PATH: `${bin}${path.delimiter}${process.env.PATH}` };
}

test("a recent deployment lock is respected by deploy.sh and rollback.sh, and survives the refusal", { skip: !disponivel }, () => {
  const { dir, shaA, shaB } = prepararRepo();
  try {
    for (const ambiente of [{}, statSemGnu(dir)]) {
      const trava = travaEm(dir, 5);
      const conteudo = fs.readFileSync(trava, "utf8");
      for (const comando of [`bash deploy.sh ${shaB} --offline --no-restart`, `bash rollback.sh ${shaA} --offline --no-restart`]) {
        const r = sh(dir, comando, ambiente);
        assert.equal(r.status, 1, r.stdout + r.stderr);
        assert.match(r.stdout, /outra atualização\/rollback parece estar em andamento/);
        assert.equal(fs.readFileSync(trava, "utf8"), conteudo, "the other operation's lock is not touched");
      }
    }
    assert.equal(git(dir, "rev-parse", "HEAD"), shaA);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a lock older than 30 minutes is taken as left over, and a failed deploy releases its own", { skip: !disponivel }, () => {
  const { dir, shaB } = prepararRepo();
  try {
    const trava = travaEm(dir, 40);
    // The deploy gets past the lock and then fails at npm ci; it must not leave a lock behind.
    const r = sh(dir, `bash deploy.sh ${shaB} --offline --no-restart`, { PATH: npmFalso(dir) });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /outra atualização\/rollback parece estar em andamento/);
    assert.match(r.stdout + r.stderr, /npm/);
    assert.equal(fs.existsSync(trava), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an old lock whose process is still alive is kept: a long deploy is not taken over by age", { skip: !disponivel }, () => {
  const { dir, shaA, shaB } = prepararRepo();
  const pid = pidVivo(dir);
  try {
    const trava = travaEm(dir, 45, pid);
    const conteudo = fs.readFileSync(trava, "utf8");
    for (const comando of [`bash deploy.sh ${shaB} --offline --no-restart`, `bash rollback.sh ${shaA} --offline --no-restart`]) {
      const r = sh(dir, comando);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stdout, /outra atualização\/rollback parece estar em andamento/);
      assert.equal(fs.readFileSync(trava, "utf8"), conteudo, "the live operation keeps its lock");
    }
    assert.equal(git(dir, "rev-parse", "HEAD"), shaA);
  } finally {
    encerrarPid(dir, pid);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("two runs started together on a left-over lock: exactly one takes it over", { skip: !disponivel }, () => {
  const { dir, shaB } = prepararRepo();
  try {
    travaEm(dir, 45);
    // An npm that holds the run for a while and then fails, so both runs overlap.
    const bin = path.join(dir, "bin-lento");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "npm"), "#!/usr/bin/env bash\nsleep 3\nexit 1\n");
    fs.chmodSync(path.join(bin, "npm"), 0o755);
    const comando = `bash deploy.sh ${shaB} --offline --no-restart`;
    sh(dir, `(${comando} > saida-1.txt 2>&1) & (${comando} > saida-2.txt 2>&1) & wait`, { PATH: `${bin}${path.delimiter}${process.env.PATH}` });
    const saidas = ["saida-1.txt", "saida-2.txt"].map((f) => fs.readFileSync(path.join(dir, f), "utf8"));
    const recusadas = saidas.filter((s) => /outra atualização\/rollback parece estar em andamento/.test(s)).length;
    assert.equal(recusadas, 1, saidas.join("\n---\n"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a left-over lock is not taken over while a live process holds the reclamation mutex, however old", { skip: !disponivel }, () => {
  const { dir, shaA, shaB } = prepararRepo();
  const pid = pidVivo();
  try {
    const trava = travaEm(dir, 45);
    const conteudo = fs.readFileSync(trava, "utf8");
    const mutex = mutexEm(trava, [`${pid} - a1b2c3`], 60);
    for (const comando of [`bash deploy.sh ${shaB} --offline --no-restart`, `bash rollback.sh ${shaA} --offline --no-restart`]) {
      const r = sh(dir, comando);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stdout, /outra atualização\/rollback parece estar em andamento/);
      assert.match(r.stdout, /reclamacao, de uma retomada em andamento ou interrompida/);
      assert.equal(fs.readFileSync(trava, "utf8"), conteudo);
      assert.equal(fs.readFileSync(path.join(mutex, "dono"), "utf8"), `${pid} - a1b2c3\n`);
    }
    // A holder that died took over and recorded itself after it: the live successor holds it.
    fs.rmSync(mutex, { recursive: true });
    mutexEm(trava, [`${pidMorto(dir)} - a1b2c3`, `${pid} - d4e5f6`]);
    const r = sh(dir, `bash deploy.sh ${shaB} --offline --no-restart`);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /outra atualização\/rollback parece estar em andamento/);
    assert.equal(fs.readFileSync(trava, "utf8"), conteudo);
    assert.equal(fs.readFileSync(path.join(mutex, "sucessor.a1b2c3"), "utf8"), `${pid} - d4e5f6\n`);
  } finally {
    encerrarPid(dir, pid);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a reclamation mutex left by a process that died is taken over at once, following the chain to its end", { skip: !disponivel }, () => {
  const { dir, shaB } = prepararRepo();
  try {
    for (const registros of [[`${pidMorto(dir)} - a1b2c3`], [`${pidMorto(dir)} - a1b2c3`, `${pidMorto(dir)} - d4e5f6`]]) {
      const trava = travaEm(dir, 45);
      const mutex = mutexEm(trava, registros, 1);
      // The deploy gets past the lock and then fails at npm ci; it leaves neither the mutex nor a lock.
      const r = sh(dir, `bash deploy.sh ${shaB} --offline --no-restart`, { PATH: npmFalso(dir) });
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.doesNotMatch(r.stdout, /outra atualização\/rollback parece estar em andamento/);
      assert.match(r.stdout + r.stderr, /npm/);
      assert.equal(fs.existsSync(mutex), false, "the mutex taken over is released");
      assert.equal(fs.existsSync(trava), false);
      assert.deepEqual(restosDaReclamacao(dir), []);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a reclamation mutex without a record is taken over only after 10 minutes, and an interrupted release is cleaned up", { skip: !disponivel }, () => {
  const { dir, shaA, shaB } = prepararRepo();
  try {
    const trava = travaEm(dir, 45);
    const conteudo = fs.readFileSync(trava, "utf8");
    // An older version never records itself; this one records itself microseconds after the mkdir.
    const mutex = mutexEm(trava, [], 8);
    for (const comando of [`bash deploy.sh ${shaB} --offline --no-restart`, `bash rollback.sh ${shaA} --offline --no-restart`]) {
      const r = sh(dir, comando);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stdout, /outra atualização\/rollback parece estar em andamento/);
      assert.equal(fs.readFileSync(trava, "utf8"), conteudo);
      assert.ok(fs.existsSync(mutex));
    }
    // A release interrupted after moving the directory aside leaves it under another name.
    fs.mkdirSync(`${mutex}.lixo.0badc0de`);
    fs.writeFileSync(path.join(`${mutex}.lixo.0badc0de`, "dono"), "1 - 0badc0de\n");
    const antigo = new Date(Date.now() - 15 * 60_000);
    fs.utimesSync(mutex, antigo, antigo);
    const r = sh(dir, `bash deploy.sh ${shaB} --offline --no-restart`, { PATH: npmFalso(dir) });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /outra atualização\/rollback parece estar em andamento/);
    assert.match(r.stdout + r.stderr, /npm/);
    assert.equal(fs.existsSync(trava), false);
    assert.deepEqual(restosDaReclamacao(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the lock deploy.sh writes names a PID the Console sees alive, with its identity where /proc has it", { skip: !disponivel }, () => {
  const { dir, shaB } = prepararRepo();
  try {
    // Checked from Node, as the Console checks it, while the deploy holds the lock (npm ci runs).
    fs.writeFileSync(path.join(dir, "conferir-trava.js"), [
      'const fs = require("fs");',
      'const [pid, , identidade] = fs.readFileSync("data/.deploy-lock", "utf8").trim().split(/\\s+/);',
      'let visto = "vivo";',
      "try {",
      "  process.kill(Number(pid), 0);",
      "} catch (erro) {",
      "  visto = `morto (${erro.code})`;",
      "}",
      "let boot = null;",
      "try {",
      '  boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();',
      "} catch {}",
      "if (boot) {",
      "  const stat = fs.readFileSync(`/proc/${pid}/stat`, \"utf8\");",
      "  const esperada = `${boot}:${stat.slice(stat.lastIndexOf(\") \") + 2).split(\" \")[19]}`;",
      "  if (identidade !== esperada) visto += ` identidade ${identidade} != ${esperada}`;",
      "}",
      'fs.writeFileSync("trava-vista.txt", visto);',
      "",
    ].join("\n"));
    const bin = path.join(dir, "bin-conferir");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "npm"), '#!/usr/bin/env bash\nnode conferir-trava.js\nexit 1\n');
    fs.chmodSync(path.join(bin, "npm"), 0o755);
    const r = sh(dir, `bash deploy.sh ${shaB} --offline --no-restart`, { PATH: `${bin}${path.delimiter}${process.env.PATH}` });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.equal(fs.readFileSync(path.join(dir, "trava-vista.txt"), "utf8"), "vivo");
    assert.equal(fs.existsSync(path.join(dir, "data", ".deploy-lock")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a PID that now belongs to another process holds neither the lock, the mutex nor the watchdog", { skip: !disponivel || !BOOT_ID ? "needs /proc (Linux)" : false }, () => {
  const { dir, shaB } = prepararRepo();
  const pid = pidVivo();
  try {
    const identidade = identidadeDe(pid);
    const outras = [`${BOOT_ID}:1`, `00000000-0000-0000-0000-000000000000:${identidade.split(":")[1]}`];
    const deploy = () => sh(dir, `bash deploy.sh ${shaB} --offline --no-restart`, { PATH: npmFalso(dir) });

    // The PID with the identity recorded with it: the same process, kept however old.
    let trava = travaEm(dir, 45, pid, identidade);
    let r = deploy();
    assert.match(r.stdout, /outra atualização\/rollback parece estar em andamento/);
    assert.equal(fs.readFileSync(trava, "utf8"), `${pid} em-andamento ${identidade}\n`);
    // The same PID with another start time or from another boot: a reused PID, so left over.
    for (const outra of outras) {
      trava = travaEm(dir, 45, pid, outra);
      r = deploy();
      assert.doesNotMatch(r.stdout, /outra atualização\/rollback parece estar em andamento/, outra);
      assert.equal(fs.existsSync(trava), false);
    }

    // The mutex follows the same rule.
    trava = travaEm(dir, 45);
    let mutex = mutexEm(trava, [`${pid} ${identidade} a1b2c3`]);
    r = deploy();
    assert.match(r.stdout, /outra atualização\/rollback parece estar em andamento/);
    assert.ok(fs.existsSync(mutex));
    fs.rmSync(mutex, { recursive: true });
    mutex = mutexEm(trava, [`${pid} ${outras[0]} a1b2c3`]);
    r = deploy();
    assert.doesNotMatch(r.stdout, /outra atualização\/rollback parece estar em andamento/);
    assert.deepEqual(restosDaReclamacao(dir), []);

    // The watchdog: an old lock whose PID was reused does not silence it; the real owner's does.
    fs.copyFileSync(path.join(RAIZ, "health-watchdog.sh"), path.join(dir, "health-watchdog.sh"));
    fs.writeFileSync(path.join(dir, "healthcheck.sh"), "#!/usr/bin/env bash\nexit 1\n");
    travaEm(dir, 40, pid, identidade);
    sh(dir, "bash health-watchdog.sh");
    assert.equal(fs.existsSync(path.join(dir, "data", ".health-falhas")), false);
    travaEm(dir, 40, pid, outras[0]);
    sh(dir, "bash health-watchdog.sh");
    assert.equal(fs.readFileSync(path.join(dir, "data", ".health-falhas"), "utf8").trim(), "1");
  } finally {
    encerrarPid(dir, pid);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("under Git Bash, a Windows process list that cannot be read keeps the lock", { skip: !disponivel || process.platform !== "win32" ? "Git Bash on Windows" : false }, () => {
  const { dir, shaB } = prepararRepo();
  try {
    const trava = travaEm(dir, 45);
    const conteudo = fs.readFileSync(trava, "utf8");
    // An exported function rather than a stand-in on PATH: Git's bin/bash.exe puts /usr/bin first.
    const r = sh(dir, `ps() { return 1; }; export -f ps; bash deploy.sh ${shaB} --offline --no-restart`);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /outra atualização\/rollback parece estar em andamento/);
    assert.equal(fs.readFileSync(trava, "utf8"), conteudo);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a run releases only its own lock: one another operation took over stays", { skip: !disponivel }, () => {
  const { dir, shaB } = prepararRepo();
  try {
    // An npm that, while the deploy runs, sees the lock replaced by another operation and then fails.
    const bin = path.join(dir, "bin-tomada");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "npm"), '#!/usr/bin/env bash\necho "9999 outra-operacao" > data/.deploy-lock\nexit 1\n');
    fs.chmodSync(path.join(bin, "npm"), 0o755);
    const r = sh(dir, `bash deploy.sh ${shaB} --offline --no-restart`, { PATH: `${bin}${path.delimiter}${process.env.PATH}` });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.equal(fs.readFileSync(path.join(dir, "data", ".deploy-lock"), "utf8"), "9999 outra-operacao\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the health watchdog stays quiet while a recent deployment lock exists, and not for a left-over one", { skip: !disponivel }, () => {
  const { dir } = prepararRepo();
  try {
    fs.copyFileSync(path.join(RAIZ, "health-watchdog.sh"), path.join(dir, "health-watchdog.sh"));
    // A health check that always fails: without the lock the watchdog counts a failure.
    fs.writeFileSync(path.join(dir, "healthcheck.sh"), "#!/usr/bin/env bash\nexit 1\n");
    travaEm(dir, 5);
    for (const ambiente of [{}, statSemGnu(dir)]) {
      const r = sh(dir, "bash health-watchdog.sh", ambiente);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.equal(fs.existsSync(path.join(dir, "data", ".health-falhas")), false, "no failure is counted during a deployment");
    }
    const pid = pidVivo();
    try {
      travaEm(dir, 40, pid);
      assert.equal(sh(dir, "bash health-watchdog.sh").status, 0);
      assert.equal(fs.existsSync(path.join(dir, "data", ".health-falhas")), false, "an old lock whose process is alive still holds the watchdog back");
    } finally {
      encerrarPid(dir, pid);
    }
    travaEm(dir, 40);
    sh(dir, "bash health-watchdog.sh");
    assert.equal(fs.readFileSync(path.join(dir, "data", ".health-falhas"), "utf8").trim(), "1", "a left-over lock does not silence the watchdog");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed deploy takes the pre-update backup, reverts the code and leaves the database byte for byte", { skip: !disponivel }, async () => {
  const { dir, shaA } = prepararRepo();
  const shaC = commitC(dir, shaA);
  const servico = await servicoFalso(dir, { commitInicial: shaA });
  fs.writeFileSync(path.join(dir, ".env"), `PORTA=${servico.porta}\n`);
  // The data the deploy must not touch, and a stand-in for backup-db.js that copies it (the real
  // backup and restore run in ensaio-recuperacao.js).
  const banco = path.join(dir, "data", "remoteifes.db");
  fs.mkdirSync(path.dirname(banco), { recursive: true });
  fs.writeFileSync(banco, crypto.randomBytes(8192));
  const antes = fs.readFileSync(banco);
  fs.writeFileSync(path.join(dir, "backup-db.js"), [
    'const fs = require("fs");',
    'const path = require("path");',
    'const destino = path.join("data", "backups", "remoteifes-" + Date.now() + "-" + process.argv[2] + ".db");',
    "fs.mkdirSync(path.dirname(destino), { recursive: true });",
    'fs.copyFileSync(path.join("data", "remoteifes.db"), destino);',
    "",
  ].join("\n"));
  try {
    const r = sh(dir, `bash deploy.sh ${shaC} --offline`, servico.ambiente("falha"));
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /Revertendo para/);
    assert.equal(git(dir, "rev-parse", "HEAD"), shaA);
    assert.deepEqual(fs.readFileSync(banco), antes, "the database is exactly as before the deploy");
    const backups = fs.readdirSync(path.join(dir, "data", "backups"));
    assert.equal(backups.length, 1);
    assert.match(backups[0], /pre-update/);
    assert.deepEqual(fs.readFileSync(path.join(dir, "data", "backups", backups[0])), antes);
    assert.equal(fs.existsSync(path.join(dir, "data", ".deploy-lock")), false);
    // A version that crashes at start exhausts systemd's start limit, which refuses even a manual
    // restart: every restart (of the new version and of the revert) clears that counter first.
    const chamadas = servico.chamadasSystemctl();
    const reinicios = chamadas.map((c, i) => [c, i]).filter(([c]) => /^systemctl restart remoteifes\.service$/.test(c));
    assert.equal(reinicios.length, 2);
    for (const [, i] of reinicios) assert.equal(chamadas[i - 1], "systemctl reset-failed remoteifes.service");
    // Going back to the backup is the operator's explicit step, never part of an automatic revert:
    // outside the messages printed to the operator, neither script restores or replaces the database.
    const codigo = ["deploy.sh", "rollback.sh"].map((s) => fs.readFileSync(path.join(RAIZ, s), "utf8")).join("\n").replace(/^\s*echo .*$/gm, "");
    assert.doesNotMatch(codigo, /restore-backup|npm run restore|rm [^\n]*DB_PATH|mv [^\n]*DB_PATH|cp [^\n]*DB_PATH/);
  } finally {
    servico.parar();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

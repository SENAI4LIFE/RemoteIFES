const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
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

test("deploy.sh segue adiante quando .env não define REMOTEIFES_DATA_DIR e usa o resolvedor canônico", { skip: !disponivel }, () => {
  const { dir } = prepararRepo();
  const r = sh(dir, "bash deploy.sh --offline --no-restart");
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /Versão atual:/);
  assert.match(r.stdout, /não foi possível resolver o ref 'origin\/main'/);
  assert.ok(fs.existsSync(path.join(dir, "data")), "o diretório padrão de dados precisa ter sido criado");
  assert.ok(!fs.existsSync(path.join(dir, "data", ".deploy-lock")), "o lock deve ser removido na saída");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("um REMOTEIFES_DATA_DIR relativo no .env é resolvido exatamente como o servidor resolve", { skip: !disponivel }, () => {
  const { dir } = prepararRepo("PORTA=8080\nREMOTEIFES_DATA_DIR=./dados-personalizados\n");
  const r = sh(dir, "bash deploy.sh --offline --no-restart");
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /Versão atual:/);
  assert.ok(fs.existsSync(path.join(dir, "dados-personalizados")));
  assert.ok(!fs.existsSync(path.join(dir, "data")));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("rollback.sh também chega ao fim da preparação sem REMOTEIFES_DATA_DIR", { skip: !disponivel }, () => {
  const { dir, shaA } = prepararRepo();
  const r = sh(dir, `bash rollback.sh ${shaA} --offline --no-restart`);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Já está em/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("deploy.sh não considera a atualização válida quando npm ci falha, mesmo com um node_modules antigo/parcial", { skip: !disponivel }, () => {
  const { dir, shaA, shaB } = prepararRepo();
  const r = sh(dir, `bash deploy.sh ${shaB} --offline --no-restart`, { PATH: npmFalso(dir) });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /npm ci falhou/);
  assert.doesNotMatch(r.stdout, /Atualização aplicada/);
  assert.match(r.stdout, /Revertendo para/);
  assert.equal(git(dir, "rev-parse", "HEAD"), shaA, "o código precisa voltar à versão anterior");
  assert.ok(fs.existsSync(path.join(dir, "node_modules", ".parcial")), "o cenário simulou um node_modules parcial");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("rollback.sh com npm ci falhando sai com erro e não finge que o serviço foi reiniciado", { skip: !disponivel }, () => {
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

test("deploy.sh com dependências inalteradas não roda npm ci e aplica a nova versão", { skip: !disponivel }, () => {
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

// Serviço simulado: um "processo em execução" que responde ao /health com o commit que carregou (ou
// sem commit, como as versões anteriores a esse campo) e o tempo de vida do processo, e um systemctl
// falso cujo "restart" pode aplicar a nova versão, falhar deixando o processo antigo no ar (que
// continua com o tempo de vida antigo), ou subir um processo de outra versão. sudo falso só repassa.
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

test("deploy.sh não conclui quando o restart falha e o processo antigo continua respondendo saudável", { skip: !disponivel }, async () => {
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
    assert.equal(git(dir, "rev-parse", "HEAD"), shaA, "o código volta à versão que de fato está rodando");
    assert.ok(!fs.existsSync(path.join(dir, "data", "current-version")), "nada é registrado como versão corrente");
    assert.match(lerDeployLog(dir), /FALHOU: o processo em execução continua em/);
    assert.equal(servico.chamadasSystemctl().filter((c) => c.includes("restart")).length, 2, "um restart no deploy e um na reversão");
  } finally {
    servico.parar();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("deploy.sh não conclui quando o processo que sobe informa outra versão", { skip: !disponivel }, async () => {
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
    assert.match(r.stdout, /ATENÇÃO: código revertido para/, "a reversão também não finge sucesso: o processo divergente continua no ar");
    assert.ok(!fs.existsSync(path.join(dir, "data", "current-version")));
  } finally {
    servico.parar();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("deploy.sh conclui quando o processo em execução confirma exatamente a nova versão", { skip: !disponivel }, async () => {
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

test("rollback.sh não conclui quando o restart falha e o processo da versão atual continua no ar", { skip: !disponivel }, async () => {
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
    assert.equal(git(dir, "rev-parse", "HEAD"), shaA, "o código fica na versão pedida para o operador agir");
    assert.ok(!fs.existsSync(path.join(dir, "data", "current-version")));
    assert.match(lerDeployLog(dir), /rollback .* FALHOU: o processo em execução continua em/);
  } finally {
    servico.parar();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rollback.sh conclui quando o processo confirma a versão alvo, e aceita com aviso uma versão anterior ao campo de commit", { skip: !disponivel }, async () => {
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

test("rollback.sh para uma versão sem identidade não conclui quando o processo antigo (também sem identidade) sobreviveu ao restart", { skip: !disponivel }, async () => {
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
    assert.ok(!fs.existsSync(path.join(dir, "data", "current-version")), "um /health saudável sem identidade não vira registro de sucesso");
  } finally {
    legado.parar();
  }

  // Sem commit nem tempo de vida no /health não há como verificar: também não é sucesso.
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

test("um processo sem identidade não é aceito como uma versão alvo que informaria o commit", { skip: !disponivel }, async () => {
  const { dir, shaA } = prepararRepo();
  // A versão D traz o módulo que põe o commit no /health: um processo que não o informa não pode ser ela.
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

test("deploy.sh com o código já na versão alvo não a dá por concluída: reinicia e confirma o processo, ou não faz nada quando ele já a confirma", { skip: !disponivel }, async () => {
  const { dir, shaA } = prepararRepo();
  const shaC = commitC(dir, shaA);
  // Atualização interrompida (ou 'deploy --no-restart'): o código já está em C, o serviço ainda roda A.
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
    assert.equal(fs.readFileSync(path.join(dir, "data", "previous-version"), "utf8").trim(), shaA, "a versão que estava rodando é a de retorno");
    assert.match(lerDeployLog(dir), new RegExp(`deploy ${shaA} -> ${shaC} .* ok \\(código já estava em ${shaC}; processo em execução confirmou`));

    r = sh(dir, `bash deploy.sh ${shaC} --offline`, servico.ambiente("falha"));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Já está na versão alvo .* e o processo em execução a confirma\. Nada a fazer\./);
    assert.equal(servico.chamadasSystemctl().filter((c) => c.includes("restart")).length, 1, "nada é reiniciado quando o processo já confirma a versão");
  } finally {
    servico.parar();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("deploy.sh com o código já na versão alvo e o restart falhando não registra sucesso", { skip: !disponivel }, async () => {
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
    assert.equal(git(dir, "rev-parse", "HEAD"), shaC, "sem versão anterior conhecida do checkout, o código fica para o operador agir");
    assert.ok(!fs.existsSync(path.join(dir, "data", "current-version")));
    assert.match(lerDeployLog(dir), /FALHOU: o processo em execução continua em/);
  } finally {
    servico.parar();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rollback.sh com o código já na versão alvo reinicia e confirma em vez de dar o rollback por feito", { skip: !disponivel }, async () => {
  const { dir, shaA } = prepararRepo();
  const shaC = commitC(dir, shaA);
  // Rollback anterior que reverteu o código mas cujo restart não confirmou: HEAD em A, processo em C.
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

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
  for (const arquivo of ["deploy.sh", "rollback.sh", "healthcheck.sh"]) {
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

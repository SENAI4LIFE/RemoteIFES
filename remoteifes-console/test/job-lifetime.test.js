const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const ajuda = require("./helpers");

// Job lifetime independent of the Console process. Each test starts the job from a separate
// "Console" process, kills that process with SIGKILL (a crash, a unit restart, a self-update) and
// then checks, from a fresh Console, that the job kept running, kept its maintenance lock, and that
// its real outcome is recorded instead of an inferred one.

const POSIX = process.platform !== "win32";

function checkoutFalso() {
  const raiz = ajuda.dirTemporario("console-vida-");
  fs.mkdirSync(path.join(raiz, "remoteifes-server", "data", "backups"), { recursive: true });
  fs.writeFileSync(path.join(raiz, "remoteifes-server", "package.json"), JSON.stringify({ version: "3.0.0" }));
  fs.writeFileSync(path.join(raiz, "remoteifes-server", ".env"), "PORTA=8188\n");
  return raiz;
}

// Starts a job from another Node process that plays the Console, and resolves with the job id and
// the supervisor PID once the job is running. The caller kills the process.
function consoleQueInicia(amb, checkout, spec) {
  const codigo = `
    const execucao = require(${JSON.stringify(path.join(ajuda.RAIZ, "src", "execucao.js"))});
    const t = execucao.iniciar(${JSON.stringify(spec)});
    process.stdout.write(JSON.stringify({ id: t.id, pid: t.pid }) + "\\n");
    setInterval(() => {}, 1000);
  `;
  const filho = spawn(process.execPath, ["-e", codigo], {
    env: { ...process.env, CONSOLE_ESTADO_DIR: amb.estadoDir, CONSOLE_CHECKOUT_DIR: checkout, CONSOLE_SEM_PRIVILEGIO: "1" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((resolve, reject) => {
    let texto = "";
    filho.stdout.on("data", (d) => {
      texto += d;
      const linha = texto.split("\n")[0];
      if (texto.includes("\n")) resolve({ processo: filho, ...JSON.parse(linha) });
    });
    filho.on("error", reject);
    filho.on("exit", (c) => reject(new Error(`the Console process exited early (${c})`)));
  });
}

async function matar(processo) {
  await new Promise((resolve) => {
    processo.removeAllListeners("exit");
    processo.once("exit", resolve);
    processo.kill("SIGKILL");
  });
}

async function ate(condicao, limiteMs = 20_000) {
  const inicio = Date.now();
  while (Date.now() - inicio < limiteMs) {
    const v = condicao();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  return condicao();
}

function vivo(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Runner that keeps writing output after the Console is gone (a pipe owned by the dead Console
// would make these writes fail) and leaves a marker only if it reached the end.
function runner(marcador, { esperaMs = 1500, codigo = 0, pidArquivo = null } = {}) {
  return [
    "-e",
    `${pidArquivo ? `require("fs").writeFileSync(${JSON.stringify(pidArquivo)}, String(process.pid));` : ""}
     console.log("inicio");
     setTimeout(() => {
       for (let i = 0; i < 200; i++) console.log("linha de progresso " + i);
       require("fs").writeFileSync(${JSON.stringify(marcador)}, "ok");
       console.log("fim da operação");
       process.exitCode = ${codigo};
     }, ${esperaMs});`,
  ];
}

test("a job survives the death of the Console that started it, keeps its lock and its outcome is recorded", { skip: !POSIX && "POSIX signals" }, async (t) => {
  const checkout = checkoutFalso();
  const amb = ajuda.ambiente({ checkout });
  t.after(() => {
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });
  const marcador = path.join(checkout, "marcador");

  const iniciado = await consoleQueInicia(amb, checkout, {
    acao: "teste.sobrevive",
    rotulo: "Sobrevive",
    operador: "op",
    executavel: process.execPath,
    argumentos: runner(marcador),
    cwd: checkout,
    exigeTrava: true,
    timeoutMs: 30_000,
  });
  await matar(iniciado.processo);

  const trava = amb.trava.lerTrava();
  assert.ok(trava, "the lock still exists");
  assert.equal(trava.pid, iniciado.pid, "the lock names the supervisor, not the dead Console");
  assert.equal(trava.vivo, true, "the lock is not residual while the job runs");
  assert.throws(() => amb.trava.adquirir({ acao: "outra", trabalhoId: "x", operador: "op" }), /em andamento/);

  assert.ok(await ate(() => fs.existsSync(marcador)), "the runner reached its end after the Console died");
  await ate(() => !vivo(iniciado.pid));

  assert.equal(amb.execucao.reconciliar(), 0);
  const registro = amb.execucao.obter(iniciado.id);
  assert.equal(registro.estado, amb.execucao.ESTADOS.CONCLUIDO);
  assert.equal(registro.codigo, 0);
  assert.equal(registro.verificacao.ok, null, "a job nobody watched is not reported as verified");
  assert.match(registro.verificacao.resumo, /não foi verificado/);
  assert.match(amb.execucao.lerSaida(iniciado.id).texto, /linha de progresso 199[\s\S]*fim da operação/);
  assert.equal(amb.trava.lerTrava(), null, "reconciliation releases the finished job's lock");
  assert.ok(amb.estado.lerAuditoria(50).some((e) => e.evento === "trava-liberada-na-reconciliacao"));
});

test("a job adopted while its supervisor still runs is followed to its real exit code", { skip: !POSIX && "POSIX signals" }, async (t) => {
  const checkout = checkoutFalso();
  const amb = ajuda.ambiente({ checkout });
  t.after(() => {
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });
  const marcador = path.join(checkout, "marcador");

  const iniciado = await consoleQueInicia(amb, checkout, {
    acao: "teste.adotado",
    rotulo: "Adotado",
    operador: "op",
    executavel: process.execPath,
    argumentos: runner(marcador, { esperaMs: 2500, codigo: 4 }),
    cwd: checkout,
    exigeTrava: false,
    timeoutMs: 30_000,
  });
  await matar(iniciado.processo);

  assert.equal(amb.execucao.reconciliar(), 0, "a live supervisor is not an unknown outcome");
  assert.equal(amb.execucao.obter(iniciado.id).estado, "executando");
  assert.ok(amb.execucao.trabalhoAtivo(), "the adopted job still blocks a second operation");
  assert.equal(amb.execucao.temTrabalhoNaMemoria(), true, "the Console does not idle-exit while following it");

  const final = await ate(() => {
    const r = amb.execucao.obter(iniciado.id);
    return r.estado !== "executando" ? r : null;
  });
  assert.ok(final, "the adopted job finishes");
  assert.equal(final.estado, amb.execucao.ESTADOS.FALHOU);
  assert.equal(final.codigo, 4, "the runner's real exit code, read from the supervisor's record");
  assert.equal(amb.execucao.temTrabalhoNaMemoria(), false);
});

test("the supervisor enforces the maximum duration when no Console is watching", { skip: !POSIX && "POSIX signals" }, async (t) => {
  const checkout = checkoutFalso();
  const amb = ajuda.ambiente({ checkout });
  t.after(() => {
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });
  const pidArquivo = path.join(checkout, "runner.pid");

  const iniciado = await consoleQueInicia(amb, checkout, {
    acao: "teste.prazo",
    rotulo: "Prazo",
    operador: "op",
    executavel: process.execPath,
    argumentos: runner(path.join(checkout, "nunca"), { esperaMs: 120_000, pidArquivo }),
    cwd: checkout,
    exigeTrava: false,
    timeoutMs: 1500,
  });
  await matar(iniciado.processo);
  await ate(() => fs.existsSync(pidArquivo));
  const pidRunner = Number(fs.readFileSync(pidArquivo, "utf8"));

  assert.ok(await ate(() => !vivo(iniciado.pid) && !vivo(pidRunner), 20_000), "no orphan runner is left after the deadline");
  amb.execucao.reconciliar();
  const registro = amb.execucao.obter(iniciado.id);
  assert.equal(registro.estado, amb.execucao.ESTADOS.DESCONHECIDO, "an expired job is never a success");
  assert.match(registro.erro, /prazo máximo/);
});

test("cancelling a running job stops the runner and records the cancellation", { skip: !POSIX && "POSIX signals" }, async (t) => {
  const checkout = checkoutFalso();
  const amb = ajuda.ambiente({ checkout });
  t.after(() => {
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });
  const pidArquivo = path.join(checkout, "runner.pid");

  const trabalho = amb.execucao.iniciar({
    acao: "teste.cancelar",
    rotulo: "Cancelar",
    operador: "op",
    executavel: process.execPath,
    argumentos: runner(path.join(checkout, "nunca"), { esperaMs: 60_000, pidArquivo }),
    cwd: checkout,
    exigeTrava: true,
    timeoutMs: 120_000,
  });
  await ate(() => fs.existsSync(pidArquivo));
  const pidRunner = Number(fs.readFileSync(pidArquivo, "utf8"));
  assert.equal(amb.execucao.cancelar(trabalho.id, "op").ok, true);

  const final = await ate(() => {
    const r = amb.execucao.obter(trabalho.id);
    return r.estado !== "executando" ? r : null;
  });
  assert.equal(final.estado, amb.execucao.ESTADOS.CANCELADO);
  assert.ok(await ate(() => !vivo(pidRunner)), "the runner itself received the cancellation");
  assert.equal(amb.trava.lerTrava(), null, "the lock is released after cancellation");
});

test("input for the runner goes through the supervisor's stdin and never to disk", async (t) => {
  const checkout = checkoutFalso();
  const amb = ajuda.ambiente({ checkout });
  t.after(() => {
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  const segredo = "segredo-de-teste-" + Date.now();
  const trabalho = amb.execucao.iniciar({
    acao: "teste.entrada",
    rotulo: "Entrada",
    operador: "op",
    executavel: process.execPath,
    argumentos: ["-e", "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log('recebi '+d.length+' bytes'))"],
    cwd: checkout,
    entrada: segredo,
    exigeTrava: false,
  });
  const final = await ate(() => {
    const r = amb.execucao.obter(trabalho.id);
    return r.estado !== "executando" ? r : null;
  });
  assert.equal(final.estado, amb.execucao.ESTADOS.CONCLUIDO);
  assert.match(amb.execucao.lerSaida(trabalho.id).texto, new RegExp(`recebi ${segredo.length} bytes`));
  for (const nome of fs.readdirSync(amb.estadoDir, { recursive: true })) {
    const completo = path.join(amb.estadoDir, String(nome));
    if (fs.statSync(completo).isFile()) assert.ok(!fs.readFileSync(completo, "utf8").includes(segredo), `${nome} contains the input`);
  }
});

test("the systemd unit stops only the Console process, not the job supervisors", () => {
  const unidade = fs.readFileSync(path.join(ajuda.RAIZ, "systemd", "remoteifes-console.service.modelo"), "utf8");
  assert.match(unidade, /^KillMode=process$/m, "the default control-group mode would kill running jobs on a Console restart");
});

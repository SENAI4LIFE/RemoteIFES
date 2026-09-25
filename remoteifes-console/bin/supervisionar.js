#!/usr/bin/env node
// Job supervisor: the process that owns a Console job for its whole life.
//
// The Console starts this supervisor detached, hands it the job on stdin and keeps no pipe to it
// afterwards. The supervisor then owns everything the job needs to finish without the Console:
//
//  - the runner's stdout/stderr pipes, appended to the job's output file with the same byte cap;
//  - the maximum duration, enforced here, so a job never runs unbounded when no Console watches it;
//  - the maintenance lock heartbeat, when the job holds the lock (the lock records this PID);
//  - the outcome, written atomically to `<id>.fim.json` before exiting, so a Console that restarted
//    in the middle reads the real exit status instead of guessing.
//
// A SIGTERM (cancellation, sent to the whole process group) is recorded and waited on: the runner
// receives the same signal, and the outcome file still gets written when it exits.
//
// Input (stdin, JSON): { spec: { executavel, argumentos, cwd, env, timeoutMs, arquivoSaida,
// arquivoFim, limiteSaida, trava }, entrada }. `entrada` (for example a password) is forwarded to
// the runner's stdin and never written anywhere else.

const fs = require("fs");
const { spawn } = require("child_process");

const LIMITE_PEDIDO = 1024 * 1024;
const HEARTBEAT_MS = 60_000;
const GRACA_KILL_MS = 10_000;

function lerStdin() {
  return new Promise((resolve, reject) => {
    const pedacos = [];
    let total = 0;
    process.stdin.on("data", (d) => {
      total += d.length;
      if (total > LIMITE_PEDIDO) {
        reject(new Error("pedido grande demais"));
        process.stdin.destroy();
        return;
      }
      pedacos.push(d);
    });
    process.stdin.on("end", () => resolve(Buffer.concat(pedacos).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

function gravarAtomico(arquivo, dados) {
  const temporario = `${arquivo}.${process.pid}.tmp`;
  fs.writeFileSync(temporario, JSON.stringify(dados), { mode: 0o600 });
  fs.renameSync(temporario, arquivo);
}

function criarSaida(arquivo, limite) {
  let bytes = 0;
  try {
    bytes = fs.statSync(arquivo).size;
  } catch {}
  let avisado = false;
  return (pedaco) => {
    if (bytes >= limite) {
      if (!avisado) {
        avisado = true;
        try {
          fs.appendFileSync(arquivo, "\n… [limite de saída atingido; o restante não foi retido] …\n");
        } catch {}
      }
      return;
    }
    const recorte = Buffer.from(pedaco).subarray(0, limite - bytes);
    try {
      fs.appendFileSync(arquivo, recorte);
    } catch {}
    bytes += recorte.length;
  };
}

function manterTrava(arquivo) {
  if (!arquivo) return null;
  const relogio = setInterval(() => {
    try {
      const pid = Number.parseInt(fs.readFileSync(arquivo, "utf8").trim().split(/\s+/)[0], 10);
      if (pid !== process.pid) return;
      const agora = new Date();
      fs.utimesSync(arquivo, agora, agora);
    } catch {}
  }, HEARTBEAT_MS);
  relogio.unref();
  return relogio;
}

async function main() {
  let pedido;
  try {
    pedido = JSON.parse(await lerStdin());
  } catch (erro) {
    process.exitCode = 70;
    return;
  }
  const spec = pedido.spec || {};
  const anexar = criarSaida(spec.arquivoSaida, spec.limiteSaida || 4 * 1024 * 1024);
  const registrarFim = (dados) => {
    try {
      gravarAtomico(spec.arquivoFim, { ...dados, supervisor: process.pid, terminadoEm: new Date().toISOString() });
    } catch (erro) {
      anexar(`\n[supervisor] não foi possível gravar o desfecho: ${erro.message}\n`);
    }
  };

  let cancelado = false;
  let expirou = false;
  // Cancellation arrives as SIGTERM to the whole group. Staying alive until the runner exits is
  // what lets the outcome be recorded.
  process.on("SIGTERM", () => {
    if (!expirou) cancelado = true;
  });
  process.on("SIGINT", () => {
    if (!expirou) cancelado = true;
  });
  process.on("SIGHUP", () => {});

  const temEntrada = typeof pedido.entrada === "string";
  let filho;
  try {
    filho = spawn(spec.executavel, spec.argumentos || [], {
      cwd: spec.cwd,
      env: spec.env,
      stdio: [temEntrada ? "pipe" : "ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
  } catch (erro) {
    anexar(`[supervisor] não foi possível iniciar: ${erro.message}\n`);
    registrarFim({ codigo: null, sinal: null, erroInicio: erro.message });
    process.exitCode = 1;
    return;
  }

  const heartbeat = manterTrava(spec.trava);
  filho.stdout.on("data", anexar);
  filho.stderr.on("data", anexar);
  if (temEntrada) {
    filho.stdin.on("error", () => {});
    filho.stdin.end(pedido.entrada);
  }
  pedido = null;

  const prazo = setTimeout(() => {
    expirou = true;
    anexar("\n[supervisor] prazo máximo atingido; encerrando a operação.\n");
    try {
      process.kill(filho.pid, "SIGTERM");
    } catch {}
    setTimeout(() => {
      // Past the grace period the whole group goes, this supervisor included. The outcome is
      // recorded first: an expired job is an unknown outcome either way.
      registrarFim({ codigo: null, sinal: "SIGKILL", expirou: true });
      try {
        process.kill(-process.pid, "SIGKILL");
      } catch {
        try {
          process.kill(filho.pid, "SIGKILL");
        } catch {}
        process.exit(1);
      }
    }, GRACA_KILL_MS).unref();
  }, spec.timeoutMs || 30 * 60 * 1000);

  filho.on("error", (erro) => {
    clearTimeout(prazo);
    if (heartbeat) clearInterval(heartbeat);
    anexar(`[supervisor] ${erro.message}\n`);
    registrarFim({ codigo: null, sinal: null, erroInicio: erro.message });
    process.exitCode = 1;
  });

  filho.on("close", (codigo, sinal) => {
    clearTimeout(prazo);
    if (heartbeat) clearInterval(heartbeat);
    registrarFim({ codigo, sinal: sinal || null, cancelado, expirou });
    process.exitCode = codigo === null ? 1 : codigo;
  });
}

main().catch((erro) => {
  try {
    process.stderr.write(`supervisor: ${erro && erro.message}\n`);
  } catch {}
  process.exitCode = 1;
});


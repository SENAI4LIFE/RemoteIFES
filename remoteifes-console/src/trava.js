const fs = require("fs");
const path = require("path");
const config = require("./config");
const estado = require("./estado");

// Maintenance coordination between the Console, the CLI (deploy.sh/rollback.sh) and the watchdog.
//
// The `.deploy-lock` file is the same one the scripts use, in the same format ("<pid> <data>"), so
// a hand-run `bash deploy.sh` still sees the Console's lock and vice versa. Two corrections on top
// of the scripts' behavior:
//
//  1. The scripts remove the lock by age (>= 30 min), which would treat a long, legitimate update
//     as leftover. The Console's lock gets a *heartbeat* (mtime updated) while the operation is
//     alive, so it never ages by itself.
//  2. Age is not ownership. Before taking over an existing lock the Console checks whether the
//     recorded PID is still alive; a live operation is never overridden, however old.
//
// The .deploy-lock.console.json sidecar records ownership (who, which action, since when). It is
// informational: the scripts do not need to know about it.

const HEARTBEAT_MS = 60_000;
const IDADE_RESIDUO_MS = 30 * 60 * 1000;

function caminhos() {
  const app = config.caminhosDaAplicacao();
  return { trava: app.travaDeploy, sidecar: `${app.travaDeploy}.console.json`, dirDados: app.dirDados };
}

function processoVivo(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (erro) {
    // EPERM means the process exists but belongs to another user.
    return erro.code === "EPERM";
  }
}

function lerTrava() {
  const { trava, sidecar } = caminhos();
  let conteudo = null;
  let stat = null;
  try {
    conteudo = fs.readFileSync(trava, "utf8").trim();
    stat = fs.statSync(trava);
  } catch {
    return null;
  }
  const pid = Number.parseInt(String(conteudo).split(/\s+/)[0], 10);
  const meta = estado.lerJson(sidecar, null);
  const idadeMs = stat ? Date.now() - stat.mtimeMs : 0;
  return {
    conteudo,
    pid: Number.isFinite(pid) ? pid : null,
    vivo: processoVivo(pid),
    idadeMs,
    parecResiduo: idadeMs >= IDADE_RESIDUO_MS,
    dono: meta && meta.dono === "console" ? meta : null,
    origem: meta && meta.dono === "console" ? "console" : "cli",
  };
}

/**
 * Maintenance status, for display and for deciding whether an action may start.
 */
function situacao() {
  const atual = lerTrava();
  if (!atual) return { ocupada: false };
  return {
    ocupada: atual.vivo,
    residuo: !atual.vivo,
    pid: atual.pid,
    origem: atual.origem,
    acao: atual.dono ? atual.dono.acao : null,
    trabalhoId: atual.dono ? atual.dono.trabalhoId : null,
    desde: atual.dono ? atual.dono.desde : null,
    idadeSegundos: Math.round(atual.idadeMs / 1000),
    descricao: atual.vivo
      ? atual.origem === "console"
        ? `operação "${atual.dono.acao}" em andamento no console (PID ${atual.pid})`
        : `uma atualização/rollback pelo terminal está em andamento (PID ${atual.pid})`
      : `trava residual de um processo que não existe mais (PID ${atual.pid ?? "?"}, ${Math.round(atual.idadeMs / 1000)}s)`,
  };
}

class Trava {
  constructor(arquivo, sidecar) {
    this.arquivo = arquivo;
    this.sidecar = sidecar;
    this.relogio = null;
    this.liberada = false;
  }

  iniciarHeartbeat() {
    this.relogio = setInterval(() => {
      try {
        const agora = new Date();
        fs.utimesSync(this.arquivo, agora, agora);
      } catch {
        // If the lock disappeared (someone removed it by hand), the heartbeat no longer makes
        // sense.
      }
    }, HEARTBEAT_MS);
    if (typeof this.relogio.unref === "function") this.relogio.unref();
  }

  liberar() {
    if (this.liberada) return;
    this.liberada = true;
    if (this.relogio) clearInterval(this.relogio);
    try {
      // Removes only if still ours: avoids deleting a lock another process took over.
      const conteudo = fs.readFileSync(this.arquivo, "utf8").trim();
      if (Number.parseInt(conteudo.split(/\s+/)[0], 10) === process.pid) {
        fs.rmSync(this.arquivo, { force: true });
      }
    } catch {}
    try {
      const meta = estado.lerJson(this.sidecar, null);
      if (meta && meta.pid === process.pid) fs.rmSync(this.sidecar, { force: true });
    } catch {}
  }
}

/**
 * Acquires the maintenance lock. Never removes the lock of a live process, not even an old one. A
 * dead process's lock is reconciled (recorded in the audit) and taken over.
 */
function adquirir({ acao, trabalhoId, operador }) {
  const { trava, sidecar, dirDados } = caminhos();
  fs.mkdirSync(dirDados, { recursive: true });

  const atual = lerTrava();
  if (atual && atual.vivo) {
    const erro = new Error(situacao().descricao);
    erro.codigo = "ocupado";
    throw erro;
  }
  if (atual && !atual.vivo) {
    estado.auditar("trava-residual-reconciliada", {
      pidAnterior: atual.pid,
      origemAnterior: atual.origem,
      acaoAnterior: atual.dono ? atual.dono.acao : null,
      idadeSegundos: Math.round(atual.idadeMs / 1000),
    });
    fs.rmSync(trava, { force: true });
    fs.rmSync(sidecar, { force: true });
  }

  let fd;
  try {
    // wx reproduces the scripts' `set -o noclobber`: if someone created the lock between the check
    // and now, creation fails instead of overwriting.
    fd = fs.openSync(trava, "wx", 0o644);
    fs.writeFileSync(fd, `${process.pid} ${new Date().toISOString()}\n`, "utf8");
  } catch (erro) {
    const conflito = new Error("outra operação assumiu a manutenção neste instante; tente de novo");
    conflito.codigo = "ocupado";
    throw conflito;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }

  estado.gravarJson(
    sidecar,
    { dono: "console", pid: process.pid, acao, trabalhoId, operador, desde: new Date().toISOString() },
    0o644
  );

  const objeto = new Trava(trava, sidecar);
  objeto.iniciarHeartbeat();
  return objeto;
}

/**
 * Explicit removal of a leftover lock, requested by the operator. Refuses a live process's lock.
 */
function removerResiduo(operador) {
  const atual = lerTrava();
  if (!atual) return { ok: false, erro: "não há trava de manutenção" };
  if (atual.vivo) return { ok: false, erro: `a trava pertence ao processo ${atual.pid}, que ainda está em execução` };
  const { trava, sidecar } = caminhos();
  fs.rmSync(trava, { force: true });
  fs.rmSync(sidecar, { force: true });
  estado.auditar("trava-removida-manualmente", { operador, pidAnterior: atual.pid, idadeSegundos: Math.round(atual.idadeMs / 1000) });
  return { ok: true };
}

module.exports = { adquirir, situacao, lerTrava, removerResiduo, processoVivo, IDADE_RESIDUO_MS };

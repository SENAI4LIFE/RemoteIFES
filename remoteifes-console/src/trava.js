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
    // A lock whose PID cannot be read (the scripts create the file and then write it) is uncertain and
    // counts as alive, as in deploy.sh: it is kept rather than taken over.
    vivo: Number.isFinite(pid) ? processoVivo(pid) : true,
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
        : `uma atualização/rollback pelo terminal está em andamento (PID ${atual.pid ?? "ainda não gravado"})`
      : `trava residual de um processo que não existe mais (PID ${atual.pid ?? "?"}, ${Math.round(atual.idadeMs / 1000)}s)`,
  };
}

// Taking over a left-over lock is serialized with the shell scripts (deploy.sh, rollback.sh) by a
// directory next to the lock, created with mkdir, which is atomic; the decision is made again while
// holding it. Without it, a reclaimer that paused between reading a dead lock and removing it could
// delete the lock another operation had just taken over. The directory is never removed by age (that
// would race the same way one level up): one left behind by a reclaimer that died inside these few
// operations stops automatic takeover until someone removes it, and the refusal says so.
function comMutexDeReclamacao(fn) {
  const mutex = `${caminhos().trava}.reclamacao`;
  try {
    fs.mkdirSync(mutex);
  } catch (erro) {
    if (erro.code !== "EEXIST") throw erro;
    return { emAndamento: true, mutex };
  }
  try {
    return { emAndamento: false, resultado: fn() };
  } finally {
    try {
      fs.rmdirSync(mutex);
    } catch {}
  }
}

const LIBERACAO_TENTATIVAS_IMEDIATAS = 50;
const LIBERACAO_INTERVALO_MS = 20;

class Trava {
  constructor(arquivo, sidecar) {
    this.arquivo = arquivo;
    this.sidecar = sidecar;
    this.relogio = null;
    this.liberada = false;
    this.pid = process.pid;
  }

  /**
   * Hands the lock to the process that actually runs the operation (the job supervisor). Liveness
   * checks then follow that process: the lock stays valid if this Console process ends first.
   */
  transferirPara(pid) {
    if (this.liberada || this.liberando || !Number.isInteger(pid) || pid <= 0) return;
    const conteudo = fs.readFileSync(this.arquivo, "utf8").trim();
    if (Number.parseInt(conteudo.split(/\s+/)[0], 10) !== this.pid) return;
    const temporario = `${this.arquivo}.${process.pid}.tmp`;
    fs.writeFileSync(temporario, `${pid} ${new Date().toISOString()}\n`, { encoding: "utf8", mode: 0o644 });
    fs.renameSync(temporario, this.arquivo);
    const meta = estado.lerJson(this.sidecar, null);
    if (meta && meta.pid === this.pid) estado.gravarJson(this.sidecar, { ...meta, pid, consolePid: process.pid }, 0o644);
    this.pid = pid;
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
    this.liberando = true;
    if (this.relogio) {
      clearInterval(this.relogio);
      this.relogio = null;
    }
    // Removes only if still ours, checked under the reclamation mutex: the recorded owner may be a
    // supervisor that has already exited, so another operation may be taking the lock over right now.
    // A busy mutex is waited for briefly and then retried in the background: the release is only
    // done once it actually happened, so a lock that still names this live process is never left
    // blocking maintenance.
    for (let tentativa = 0; tentativa < LIBERACAO_TENTATIVAS_IMEDIATAS; tentativa += 1) {
      if (this.tentarLiberar()) return;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LIBERACAO_INTERVALO_MS);
    }
    if (!this.reliberacao) {
      this.reliberacao = setInterval(() => {
        if (this.tentarLiberar()) {
          clearInterval(this.reliberacao);
          this.reliberacao = null;
        }
      }, LIBERACAO_INTERVALO_MS * 10);
      if (typeof this.reliberacao.unref === "function") this.reliberacao.unref();
    }
  }

  // Done only on a confirmed outcome: the lock was removed, is gone, or is no longer ours. A busy
  // mutex or any filesystem error (no space for the mutex, an unreadable or busy file) leaves the
  // release pending, to be retried.
  tentarLiberar() {
    if (this.liberada) return true;
    let r;
    try {
      r = comMutexDeReclamacao(() => {
        let conteudo;
        try {
          conteudo = fs.readFileSync(this.arquivo, "utf8").trim();
        } catch (erro) {
          if (erro.code === "ENOENT") return true;
          return false;
        }
        if (Number.parseInt(conteudo.split(/\s+/)[0], 10) !== this.pid) return true;
        try {
          fs.rmSync(this.arquivo);
          return true;
        } catch (erro) {
          return erro.code === "ENOENT";
        }
      });
    } catch {
      return false;
    }
    if (r.emAndamento || r.resultado !== true) return false;
    this.liberada = true;
    try {
      const meta = estado.lerJson(this.sidecar, null);
      if (meta && meta.pid === this.pid) fs.rmSync(this.sidecar, { force: true });
    } catch {}
    return true;
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
    const reclamacao = comMutexDeReclamacao(() => {
      // Judged again while holding the mutex: only the same dead lock is removed.
      const deNovo = lerTrava();
      if (!deNovo || deNovo.vivo || deNovo.conteudo !== atual.conteudo) return false;
      estado.auditar("trava-residual-reconciliada", {
        pidAnterior: atual.pid,
        origemAnterior: atual.origem,
        acaoAnterior: atual.dono ? atual.dono.acao : null,
        idadeSegundos: Math.round(atual.idadeMs / 1000),
      });
      fs.rmSync(trava, { force: true });
      fs.rmSync(sidecar, { force: true });
      return true;
    });
    if (reclamacao.emAndamento) {
      const erro = new Error(
        "outra operação está reconciliando a trava de manutenção; tente de novo. Se isso persistir sem nenhuma " +
          `operação em andamento, ${reclamacao.mutex} ficou de uma reconciliação interrompida: remova esse diretório vazio.`
      );
      erro.codigo = "ocupado";
      throw erro;
    }
  }

  // The lock appears already holding its PID: written to a private file and hard-linked into place,
  // which fails if the name exists (the scripts' `set -o noclobber`). A file created empty and
  // filled afterwards could be judged dead and removed in between.
  const temporario = `${trava}.${process.pid}.${Date.now()}.novo`;
  try {
    fs.writeFileSync(temporario, `${process.pid} ${new Date().toISOString()}\n`, { encoding: "utf8", mode: 0o644, flag: "wx" });
    try {
      fs.linkSync(temporario, trava);
    } catch (erro) {
      if (erro.code === "EEXIST") throw erro;
      // A filesystem without hard links: exclusive creation, PID written right after.
      const fd = fs.openSync(trava, "wx", 0o644);
      try {
        fs.writeFileSync(fd, fs.readFileSync(temporario));
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch (erro) {
    const conflito = new Error("outra operação assumiu a manutenção neste instante; tente de novo");
    conflito.codigo = "ocupado";
    throw conflito;
  } finally {
    try {
      fs.rmSync(temporario, { force: true });
    } catch {}
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
 * Removes the lock of a finished job whose supervisor is gone, during reconciliation. Only when the
 * lock still names that PID and the process is dead.
 */
function removerDoProcesso(pid) {
  const atual = lerTrava();
  if (!atual || atual.pid !== pid || atual.vivo) return false;
  const { trava, sidecar } = caminhos();
  const r = comMutexDeReclamacao(() => {
    const deNovo = lerTrava();
    if (!deNovo || deNovo.vivo || deNovo.conteudo !== atual.conteudo) return false;
    fs.rmSync(trava, { force: true });
    fs.rmSync(sidecar, { force: true });
    return true;
  });
  return !r.emAndamento && r.resultado === true;
}

/**
 * Explicit removal of a leftover lock, requested by the operator. Refuses a live process's lock.
 */
function removerResiduo(operador) {
  const atual = lerTrava();
  if (!atual) return { ok: false, erro: "não há trava de manutenção" };
  if (atual.vivo) return { ok: false, erro: `a trava pertence ao processo ${atual.pid}, que ainda está em execução` };
  const { trava, sidecar } = caminhos();
  const r = comMutexDeReclamacao(() => {
    const deNovo = lerTrava();
    if (!deNovo || deNovo.vivo || deNovo.conteudo !== atual.conteudo) return false;
    fs.rmSync(trava, { force: true });
    fs.rmSync(sidecar, { force: true });
    return true;
  });
  if (r.emAndamento) {
    return { ok: false, erro: `outra operação está reconciliando a trava; tente de novo (se persistir sem operação em andamento, remova o diretório vazio ${r.mutex})` };
  }
  if (!r.resultado) return { ok: false, erro: "a trava mudou desde a consulta; consulte de novo" };
  estado.auditar("trava-removida-manualmente", { operador, pidAnterior: atual.pid, idadeSegundos: Math.round(atual.idadeMs / 1000) });
  return { ok: true };
}

module.exports = { adquirir, situacao, lerTrava, removerResiduo, removerDoProcesso, processoVivo, IDADE_RESIDUO_MS };

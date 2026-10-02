const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const config = require("./config");
const estado = require("./estado");

// Maintenance coordination between the Console, the CLI (deploy.sh/rollback.sh) and the watchdog.
//
// The `.deploy-lock` file is the same one the scripts use, in the same format ("<pid> <data>
// [<identidade>]"), so a hand-run `bash deploy.sh` still sees the Console's lock and vice versa. Two
// corrections on top of the scripts' behavior:
//
//  1. The scripts remove the lock by age (>= 30 min), which would treat a long, legitimate update
//     as leftover. The Console's lock gets a *heartbeat* (mtime updated) while the operation is
//     alive, so it never ages by itself.
//  2. Age is not ownership. Before taking over an existing lock the Console checks whether the
//     recorded PID is still alive; a live operation is never overridden, however old.
//
// The PID is the operating system's (the scripts record the Windows PID under Git Bash). Where /proc
// has it (Linux), the identity next to it is the boot and the process's start time: after a crash or
// a reboot the PID may belong to another process, which then does not pass for the owner.
//
// The .deploy-lock.console.json sidecar records ownership (who, which action, since when). It is
// informational: the scripts do not need to know about it.

const HEARTBEAT_MS = 60_000;
const IDADE_RESIDUO_MS = 30 * 60 * 1000;
const MUTEX_SEM_REGISTRO_MS = 10 * 60 * 1000;
const RE_IDENTIDADE = /^[0-9a-f-]+:\d+$/i;
const RE_NONCE = /^[0-9A-Za-z]+$/;

function caminhos() {
  const app = config.caminhosDaAplicacao();
  return { trava: app.travaDeploy, sidecar: `${app.travaDeploy}.console.json`, dirDados: app.dirDados };
}

function lerOuNulo(arquivo) {
  try {
    return fs.readFileSync(arquivo, "utf8").trim();
  } catch {
    return null;
  }
}

function bootAtual() {
  return lerOuNulo("/proc/sys/kernel/random/boot_id") || null;
}

/**
 * Identity of a running process where /proc has it: "<boot>:<start time>". `null` elsewhere.
 */
function identidadeDe(pid) {
  const boot = bootAtual();
  const stat = boot && lerOuNulo(`/proc/${pid}/stat`);
  if (!stat) return null;
  // Field 22 is the start time; the command name (field 2) may contain spaces and parentheses.
  const inicio = stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19];
  return /^\d+$/.test(inicio || "") ? `${boot}:${inicio}` : null;
}

/**
 * Alive unless certainly gone. With a recorded identity, one from another boot or different from the
 * running process's means the PID now belongs to another process.
 */
function processoVivo(pid, identidade = null) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (erro) {
    // EPERM means the process exists but belongs to another user.
    if (erro.code !== "EPERM") return false;
  }
  if (!identidade || !RE_IDENTIDADE.test(identidade)) return true;
  const boot = bootAtual();
  if (!boot) return true;
  if (identidade.split(":")[0] !== boot) return false;
  const atual = identidadeDe(pid);
  return !atual || atual === identidade;
}

function conteudoDaTrava(pid) {
  const identidade = identidadeDe(pid);
  return `${pid} ${new Date().toISOString()}${identidade ? ` ${identidade}` : ""}`;
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
  const campos = String(conteudo).split(/\s+/);
  const pid = Number.parseInt(campos[0], 10);
  const identidade = RE_IDENTIDADE.test(campos[2] || "") ? campos[2] : null;
  const meta = estado.lerJson(sidecar, null);
  const idadeMs = stat ? Date.now() - stat.mtimeMs : 0;
  return {
    conteudo,
    pid: Number.isFinite(pid) ? pid : null,
    // A lock whose PID cannot be read (the scripts create the file and then write it) is uncertain and
    // counts as alive, as in deploy.sh: it is kept rather than taken over.
    vivo: Number.isFinite(pid) ? processoVivo(pid, identidade) : true,
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
// delete the lock another operation had just taken over.
//
// The holder records itself in the directory as "<pid> <identidade|-> <nonce>": in `dono`, or, when
// it took over from a holder that died, in `sucessor.<that holder's nonce>`; the current holder is the
// end of that chain. Each record is hard-linked into place, which fails if the name exists, so only
// one process takes over from a given holder, and one that judged a directory since released and
// created again lands outside the chain and backs off. Nothing is removed by age, so one level up
// does not race the same way: a holder that died is taken over at once, and a directory without a
// record (older versions never write one; this one writes it right after the mkdir) after 10
// minutes. Release moves the directory aside first, so it disappears in one step.
const MENSAGEM_MUTEX =
  "uma reconciliação interrompida é assumida automaticamente: de imediato quando o processo registrado nela não existe mais, " +
  "ou após 10 minutos quando não há registro";

function camposDoRegistro(registro) {
  const [pid, identidade, nonce] = String(registro || "").split(/\s+/);
  return {
    pid: /^\d+$/.test(pid || "") ? Number(pid) : null,
    identidade: identidade && identidade !== "-" ? identidade : null,
    nonce: RE_NONCE.test(nonce || "") ? nonce : null,
  };
}

function donoDoMutex(mutex) {
  let registro = lerOuNulo(path.join(mutex, "dono"));
  for (let i = 0; registro && i < 100; i += 1) {
    const { nonce } = camposDoRegistro(registro);
    if (!nonce) break;
    const proximo = lerOuNulo(path.join(mutex, `sucessor.${nonce}`));
    if (proximo === null) break;
    registro = proximo;
  }
  return registro || null;
}

function removerLixoDoMutex(mutex) {
  const prefixo = `${path.basename(mutex)}.lixo.`;
  let nomes = [];
  try {
    nomes = fs.readdirSync(path.dirname(mutex));
  } catch {
    return;
  }
  for (const nome of nomes) {
    if (!nome.startsWith(prefixo)) continue;
    try {
      fs.rmSync(path.join(path.dirname(mutex), nome), { recursive: true, force: true });
    } catch {}
  }
}

function gravarRegistro(mutex, alvo, registro, nonce) {
  const temporario = path.join(mutex, `.novo.${nonce}`);
  try {
    fs.writeFileSync(temporario, `${registro}\n`, { encoding: "utf8", mode: 0o644, flag: "wx" });
  } catch {
    return;
  }
  try {
    fs.linkSync(temporario, alvo);
  } catch (erro) {
    if (erro.code !== "EEXIST" && erro.code !== "ENOENT") {
      // A filesystem without hard links: exclusive creation, the record written right after.
      try {
        fs.writeFileSync(alvo, `${registro}\n`, { encoding: "utf8", mode: 0o644, flag: "wx" });
      } catch {}
    }
  } finally {
    try {
      fs.rmSync(temporario, { force: true });
    } catch {}
  }
}

/**
 * Takes the reclamation mutex. Returns this holder's record, or `null` when another live holder has
 * it (or it cannot be judged yet).
 */
function adquirirMutex(mutex) {
  removerLixoDoMutex(mutex);
  let alvo;
  let criado = false;
  try {
    fs.mkdirSync(mutex);
    alvo = path.join(mutex, "dono");
    criado = true;
  } catch (erro) {
    if (erro.code !== "EEXIST") throw erro;
    let stat;
    try {
      stat = fs.statSync(mutex);
    } catch {
      return null;
    }
    if (!stat.isDirectory()) return null;
    const dono = donoDoMutex(mutex);
    if (!dono) {
      if (Date.now() - stat.mtimeMs < MUTEX_SEM_REGISTRO_MS) return null;
      alvo = path.join(mutex, "dono");
    } else {
      const { pid, identidade, nonce } = camposDoRegistro(dono);
      // A record with this process's PID is not another live holder's.
      if (!nonce || pid === null || (pid !== process.pid && processoVivo(pid, identidade))) return null;
      alvo = path.join(mutex, `sucessor.${nonce}`);
    }
  }
  const nonce = crypto.randomBytes(8).toString("hex");
  const registro = `${process.pid} ${identidadeDe(process.pid) || "-"} ${nonce}`;
  gravarRegistro(mutex, alvo, registro, nonce);
  if (donoDoMutex(mutex) === registro) return { registro, nonce };
  if (lerOuNulo(alvo) === registro) {
    try {
      fs.rmSync(alvo, { force: true });
    } catch {}
  }
  // A directory this process created and could not record itself in is removed if still empty
  // (rmdir leaves it to whoever recorded itself there instead).
  if (criado) {
    try {
      fs.rmdirSync(mutex);
    } catch {}
  }
  return null;
}

function liberarMutex(mutex, { registro, nonce }) {
  if (donoDoMutex(mutex) !== registro) return;
  const lixo = `${mutex}.lixo.${nonce}`;
  try {
    fs.renameSync(mutex, lixo);
  } catch {
    // Could not move it aside (Windows refuses while a file inside is open): this process gives up
    // its place, and the rest is taken over as left over.
    let nomes = [];
    try {
      nomes = fs.readdirSync(mutex);
    } catch {}
    for (const nome of nomes) {
      if ((nome === "dono" || nome.startsWith("sucessor.")) && lerOuNulo(path.join(mutex, nome)) === registro) {
        try {
          fs.rmSync(path.join(mutex, nome), { force: true });
        } catch {}
      }
    }
    try {
      fs.rmdirSync(mutex);
    } catch {}
    return;
  }
  try {
    fs.rmSync(lixo, { recursive: true, force: true });
  } catch {}
}

function comMutexDeReclamacao(fn) {
  const mutex = `${caminhos().trava}.reclamacao`;
  const posse = adquirirMutex(mutex);
  if (!posse) return { emAndamento: true, mutex };
  try {
    return { emAndamento: false, resultado: fn() };
  } finally {
    liberarMutex(mutex, posse);
  }
}

const LIBERACAO_TENTATIVAS_IMEDIATAS = 50;
const LIBERACAO_INTERVALO_MS = 20;

class Trava {
  constructor(arquivo, sidecar, conteudo) {
    this.arquivo = arquivo;
    this.sidecar = sidecar;
    this.relogio = null;
    this.liberada = false;
    this.pid = process.pid;
    // Ownership is the exact content this process wrote: a PID alone may have been reused.
    this.conteudo = conteudo;
  }

  /**
   * Hands the lock to the process that actually runs the operation (the job supervisor). Liveness
   * checks then follow that process: the lock stays valid if this Console process ends first.
   */
  transferirPara(pid) {
    if (this.liberada || this.liberando || !Number.isInteger(pid) || pid <= 0) return;
    if (fs.readFileSync(this.arquivo, "utf8").trim() !== this.conteudo) return;
    const conteudo = conteudoDaTrava(pid);
    const temporario = `${this.arquivo}.${process.pid}.tmp`;
    fs.writeFileSync(temporario, `${conteudo}\n`, { encoding: "utf8", mode: 0o644 });
    fs.renameSync(temporario, this.arquivo);
    const meta = estado.lerJson(this.sidecar, null);
    if (meta && meta.pid === this.pid) estado.gravarJson(this.sidecar, { ...meta, pid, consolePid: process.pid }, 0o644);
    this.pid = pid;
    this.conteudo = conteudo;
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
        if (conteudo !== this.conteudo) return true;
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
        `outra operação está reconciliando a trava de manutenção (${reclamacao.mutex}); tente de novo. ${MENSAGEM_MUTEX}.`
      );
      erro.codigo = "ocupado";
      throw erro;
    }
  }

  // The lock appears already holding its PID: written to a private file and hard-linked into place,
  // which fails if the name exists (the scripts' `set -o noclobber`). A file created empty and
  // filled afterwards could be judged dead and removed in between.
  const conteudo = conteudoDaTrava(process.pid);
  const temporario = `${trava}.${process.pid}.${Date.now()}.novo`;
  try {
    fs.writeFileSync(temporario, `${conteudo}\n`, { encoding: "utf8", mode: 0o644, flag: "wx" });
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

  const objeto = new Trava(trava, sidecar, conteudo);
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
    return { ok: false, erro: `outra operação está reconciliando a trava (${r.mutex}); tente de novo. ${MENSAGEM_MUTEX}.` };
  }
  if (!r.resultado) return { ok: false, erro: "a trava mudou desde a consulta; consulte de novo" };
  estado.auditar("trava-removida-manualmente", { operador, pidAnterior: atual.pid, idadeSegundos: Math.round(atual.idadeMs / 1000) });
  return { ok: true };
}

module.exports = { adquirir, situacao, lerTrava, removerResiduo, removerDoProcesso, processoVivo, IDADE_RESIDUO_MS };

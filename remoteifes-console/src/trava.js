const fs = require("fs");
const path = require("path");
const config = require("./config");
const estado = require("./estado");

// Coordenação de manutenção entre console, CLI (deploy.sh/rollback.sh) e watchdog.
//
// O arquivo `.deploy-lock` continua sendo o mesmo que os scripts usam, no mesmo formato
// ("<pid> <data>"), para que `bash deploy.sh` rodado à mão continue enxergando a trava do
// console e vice-versa. Duas correções importantes em cima do comportamento original:
//
//  1. Os scripts removem a trava por idade (>= 30 min). Uma atualização longa e legítima
//     passava a ser tratada como resíduo. Aqui a trava do console recebe um *heartbeat*
//     (mtime atualizado) enquanto a operação está viva, então ela nunca "envelhece" sozinha.
//  2. Idade não é dono. Antes de assumir uma trava existente o console confere se o PID
//     registrado ainda está vivo; uma operação viva nunca é atropelada, por mais antiga que seja.
//
// O sidecar .deploy-lock.console.json guarda a posse (quem, qual ação, desde quando). Ele é
// informativo: os scripts não precisam conhecê-lo.

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
    // EPERM significa que o processo existe mas pertence a outro usuário.
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
 * Situação da manutenção para exibir e para decidir se uma ação pode começar.
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
        // Se a trava sumiu (alguém a removeu à mão), o heartbeat para de fazer sentido.
      }
    }, HEARTBEAT_MS);
    if (typeof this.relogio.unref === "function") this.relogio.unref();
  }

  liberar() {
    if (this.liberada) return;
    this.liberada = true;
    if (this.relogio) clearInterval(this.relogio);
    try {
      // Só remove se ainda for nossa: evita apagar a trava de outro processo que a assumiu.
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
 * Adquire a trava de manutenção. Nunca remove a trava de um processo vivo, nem mesmo antiga.
 * Uma trava de processo morto é reconciliada (registrada na auditoria) e assumida.
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
    // wx reproduz o `set -o noclobber` dos scripts: se alguém criou a trava entre a checagem
    // e agora, a criação falha em vez de sobrescrever.
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
 * Remoção explícita de trava residual, pedida pelo operador. Recusa trava de processo vivo.
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

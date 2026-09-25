const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { EventEmitter } = require("events");
const config = require("./config");
const estado = require("./estado");
const trava = require("./trava");
const processos = require("./processos");

// Long-running job engine (update, rollback, backup, restore...).
//
// What the design guarantees, precisely, and what it does **not**:
//
//  - **Closing the browser interrupts nothing.** Output goes to a file and the job does not depend
//    on the HTTP request that started it. This is guaranteed.
//
//  - **A Console restart does not kill the job in all cases, but can in one.** The child runs in
//    its own process group (`detached`), detaching it from the terminal and the parent's group.
//    Under a systemd service, however, the child stays in the **unit's cgroup**: a `systemctl
//    restart remoteifes-console.service` with the default `KillMode` ends the whole cgroup, child
//    included. It survives an idle exit and a Console crash, but not necessarily a unit restart.
//
//  - **That is why the unknown outcome exists.** When the Console returns and finds a "running" job
//    whose process is gone, it assumes nothing: it records an **unknown** outcome. Reconciliation
//    checks the PID and, where the system offers it, the process identity (start time), because
//    PIDs are reused.
//
//  - **No child is left loose forever:** each action has a maximum duration, and whatever exceeds
//    it is terminated and marked unknown, never success.

const ESTADOS = Object.freeze({
  EXECUTANDO: "executando",
  CONCLUIDO: "concluido",
  FALHOU: "falhou",
  CANCELADO: "cancelado",
  DESCONHECIDO: "desconhecido",
});

const eventos = new EventEmitter();
eventos.setMaxListeners(50);

const emMemoria = new Map();

function dirSaidas() {
  fs.mkdirSync(config.DIR_SAIDAS, { recursive: true, mode: 0o700 });
  return config.DIR_SAIDAS;
}

function lerRegistro() {
  const dados = estado.lerJson(config.ARQUIVO_TRABALHOS, { trabalhos: [] });
  return Array.isArray(dados.trabalhos) ? dados : { trabalhos: [] };
}

function gravarRegistro(dados) {
  dados.trabalhos = dados.trabalhos.slice(0, config.JOB_HISTORICO_MAX);
  estado.gravarJson(config.ARQUIVO_TRABALHOS, dados, 0o600);
}

function caminhoSaida(id) {
  return path.join(dirSaidas(), `${id}.log`);
}

function podarSaidas(idsValidos) {
  let nomes = [];
  try {
    nomes = fs.readdirSync(config.DIR_SAIDAS);
  } catch {
    return;
  }
  for (const nome of nomes) {
    const id = nome.replace(/\.log$/, "");
    if (!idsValidos.has(id)) fs.rmSync(path.join(config.DIR_SAIDAS, nome), { force: true });
  }
}

function salvar(trabalho) {
  const dados = lerRegistro();
  const indice = dados.trabalhos.findIndex((t) => t.id === trabalho.id);
  const registro = {
    id: trabalho.id,
    acao: trabalho.acao,
    rotulo: trabalho.rotulo,
    operador: trabalho.operador,
    argumentos: trabalho.argumentosVisiveis || {},
    estado: trabalho.estado,
    iniciadoEm: trabalho.iniciadoEm,
    terminadoEm: trabalho.terminadoEm || null,
    pid: trabalho.pid || null,
    iniciadoProcessoEm: trabalho.iniciadoProcessoEm || null,
    codigo: trabalho.codigo === undefined ? null : trabalho.codigo,
    resumo: trabalho.resumo || null,
    erro: trabalho.erro || null,
    fase: trabalho.fase || null,
    irreversivel: !!trabalho.irreversivel,
    verificacao: trabalho.verificacao || null,
  };
  if (indice >= 0) dados.trabalhos[indice] = registro;
  else dados.trabalhos.unshift(registro);
  gravarRegistro(dados);
  podarSaidas(new Set(dados.trabalhos.map((t) => t.id)));
  return registro;
}

function listar(limite = 20) {
  return lerRegistro().trabalhos.slice(0, limite);
}

function obter(id) {
  return lerRegistro().trabalhos.find((t) => t.id === id) || null;
}

function lerSaida(id, { desdeByte = 0 } = {}) {
  const arquivo = caminhoSaida(id);
  let stat;
  try {
    stat = fs.statSync(arquivo);
  } catch {
    return { texto: "", tamanho: 0, truncado: false };
  }
  const inicio = Math.max(0, Math.min(desdeByte, stat.size));
  const fd = fs.openSync(arquivo, "r");
  try {
    const tamanho = stat.size - inicio;
    const buffer = Buffer.alloc(Math.min(tamanho, config.JOB_SAIDA_MAX_BYTES));
    const lidos = fs.readSync(fd, buffer, 0, buffer.length, inicio);
    return {
      texto: buffer.subarray(0, lidos).toString("utf8"),
      tamanho: stat.size,
      truncado: tamanho > buffer.length,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function trabalhoAtivo() {
  const emExecucao = lerRegistro().trabalhos.find((t) => t.estado === ESTADOS.EXECUTANDO);
  if (!emExecucao) return null;
  if (emExecucao.pid && !trava.processoVivo(emExecucao.pid) && !emMemoria.has(emExecucao.id)) return null;
  return emExecucao;
}

/**
 * Reconciliation at start. The Console may have exited on idle, crashed or been restarted by a
 * self-update while a job was running.
 */
/**
 * Is the recorded process really that one, and not another that inherited the PID? On Linux,
 * `/proc/<pid>` has the start time; where that does not exist the check returns `true` and
 * verification is limited to the PID, which is stated in the record instead of assumed.
 */
function identidadeDeProcessoConfere(trabalho) {
  if (!trabalho.iniciadoProcessoEm) return true;
  try {
    const stat = fs.statSync(`/proc/${trabalho.pid}`);
    // The process directory is created with the process; a large difference reveals another
    // process.
    return Math.abs(stat.ctimeMs - Date.parse(trabalho.iniciadoProcessoEm)) < 60_000;
  } catch {
    return true;
  }
}

function reconciliar() {
  const dados = lerRegistro();
  let mudou = false;
  for (const t of dados.trabalhos) {
    if (t.estado !== ESTADOS.EXECUTANDO) continue;
    // A live PID is not enough: the number is reused, and any process that inherited the PID would
    // make a dead job look alive. Where the system allows, identity is confirmed by the start time
    // recorded together with the PID.
    if (t.pid && trava.processoVivo(t.pid) && identidadeDeProcessoConfere(t)) {
      t.resumo = t.resumo || "operação iniciada antes deste processo do console ainda em andamento";
      mudou = true;
      continue;
    }
    t.estado = ESTADOS.DESCONHECIDO;
    t.terminadoEm = t.terminadoEm || new Date().toISOString();
    t.erro =
      "o console foi reiniciado enquanto esta operação corria e o processo não existe mais: " +
      "o desfecho não pôde ser comprovado. Confira o estado atual antes de repetir.";
    mudou = true;
    estado.auditar("trabalho-desfecho-desconhecido", { id: t.id, acao: t.acao, pid: t.pid });
  }
  if (mudou) gravarRegistro(dados);
  return dados.trabalhos.filter((t) => t.estado === ESTADOS.DESCONHECIDO).length;
}

/**
 * Starts a job.
 *
 * @param {object} spec
 *  - acao, rotulo, operador
 *  - executavel, argumentos, cwd, env
 *  - exigeTrava: acquires the maintenance lock shared with deploy.sh/rollback.sh
 *  - timeoutMs, cancelavel, faseIrreversivel: function(text) marking that cancellation is no longer
 *    possible
 *  - verificar: async function called at the end, returns { ok, resumo } to confirm the effect
 */
function iniciar(spec) {
  const ativo = trabalhoAtivo();
  if (ativo) {
    const erro = new Error(`já existe uma operação em andamento: ${ativo.rotulo || ativo.acao}`);
    erro.codigo = "ocupado";
    throw erro;
  }

  const id = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomBytes(4).toString("hex")}`;
  const arquivoSaida = caminhoSaida(id);
  fs.writeFileSync(arquivoSaida, "", { mode: 0o600 });

  let travaAdquirida = null;
  if (spec.exigeTrava) {
    travaAdquirida = trava.adquirir({ acao: spec.acao, trabalhoId: id, operador: spec.operador });
  }

  const trabalho = {
    id,
    acao: spec.acao,
    rotulo: spec.rotulo || spec.acao,
    operador: spec.operador,
    argumentosVisiveis: spec.argumentosVisiveis || {},
    estado: ESTADOS.EXECUTANDO,
    iniciadoEm: new Date().toISOString(),
    pid: null,
    fase: spec.faseInicial || "preparando",
    irreversivel: false,
    cancelavel: spec.cancelavel !== false,
  };

  let filho;
  try {
    filho = spawn(spec.executavel, spec.argumentos || [], {
      cwd: spec.cwd || config.DIR_SERVIDOR,
      // The Console's resolved configuration is passed explicitly: `ambienteLimpo` builds the
      // environment from a fixed list, so a child runner would not inherit which checkout and state
      // directory this Console manages and would fall back to defaults, acting on the wrong place.
      env: processos.ambienteLimpo({
        CONSOLE_ESTADO_DIR: config.DIR_ESTADO,
        CONSOLE_CHECKOUT_DIR: config.DIR_CHECKOUT,
        CONSOLE_SEM_PRIVILEGIO: config.SEM_PRIVILEGIO ? "1" : "0",
        CONSOLE_AUXILIAR: config.AUXILIAR,
        ...(spec.env || {}),
      }),
      stdio: [spec.entrada === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      shell: false,
      // Own group: detaches the child from the terminal and the Console's group, and makes
      // cancellation reach the whole tree instead of only the direct process.
      ...require("./plataforma").opcoesDeGrupo(),
      windowsHide: true,
    });
  } catch (erro) {
    if (travaAdquirida) travaAdquirida.liberar();
    trabalho.estado = ESTADOS.FALHOU;
    trabalho.erro = `não foi possível iniciar: ${erro.message}`;
    trabalho.terminadoEm = new Date().toISOString();
    return salvar(trabalho);
  }

  trabalho.pid = filho.pid;
  trabalho.iniciadoProcessoEm = (() => {
    try {
      return new Date(fs.statSync(`/proc/${filho.pid}`).ctimeMs).toISOString();
    } catch {
      return null;
    }
  })();
  salvar(trabalho);
  estado.auditar("trabalho-iniciado", {
    id,
    acao: spec.acao,
    operador: spec.operador,
    pid: filho.pid,
    argumentos: trabalho.argumentosVisiveis,
  });

  const contexto = { filho, trava: travaAdquirida, bytes: 0, spec, trabalho, cancelando: false };
  emMemoria.set(id, contexto);

  const anexar = (pedaco) => {
    const texto = pedaco.toString("utf8");
    if (contexto.bytes < config.JOB_SAIDA_MAX_BYTES) {
      const espaco = config.JOB_SAIDA_MAX_BYTES - contexto.bytes;
      const recorte = Buffer.from(texto).subarray(0, espaco);
      try {
        fs.appendFileSync(arquivoSaida, recorte);
      } catch {}
      contexto.bytes += recorte.length;
      if (contexto.bytes >= config.JOB_SAIDA_MAX_BYTES) {
        try {
          fs.appendFileSync(arquivoSaida, "\n… [limite de saída atingido; o restante não foi retido] …\n");
        } catch {}
      }
    }
    if (typeof spec.faseIrreversivel === "function" && !trabalho.irreversivel && spec.faseIrreversivel(texto)) {
      trabalho.irreversivel = true;
      trabalho.fase = "ponto sem retorno";
      salvar(trabalho);
    }
    if (typeof spec.detectarFase === "function") {
      const fase = spec.detectarFase(texto);
      if (fase && fase !== trabalho.fase) {
        trabalho.fase = fase;
        salvar(trabalho);
      }
    }
    eventos.emit("saida", { id });
  };

  filho.stdout.on("data", anexar);
  filho.stderr.on("data", anexar);
  if (spec.entrada !== undefined && filho.stdin) {
    filho.stdin.on("error", () => {});
    filho.stdin.end(spec.entrada);
  }

  const prazo = setTimeout(() => {
    contexto.expirou = true;
    encerrarArvore(filho.pid, "SIGTERM");
    setTimeout(() => encerrarArvore(filho.pid, "SIGKILL"), 10_000).unref();
  }, spec.timeoutMs || config.JOB_TIMEOUT_PADRAO_MS);
  if (typeof prazo.unref === "function") prazo.unref();

  filho.on("error", (erro) => {
    clearTimeout(prazo);
    finalizar(contexto, { estadoFinal: ESTADOS.FALHOU, erro: erro.message });
  });

  filho.on("close", async (codigo, sinal) => {
    clearTimeout(prazo);
    let estadoFinal;
    let erro = null;
    if (contexto.cancelando) {
      estadoFinal = ESTADOS.CANCELADO;
      erro = "cancelada pelo operador";
    } else if (contexto.expirou) {
      estadoFinal = ESTADOS.DESCONHECIDO;
      erro = "a operação passou do prazo máximo e foi interrompida; o desfecho não é conhecido";
    } else if (codigo === 0) {
      estadoFinal = ESTADOS.CONCLUIDO;
    } else {
      estadoFinal = ESTADOS.FALHOU;
      erro = sinal ? `encerrada pelo sinal ${sinal}` : `código de saída ${codigo}`;
    }
    await finalizar(contexto, { estadoFinal, erro, codigo, sinal });
  });

  return salvar(trabalho);
}

async function finalizar(contexto, { estadoFinal, erro, codigo = null, sinal = null }) {
  const { trabalho, spec } = contexto;
  trabalho.estado = estadoFinal;
  trabalho.codigo = codigo;
  trabalho.terminadoEm = new Date().toISOString();
  trabalho.erro = erro || null;
  trabalho.fase = estadoFinal === ESTADOS.CONCLUIDO ? "concluída" : trabalho.fase;

  // Verification of the real effect: exit code 0 does not prove the service started on the right
  // version or that the backup is intact. Each action states how it is checked.
  if (typeof spec.verificar === "function") {
    try {
      const resultado = await spec.verificar({ estadoFinal, codigo, saida: () => lerSaida(trabalho.id).texto });
      if (resultado) {
        trabalho.verificacao = resultado;
        if (resultado.ok === false && estadoFinal === ESTADOS.CONCLUIDO) {
          trabalho.estado = ESTADOS.DESCONHECIDO;
          trabalho.erro = resultado.resumo || "a operação terminou sem erro, mas o efeito não pôde ser confirmado";
        }
        if (resultado.resumo) trabalho.resumo = resultado.resumo;
      }
    } catch (e) {
      // A verification that throws must not become "completed": not knowing whether the effect
      // happened is exactly the unknown outcome, and it is recorded that way.
      trabalho.verificacao = { ok: false, resumo: `verificação falhou: ${e.message}` };
      if (trabalho.estado === ESTADOS.CONCLUIDO) {
        trabalho.estado = ESTADOS.DESCONHECIDO;
        trabalho.erro = `a operação terminou sem erro, mas a verificação do efeito falhou (${e.message}); confira o estado atual.`;
      }
    }
  }

  if (contexto.trava) contexto.trava.liberar();
  emMemoria.delete(trabalho.id);
  salvar(trabalho);
  estado.auditar("trabalho-terminado", {
    id: trabalho.id,
    acao: trabalho.acao,
    estado: trabalho.estado,
    codigo,
    operador: trabalho.operador,
  });
  eventos.emit("fim", { id: trabalho.id, estado: trabalho.estado });
  if (typeof spec.aoTerminar === "function") {
    try {
      await spec.aoTerminar(trabalho);
    } catch {}
  }
}

function encerrarArvore(pid, sinal) {
  // Delegated to the adapter: on POSIX the process group; on Windows `taskkill /T`, because there
  // is no POSIX group there and killing only the parent would leave grandchildren alive.
  require("./plataforma").encerrarArvore(pid, sinal);
}

function cancelar(id, operador) {
  const contexto = emMemoria.get(id);
  if (!contexto) {
    const registro = obter(id);
    if (registro && registro.estado === ESTADOS.EXECUTANDO && registro.pid && trava.processoVivo(registro.pid)) {
      return { ok: false, erro: "esta operação foi iniciada por outro processo do console; acompanhe até o fim ou intervenha pelo terminal" };
    }
    return { ok: false, erro: "operação não está em andamento" };
  }
  if (contexto.trabalho.irreversivel) {
    return { ok: false, erro: "a operação passou do ponto em que podia ser desfeita; interromper agora deixaria o sistema em estado indefinido" };
  }
  if (contexto.spec.cancelavel === false) {
    return { ok: false, erro: "esta operação não pode ser cancelada" };
  }
  contexto.cancelando = true;
  estado.auditar("trabalho-cancelado", { id, operador });
  encerrarArvore(contexto.filho.pid, "SIGTERM");
  setTimeout(() => {
    if (emMemoria.has(id)) encerrarArvore(contexto.filho.pid, "SIGKILL");
  }, 10_000).unref();
  return { ok: true };
}

function temTrabalhoNaMemoria() {
  return emMemoria.size > 0;
}

module.exports = {
  ESTADOS,
  eventos,
  iniciar,
  cancelar,
  listar,
  obter,
  lerSaida,
  reconciliar,
  trabalhoAtivo,
  temTrabalhoNaMemoria,
  caminhoSaida,
};

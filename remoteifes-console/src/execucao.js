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
//    on the HTTP request that started it.
//
//  - **The job does not depend on the Console process.** Every job runs under its own supervisor
//    (bin/supervisionar.js), started detached in its own process group. The Console keeps no pipe
//    to it: the supervisor holds the runner's output pipes, enforces the maximum duration, keeps the
//    maintenance lock (which records the supervisor's PID) alive and writes the exit status to
//    `<id>.fim.json`. A Console crash, idle exit, self-update or unit restart (the systemd unit uses
//    KillMode=process) no longer breaks the job's output or releases its lock.
//
//  - **Reconciliation reads facts.** A Console that starts and finds a "running" job reads its
//    outcome file when present; adopts and follows a supervisor that is still alive (PID plus start
//    time, because PIDs are reused); and records an **unknown** outcome only when the supervisor is
//    gone without an outcome. A job finished while no Console watched it is not re-verified: the
//    record says so instead of claiming the verification ran.
//
//  - **No job is left loose forever:** the supervisor enforces each action's maximum duration
//    itself, and an expired job is recorded as unknown, never success.

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

function caminhoFim(id) {
  return path.join(dirSaidas(), `${id}.fim.json`);
}

function lerFim(id) {
  try {
    const dados = JSON.parse(fs.readFileSync(caminhoFim(id), "utf8"));
    return dados && typeof dados === "object" ? dados : null;
  } catch {
    return null;
  }
}

function podarSaidas(idsValidos) {
  let nomes = [];
  try {
    nomes = fs.readdirSync(config.DIR_SAIDAS);
  } catch {
    return;
  }
  for (const nome of nomes) {
    const id = nome.split(".")[0];
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
  if (emExecucao.pid && !trava.processoVivo(emExecucao.pid) && !emMemoria.has(emExecucao.id) && !adotados.has(emExecucao.id)) return null;
  return emExecucao;
}

/**
 * Final state from the supervisor's outcome record. `null` when there is no record.
 */
function desfechoDoFim(fim) {
  if (!fim) return null;
  if (fim.expirou) {
    return { estadoFinal: ESTADOS.DESCONHECIDO, erro: "a operação passou do prazo máximo e foi interrompida; o desfecho não é conhecido", codigo: null, sinal: fim.sinal || null };
  }
  if (fim.cancelado) return { estadoFinal: ESTADOS.CANCELADO, erro: "cancelada pelo operador", codigo: fim.codigo, sinal: fim.sinal || null };
  if (fim.erroInicio) return { estadoFinal: ESTADOS.FALHOU, erro: `não foi possível iniciar: ${fim.erroInicio}`, codigo: null, sinal: null };
  if (fim.codigo === 0) return { estadoFinal: ESTADOS.CONCLUIDO, erro: null, codigo: 0, sinal: null };
  return {
    estadoFinal: ESTADOS.FALHOU,
    erro: fim.sinal ? `encerrada pelo sinal ${fim.sinal}` : `código de saída ${fim.codigo}`,
    codigo: fim.codigo,
    sinal: fim.sinal || null,
  };
}

// Jobs started by a previous Console process whose supervisor is still running.
const adotados = new Map();

const NAO_VERIFICADO =
  "o console não acompanhava a operação quando ela terminou: o efeito não foi verificado automaticamente. Confira o estado atual.";

function liberarTravaDe(pid) {
  const atual = trava.lerTrava();
  if (atual && atual.pid === pid && !atual.vivo) {
    trava.removerDoProcesso(pid);
    estado.auditar("trava-liberada-na-reconciliacao", { pid });
  }
}

function concluirSemAcompanhamento(t, fim) {
  const desfecho = desfechoDoFim(fim);
  t.estado = desfecho.estadoFinal;
  t.codigo = desfecho.codigo;
  t.erro = desfecho.erro;
  t.terminadoEm = fim.terminadoEm || new Date().toISOString();
  if (desfecho.estadoFinal === ESTADOS.CONCLUIDO) {
    t.verificacao = { ok: null, resumo: NAO_VERIFICADO };
    t.resumo = NAO_VERIFICADO;
  }
  liberarTravaDe(t.pid);
  estado.auditar("trabalho-terminado", { id: t.id, acao: t.acao, estado: t.estado, codigo: t.codigo, operador: t.operador, acompanhado: false });
}

function acompanharAdotado(id) {
  if (adotados.has(id)) return;
  const relogio = setInterval(() => {
    const dados = lerRegistro();
    const t = dados.trabalhos.find((x) => x.id === id);
    if (!t || t.estado !== ESTADOS.EXECUTANDO) {
      clearInterval(relogio);
      adotados.delete(id);
      return;
    }
    const fim = lerFim(id);
    const vivo = trava.processoVivo(t.pid) && identidadeDeProcessoConfere(t);
    if (!fim && vivo) {
      eventos.emit("saida", { id });
      return;
    }
    if (fim) concluirSemAcompanhamento(t, fim);
    else marcarDesconhecido(t);
    gravarRegistro(dados);
    fs.rmSync(caminhoFim(id), { force: true });
    clearInterval(relogio);
    adotados.delete(id);
    eventos.emit("fim", { id, estado: t.estado });
  }, 1000);
  if (typeof relogio.unref === "function") relogio.unref();
  adotados.set(id, relogio);
}

function marcarDesconhecido(t) {
  t.estado = ESTADOS.DESCONHECIDO;
  t.terminadoEm = t.terminadoEm || new Date().toISOString();
  t.erro =
    "o processo desta operação não existe mais e não deixou registro de desfecho: " +
    "o desfecho não pôde ser comprovado. Confira o estado atual antes de repetir.";
  estado.auditar("trabalho-desfecho-desconhecido", { id: t.id, acao: t.acao, pid: t.pid });
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
  let desconhecidos = 0;
  const finalizados = [];
  for (const t of dados.trabalhos) {
    if (t.estado !== ESTADOS.EXECUTANDO || emMemoria.has(t.id)) continue;
    // The outcome record is a fact written by the supervisor; it wins over any inference.
    const fim = lerFim(t.id);
    if (fim) {
      concluirSemAcompanhamento(t, fim);
      mudou = true;
      finalizados.push(t.id);
      continue;
    }
    // A live PID is not enough: the number is reused, and any process that inherited the PID would
    // make a dead job look alive. Where the system allows, identity is confirmed by the start time
    // recorded together with the PID.
    if (t.pid && trava.processoVivo(t.pid) && identidadeDeProcessoConfere(t)) {
      t.resumo = t.resumo || "operação iniciada antes deste processo do console ainda em andamento";
      mudou = true;
      acompanharAdotado(t.id);
      continue;
    }
    marcarDesconhecido(t);
    desconhecidos += 1;
    mudou = true;
  }
  if (mudou) gravarRegistro(dados);
  for (const id of finalizados) fs.rmSync(caminhoFim(id), { force: true });
  return desconhecidos;
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
  const arquivoFim = caminhoFim(id);
  fs.rmSync(arquivoFim, { force: true });
  try {
    filho = spawn(process.execPath, [path.join(config.RAIZ_CONSOLE, "bin", "supervisionar.js")], {
      cwd: spec.cwd || config.DIR_SERVIDOR,
      env: processos.ambienteLimpo(),
      // Only stdin, to hand over the job. No output pipe ties the supervisor to this process.
      stdio: ["pipe", "ignore", "ignore"],
      shell: false,
      // Own group: detaches the supervisor from the terminal and the Console's group, and makes
      // cancellation reach the whole tree (supervisor, runner and its children).
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
  // The lock follows the supervisor: if this Console process ends, the lock still belongs to a
  // live process and no other operation can take it over.
  if (travaAdquirida) travaAdquirida.transferirPara(filho.pid);
  salvar(trabalho);
  estado.auditar("trabalho-iniciado", {
    id,
    acao: spec.acao,
    operador: spec.operador,
    pid: filho.pid,
    argumentos: trabalho.argumentosVisiveis,
  });

  filho.stdin.on("error", () => {});
  filho.stdin.end(
    JSON.stringify({
      spec: {
        executavel: spec.executavel,
        argumentos: spec.argumentos || [],
        cwd: spec.cwd || config.DIR_SERVIDOR,
        // The Console's resolved configuration is passed explicitly: `ambienteLimpo` builds the
        // environment from a fixed list, so a child runner would not inherit which checkout and
        // state directory this Console manages and would fall back to defaults, acting on the
        // wrong place.
        env: processos.ambienteLimpo({
          CONSOLE_ESTADO_DIR: config.DIR_ESTADO,
          CONSOLE_CHECKOUT_DIR: config.DIR_CHECKOUT,
          CONSOLE_SEM_PRIVILEGIO: config.SEM_PRIVILEGIO ? "1" : "0",
          CONSOLE_AUXILIAR: config.AUXILIAR,
          ...(spec.env || {}),
        }),
        timeoutMs: spec.timeoutMs || config.JOB_TIMEOUT_PADRAO_MS,
        arquivoSaida,
        arquivoFim,
        limiteSaida: config.JOB_SAIDA_MAX_BYTES,
        trava: travaAdquirida ? travaAdquirida.arquivo : null,
      },
      entrada: spec.entrada === undefined ? null : String(spec.entrada),
    })
  );

  const contexto = { filho, trava: travaAdquirida, lidos: 0, spec, trabalho, cancelando: false };
  emMemoria.set(id, contexto);

  // Output is followed from the file the supervisor writes: phase detection and live streaming work
  // the same way whether or not this process is the one that started the job.
  const acompanharSaida = () => {
    let tamanho;
    try {
      tamanho = fs.statSync(arquivoSaida).size;
    } catch {
      return;
    }
    if (tamanho <= contexto.lidos) return;
    const fd = fs.openSync(arquivoSaida, "r");
    let texto;
    try {
      const buffer = Buffer.alloc(tamanho - contexto.lidos);
      const lidos = fs.readSync(fd, buffer, 0, buffer.length, contexto.lidos);
      contexto.lidos += lidos;
      texto = buffer.subarray(0, lidos).toString("utf8");
    } finally {
      fs.closeSync(fd);
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
  const leitor = setInterval(acompanharSaida, 250);
  if (typeof leitor.unref === "function") leitor.unref();

  // Backstop only: the supervisor enforces the maximum duration itself and records it.
  const prazo = setTimeout(() => {
    contexto.expirou = true;
    encerrarArvore(filho.pid, "SIGKILL");
  }, (spec.timeoutMs || config.JOB_TIMEOUT_PADRAO_MS) + 60_000);
  if (typeof prazo.unref === "function") prazo.unref();

  filho.on("error", (erro) => {
    clearTimeout(prazo);
    clearInterval(leitor);
    finalizar(contexto, { estadoFinal: ESTADOS.FALHOU, erro: erro.message });
  });

  filho.on("close", async (codigo, sinal) => {
    clearTimeout(prazo);
    clearInterval(leitor);
    acompanharSaida();
    const desfecho = desfechoDoFim(lerFim(id));
    let estadoFinal;
    let erro = null;
    if (contexto.cancelando) {
      estadoFinal = ESTADOS.CANCELADO;
      erro = "cancelada pelo operador";
    } else if (desfecho) {
      ({ estadoFinal, erro } = desfecho);
      codigo = desfecho.codigo;
      sinal = desfecho.sinal;
    } else if (contexto.expirou) {
      estadoFinal = ESTADOS.DESCONHECIDO;
      erro = "a operação passou do prazo máximo e foi interrompida; o desfecho não é conhecido";
    } else {
      // The supervisor ended without recording an outcome (killed from outside, for example): the
      // runner's result is not known.
      estadoFinal = ESTADOS.DESCONHECIDO;
      erro = `o supervisor da operação terminou sem registrar o desfecho (${sinal ? `sinal ${sinal}` : `código ${codigo}`}); confira o estado atual`;
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
  // The record now holds the outcome; the supervisor's outcome file is no longer needed.
  fs.rmSync(caminhoFim(trabalho.id), { force: true });
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
  return emMemoria.size > 0 || adotados.size > 0;
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

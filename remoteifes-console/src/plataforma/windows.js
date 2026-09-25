const fs = require("fs");
const os = require("os");
const path = require("path");
const base = require("./base");
const config = require("../config");
const processos = require("../processos");

// Windows adapter.
//
// Background model: **on-demand start by the launcher**, with no permanent service. With no
// registered service there is no service manager to interpret the idle exit as a crash. A real SCM
// service host would require a compiled, validated native component, which is not shipped; anything
// depending on it is isolated in this file.
//
// The RemoteIFES *application* service, when it exists on Windows, is queried and controlled
// through `sc.exe`; when it does not, the Console says "not installed" instead of pretending it
// stopped something.
//
// WHY `sc.exe` AND NOT `Get-Service`: every PowerShell call pays for starting a process that loads
// the .NET engine (1 to 5 s on modest hardware). Readiness queries the service and the watchdog
// before **every** operation. `sc.exe` is a native binary that answers in milliseconds. PowerShell
// remains only where there is no native equivalent and the query is on demand (event log, listening
// ports, pending packages), never on the path taken before each operation.

const { ESTADO, recurso } = base;

const SERVICO_APP = process.env.CONSOLE_SERVICO_APP || "RemoteIFES";
const TAREFA = "RemoteIFES Console";

function powershell(script, { timeoutMs = 20_000 } = {}) {
  // -NoProfile evita herdar perfil do operador; -NonInteractive impede qualquer prompt.
  return processos.executar(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { timeoutMs }
  );
}

/**
 * `sc.exe` with the service name passed as an argument, never interpolated into a script.
 */
function sc(args, { timeoutMs = 15_000 } = {}) {
  return processos.executar("sc.exe", args, { timeoutMs });
}

// 1060 = ERROR_SERVICE_DOES_NOT_EXIST. This code distinguishes "not installed" from "stopped", and
// the message varies with the Windows language, so the decision uses the code.
const SERVICO_INEXISTENTE = /1060|does not exist as an installed service|não existe como serviço instalado/i;

function servicoNaoInstalado() {
  return recurso(
    ESTADO.NAO_INSTALADO,
    `o serviço "${SERVICO_APP}" não está registrado neste Windows. O RemoteIFES pode estar sendo executado ` +
      "manualmente (npm start); nesse caso o console observa a saúde pelo /health, mas não controla o ciclo de vida."
  );
}

/**
 * "KEY : value" pairs from `sc.exe` output, **in the order they appear**.
 *
 * The label is not a usable key: on Portuguese Windows `sc.exe` prints `ESTADO` instead of `STATE`
 * and `TIPO_DE_INÍCIO` instead of `START_TYPE`. Looking up the English name would report a running
 * service as stopped, and `start`/`stop` would wait out the deadline and fail.
 *
 * What is stable is the field **order**, fixed by `sc.exe`:
 *   query:    SERVICE_NAME, TYPE, STATE, WIN32_EXIT_CODE, SERVICE_EXIT_CODE, CHECKPOINT, ...
 *   qc:       ..., TYPE, START_TYPE, ERROR_CONTROL, BINARY_PATH_NAME, ...
 * and the value **format**: the state starts with its numeric code (1..7), the type with its own.
 */
function paresSc(texto) {
  const pares = [];
  for (const linha of String(texto).split(/\r?\n/)) {
    // The key may contain accents and underscores; the value is the rest of the line.
    const m = /^\s*([^\s:][^:]*?)\s*:\s*(.+?)\s*$/.exec(linha);
    if (m) pares.push({ chave: m[1].toUpperCase(), valor: m[2] });
  }
  return pares;
}

/**
 * Compatibility: label map, for callers that only need the English case.
 */
function camposSc(texto) {
  const campos = {};
  for (const par of paresSc(texto)) campos[par.chave] = par.valor;
  return campos;
}

/**
 * Service state code from `sc query`/`sc queryex`.
 *
 * Tries the English label; if absent (localized Windows), uses the position: the state is the third
 * pair, after SERVICE_NAME and TYPE. Also checks the value has the shape of a state (number 1 to 7
 * followed by a label), so it is not confused with the type.
 */
function codigoDeEstadoSc(texto) {
  const pares = paresSc(texto);
  const numeroDe = (valor) => {
    const m = /^(\d+)\b/.exec(String(valor || "").trim());
    return m ? Number(m[1]) : null;
  };

  const porRotulo = pares.find((p) => p.chave === "STATE");
  if (porRotulo) {
    const n = numeroDe(porRotulo.valor);
    if (n !== null) return n;
  }
  // Posicional: SERVICE_NAME(0), TYPE(1), ESTADO(2).
  if (pares.length >= 3) {
    const n = numeroDe(pares[2].valor);
    if (n !== null && n >= 1 && n <= 7) return n;
  }
  // Last resort: the first pair whose value looks like a state and is not the type.
  for (let i = 1; i < pares.length; i += 1) {
    const n = numeroDe(pares[i].valor);
    if (n !== null && n >= 1 && n <= 7 && /^[A-Z_ ]+$/.test(String(pares[i].valor).replace(/^\d+\s*/, "").trim())) {
      return n;
    }
  }
  return null;
}

/**
 * Textual state label, for display only; it may be localized, which is acceptable.
 */
function rotuloDeEstadoSc(texto) {
  const pares = paresSc(texto);
  const par = pares.find((p) => p.chave === "STATE") || pares[2];
  return par ? String(par.valor).replace(/^\d+\s*/, "").trim().toLowerCase() || null : null;
}

/**
 * Start type from `sc qc`. The value comes as "2   AUTO_START"; the number is stable (2 =
 * automatic, 3 = manual, 4 = disabled), the label is not.
 */
function inicioAutomaticoSc(texto) {
  const pares = paresSc(texto);
  const porRotulo = pares.find((p) => p.chave === "START_TYPE");
  const candidato = porRotulo || pares[2]; // qc: SERVICE_NAME(0), TYPE(1), START_TYPE(2)
  if (!candidato) return { automatico: false, rotulo: null };
  const m = /^(\d+)/.exec(String(candidato.valor).trim());
  const numero = m ? Number(m[1]) : null;
  const rotulo = String(candidato.valor).replace(/^\d+\s*/, "").trim() || null;
  return { automatico: numero === 2 || /AUTO_START/i.test(rotulo || ""), rotulo };
}

async function estadoDoServico() {
  const consulta = await sc(["query", SERVICO_APP]);
  if (SERVICO_INEXISTENTE.test(consulta.saida || consulta.erro || "")) return servicoNaoInstalado();
  if (!consulta.ok) {
    return recurso(ESTADO.INDISPONIVEL, (consulta.saida || consulta.erro || "não foi possível consultar o gerenciador de serviços").slice(0, 300));
  }

  // "ESTADO : 4  RUNNING" on pt-BR, "STATE : 4  RUNNING" on en-US: the number is stable, the label
  // is not. 4 = SERVICE_RUNNING.
  const codigoEstado = codigoDeEstadoSc(consulta.saida);
  const ativo = codigoEstado === 4;

  // Start type and PID come from separate, cheap calls; neither is required for the essential
  // answer, so a failure there does not break the whole query.
  const [configuracao, detalhe] = await Promise.all([sc(["qc", SERVICO_APP]), sc(["queryex", SERVICO_APP])]);
  const inicio = configuracao.ok ? inicioAutomaticoSc(configuracao.saida) : { automatico: false, rotulo: null };
  // PID: the label is the same in every language, so the key map suffices here.
  const camposDetalhe = detalhe.ok ? camposSc(detalhe.saida) : {};

  return {
    ...recurso(ESTADO.SUPORTADO),
    ativo,
    habilitado: inicio.automatico,
    estadoAtivo: ativo ? "active" : "inactive",
    subEstado: rotuloDeEstadoSc(consulta.saida),
    arquivoUnidade: inicio.rotulo,
    pid: config.inteiro(camposDetalhe.PID, null, 1, 1e9),
    memoriaBytes: null,
    reinicios: null,
    desde: null,
    resultadoUltimaExecucao: null,
  };
}

async function controlarServico(acao) {
  if (!["iniciar", "parar", "reiniciar"].includes(acao)) {
    return recurso(ESTADO.NAO_SUPORTADO, `ação de serviço desconhecida: ${acao}`);
  }

  const existe = await estadoDoServico();
  if (existe.estado === ESTADO.NAO_INSTALADO) return existe;

  // `sc stop`/`sc start` return as soon as the SCM accepts the request, not when it finishes. A
  // restart must wait for the actual stop, otherwise start fails with "service is already being
  // stopped" and the Console would report success over a service that did not start.
  const negado = (r) => /Access is denied|Acesso negado|5:/i.test(r.saida || r.erro || "");

  if (acao === "parar" || acao === "reiniciar") {
    const parada = await sc(["stop", SERVICO_APP], { timeoutMs: 30_000 });
    // 1062 = the service has not been started; stopping something already stopped is not a failure.
    const jaParado = /1062/.test(parada.saida || parada.erro || "");
    if (!parada.ok && !jaParado) {
      if (negado(parada)) return recurso(ESTADO.SEM_PERMISSAO, "controlar este serviço exige executar o console como Administrador");
      return recurso(ESTADO.INDISPONIVEL, (parada.saida || parada.erro || "").slice(0, 400));
    }
    const parou = await esperarEstado(1, 60_000);
    if (!parou) return recurso(ESTADO.INDISPONIVEL, `o serviço "${SERVICO_APP}" não chegou a parar dentro do prazo`);
  }

  if (acao === "iniciar" || acao === "reiniciar") {
    const partida = await sc(["start", SERVICO_APP], { timeoutMs: 30_000 });
    const jaRodando = /1056/.test(partida.saida || partida.erro || "");
    if (!partida.ok && !jaRodando) {
      if (negado(partida)) return recurso(ESTADO.SEM_PERMISSAO, "controlar este serviço exige executar o console como Administrador");
      return recurso(ESTADO.INDISPONIVEL, (partida.saida || partida.erro || "").slice(0, 400));
    }
    const subiu = await esperarEstado(4, 60_000);
    if (!subiu) return recurso(ESTADO.INDISPONIVEL, `o serviço "${SERVICO_APP}" não chegou a rodar dentro do prazo`);
  }

  return recurso(ESTADO.SUPORTADO);
}

/**
 * Waits for the SCM to reach a state. This is not a blind retry hiding instability: `sc` is
 * asynchronous by contract, and confirming the transition separates "the request was accepted" from
 * "the service is in the requested state".
 */
async function esperarEstado(codigoDesejado, prazoMs) {
  const limite = Date.now() + prazoMs;
  for (;;) {
    const r = await sc(["query", SERVICO_APP]);
    if (codigoDeEstadoSc(r.saida) === codigoDesejado) return true;
    if (Date.now() >= limite) return false;
    await new Promise((resolver) => setTimeout(resolver, 500));
  }
}

async function lerRegistros({ unidade = "aplicacao", linhas = 200 } = {}) {
  const n = Math.max(10, Math.min(Number(linhas) || 200, 2000));
  // Windows has no per-unit journal; the closest is the Application log filtered by the service
  // source. When nothing was logged, that is stated instead of returning empty.
  const fontes = {
    aplicacao: SERVICO_APP,
    console: "RemoteIFES-Console",
    saude: SERVICO_APP,
    recuperacao: SERVICO_APP,
  };
  const fonte = fontes[unidade];
  if (!fonte) return recurso(ESTADO.NAO_SUPORTADO, "unidade de log não permitida");

  // The source is checked BEFORE filtering the log.
  //
  // `Get-WinEvent -FilterHashtable @{ProviderName='X'}` with a source that never logged anything
  // does not return quickly: it scans the whole Application log before concluding there is no
  // match. On a host where RemoteIFES runs manually (the common case, and CI) that exceeded the
  // read deadline. `-ListProvider` answers immediately.
  const r = await powershell(
    `$ErrorActionPreference='SilentlyContinue';` +
      `if ($null -eq (Get-WinEvent -ListProvider '${fonte}' -ErrorAction SilentlyContinue)) { 'SEMPROVEDOR' } else {` +
      `$e = Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='${fonte}'} -MaxEvents ${n};` +
      `if ($null -eq $e) { 'SEMEVENTOS' } else { $e | Sort-Object TimeCreated | ` +
      `ForEach-Object { "{0:yyyy-MM-ddTHH:mm:ss} [{1}] {2}" -f $_.TimeCreated, $_.LevelDisplayName, $_.Message } } }`,
    { timeoutMs: 30_000, limiteBytes: 512 * 1024 }
  );
  if (!r.ok) {
    const prazo = r.expirou ? " (a consulta passou do prazo)" : "";
    return recurso(ESTADO.INDISPONIVEL, `${r.erro || "não foi possível ler o log de eventos"}${prazo}`);
  }
  if (r.saida.includes("SEMPROVEDOR")) {
    return {
      ...recurso(ESTADO.NAO_INSTALADO),
      texto: "",
      fonte: "Log de Aplicativo do Windows",
      observacao:
        `A origem "${fonte}" não está registrada no log de eventos deste Windows. Isso é o esperado quando o ` +
        "RemoteIFES é iniciado manualmente: ele escreve no console que o iniciou, não no log do sistema.",
    };
  }
  if (r.saida.includes("SEMEVENTOS")) {
    return {
      ...recurso(ESTADO.SUPORTADO),
      texto: "",
      fonte: "Log de Aplicativo do Windows",
      observacao: `A origem "${fonte}" está registrada, mas ainda não gravou nenhum evento.`,
    };
  }
  return { ...recurso(ESTADO.SUPORTADO), texto: r.saida, fonte: "Log de Aplicativo do Windows" };
}

async function estadoDoWatchdog() {
  return recurso(
    ESTADO.NAO_APLICAVEL,
    "o watchdog de saúde é um timer systemd e não existe no Windows. A supervisão aqui é do próprio gerenciador de serviços."
  );
}

async function controlarWatchdog() {
  return estadoDoWatchdog();
}

async function reiniciarHost() {
  const r = await powershell("Restart-Computer -Force", { timeoutMs: 20_000 });
  if (r.ok) return recurso(ESTADO.SUPORTADO);
  if (/Access is denied|Acesso negado/i.test(r.saida || "")) {
    return recurso(ESTADO.SEM_PERMISSAO, "reiniciar o host exige executar o console como Administrador");
  }
  return recurso(ESTADO.INDISPONIVEL, (r.saida || r.erro || "").slice(0, 300));
}

async function reiniciarConsole() {
  // Without a permanent service there is nothing to restart: the Console exits and the launcher
  // reopens it.
  return recurso(
    ESTADO.NAO_APLICAVEL,
    "no Windows o console é iniciado sob demanda pelo lançador; encerrá-lo basta, e a próxima abertura sobe a versão nova."
  );
}

async function relogio() {
  const comum = { agora: new Date().toISOString(), fusoNode: Intl.DateTimeFormat().resolvedOptions().timeZone };
  const r = await processos.executar("w32tm.exe", ["/query", "/status"], { timeoutMs: 15_000 });
  if (!r.ok) return { ...comum, sincronizado: null, suportado: false, motivo: "w32tm indisponível" };
  return {
    ...comum,
    suportado: true,
    sincronizado: /Source:/i.test(r.saida) && !/not synchronized|não sincronizado/i.test(r.saida),
    fusoHorario: comum.fusoNode,
  };
}

async function portasEmEscuta() {
  const r = await powershell(
    `Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ` +
      `Select-Object -First 40 LocalAddress,LocalPort,OwningProcess | ` +
      `ForEach-Object { "{0}:{1}  pid={2}" -f $_.LocalAddress, $_.LocalPort, $_.OwningProcess }`,
    { timeoutMs: 20_000 }
  );
  if (!r.ok) return recurso(ESTADO.INDISPONIVEL, r.erro || "Get-NetTCPConnection indisponível");
  return { ...recurso(ESTADO.SUPORTADO), comProcesso: true, linhas: r.saida.split("\n").filter(Boolean).slice(0, 40) };
}

async function pacotesPendentes() {
  return recurso(ESTADO.NAO_APLICAVEL, "o Windows Update não é consultado pelo console; atualizações do sistema seguem a política do host");
}

/**
 * Ends the process tree. Windows has no POSIX process group, so killing the parent PID would leave
 * grandchildren alive; hence `taskkill /T`.
 */
function encerrarArvore(pid, sinal) {
  if (!pid) return;
  try {
    const args = ["/PID", String(pid), "/T"];
    if (sinal === "SIGKILL") args.push("/F");
    require("child_process").execFileSync("taskkill.exe", args, { stdio: "ignore", timeout: 15_000 });
  } catch {
    try {
      process.kill(pid, sinal);
    } catch {}
  }
}

function opcoesDeGrupo() {
  // `detached` on Windows creates a new console group; combined with taskkill /T it allows ending
  // the whole tree.
  return { detached: true, windowsHide: true };
}

async function abrirNavegador(url) {
  // cmd's `start` resolves the user's default browser. The empty first argument is the window
  // title:
  // without it, a quoted URL would become the title and nothing would open.
  const r = await processos.executar("cmd.exe", ["/d", "/s", "/c", "start", "", url], { timeoutMs: 15_000 });
  return r.ok ? { ...recurso(ESTADO.SUPORTADO), url } : recurso(ESTADO.INDISPONIVEL, r.erro || "não foi possível abrir o navegador", { url });
}

/**
 * File protection by ACL. `chmod` on Windows only toggles the read-only bit and restricts nobody:
 * claiming protection through a POSIX mode here would be false.
 */
function protegerArquivo(caminho, { diretorio = false } = {}) {
  const usuario = process.env.USERNAME ? `${process.env.USERDOMAIN || os.hostname()}\\${process.env.USERNAME}` : null;
  if (!usuario) return recurso(ESTADO.INDISPONIVEL, "não foi possível identificar o usuário atual para aplicar a ACL");
  try {
    const { execFileSync } = require("child_process");
    // (OI)(CI) are **inheritance** flags, meaningful only on directories. Applied to a file they
    // produce an ineffective ACE and the file ends up with no permission at all, even for its
    // owner, who then gets EPERM reading it.
    const heranca = diretorio ? "(OI)(CI)" : "";
    const args = [
      caminho,
      "/inheritance:r",
      "/grant:r",
      `${usuario}:${heranca}F`,
      "/grant:r",
      `*S-1-5-18:${heranca}F`,
      "/grant:r",
      `*S-1-5-32-544:${heranca}F`,
    ];
    execFileSync("icacls.exe", args, { stdio: "ignore", timeout: 30_000 });
    if (diretorio) {
      // `/T` is NOT used with the grant above: `/T` would propagate the same ACE, with
      // directory-only inheritance flags, to existing files inside, leaving them with no permission
      // at all, even for the owner (EPERM on read). Children inherit from the freshly configured
      // directory instead.
      execFileSync("icacls.exe", [caminho, "/reset", "/T", "/C", "/Q"], { stdio: "ignore", timeout: 60_000 });
    }
    return { ...recurso(ESTADO.SUPORTADO), mecanismo: "icacls" };
  } catch (erro) {
    return recurso(ESTADO.INDISPONIVEL, `icacls falhou: ${erro.message}`);
  }
}

function permissaoRestrita(caminho) {
  try {
    const { execFileSync } = require("child_process");
    const saida = execFileSync("icacls.exe", [caminho], { encoding: "utf8", timeout: 20_000 });
    // Any grant to Everyone/Todos/Users defeats the restriction.
    const aberto = /(Everyone|Todos|BUILTIN\\Users|BUILTIN\\Usuários):\([^)]*\)[FMW]/i.test(saida) || /Everyone:\(/i.test(saida);
    return { restrito: !aberto, verificavel: true, mecanismo: "icacls" };
  } catch (erro) {
    return { restrito: null, verificavel: false, motivo: erro.message };
  }
}

function diretoriosPadrao({ escopo = "usuario" } = {}) {
  const programData = process.env.ProgramData || "C:\\ProgramData";
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  if (escopo === "sistema") {
    return {
      escopo: "sistema",
      raizInstalacao: path.join(programFiles, "RemoteIFES Console"),
      estado: path.join(programData, "RemoteIFES Console"),
      logs: path.join(programData, "RemoteIFES Console", "logs"),
      cache: path.join(programData, "RemoteIFES Console", "cache"),
      atalhos: path.join(programData, "Microsoft", "Windows", "Start Menu", "Programs"),
    };
  }
  return {
    escopo: "usuario",
    raizInstalacao: path.join(localAppData, "Programs", "RemoteIFES Console"),
    estado: path.join(appData, "RemoteIFES Console"),
    logs: path.join(appData, "RemoteIFES Console", "logs"),
    cache: path.join(localAppData, "RemoteIFES Console", "cache"),
    atalhos: path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs"),
  };
}

async function registrarInicializacao({ comando, argumentos = [], escopo = "usuario" } = {}) {
  if (!comando) return recurso(ESTADO.NAO_SUPORTADO, "comando de inicialização ausente");
  // Scheduled task instead of a service: the Console is on demand and does not need to stay
  // resident.
  //
  // `schtasks.exe` is called directly, each argument in place. The target is a path with a space
  // ("...\RemoteIFES Console\console-bootstrap.js"), and double quoting through a PowerShell script
  // is where this kind of command breaks silently and registers a task that does not run.
  // `argumentos` must be passed, otherwise the task starts `node.exe` with no script.
  const alvo = [comando, ...argumentos].map((parte) => `"${parte}"`).join(" ");
  const args = ["/Create", "/F", "/TN", TAREFA, "/TR", alvo, "/SC", "ONLOGON"];
  if (escopo === "sistema") args.push("/RU", "SYSTEM");

  const r = await processos.executar("schtasks.exe", args, { timeoutMs: 30_000 });
  if (r.ok) return { ...recurso(ESTADO.SUPORTADO), mecanismo: "Tarefa agendada (ONLOGON)", alvo };
  if (/Access is denied|Acesso negado/i.test(r.saida || r.erro || "")) {
    return recurso(ESTADO.SEM_PERMISSAO, "criar a tarefa neste escopo exige Administrador");
  }
  return recurso(ESTADO.INDISPONIVEL, (r.saida || r.erro || "").slice(0, 300));
}

async function removerInicializacao() {
  const r = await processos.executar("schtasks.exe", ["/Delete", "/F", "/TN", TAREFA], { timeoutMs: 20_000 });
  // Deleting a task that does not exist is not a failure: the requested result is already the
  // current state.
  if (!r.ok && /cannot find|não foi possível encontrar|does not exist/i.test(r.saida || r.erro || "")) {
    return { ...recurso(ESTADO.SUPORTADO), mecanismo: "não havia tarefa agendada registrada" };
  }
  return r.ok
    ? { ...recurso(ESTADO.SUPORTADO), mecanismo: "tarefa agendada removida" }
    : recurso(ESTADO.INDISPONIVEL, (r.saida || r.erro || "").slice(0, 300));
}

async function estadoDaInicializacao() {
  const r = await processos.executar("schtasks.exe", ["/Query", "/TN", TAREFA, "/FO", "LIST"], { timeoutMs: 20_000 });
  if (!r.ok) return { ...recurso(ESTADO.SUPORTADO), habilitado: false, mecanismo: "Tarefa agendada (ONLOGON)" };
  return { ...recurso(ESTADO.SUPORTADO), habilitado: true, mecanismo: "Tarefa agendada (ONLOGON)" };
}

module.exports = {
  ...base,
  nome: "windows",
  rotulo: "Windows",
  servicoDaAplicacao: SERVICO_APP,
  estadoDoServico,
  controlarServico,
  estadoDoWatchdog,
  controlarWatchdog,
  lerRegistros,
  reiniciarHost,
  reiniciarConsole,
  relogio,
  portasEmEscuta,
  pacotesPendentes,
  encerrarArvore,
  opcoesDeGrupo,
  abrirNavegador,
  protegerArquivo,
  permissaoRestrita,
  diretoriosPadrao,
  registrarInicializacao,
  removerInicializacao,
  estadoDaInicializacao,
  codigoDeEstadoSc,
  inicioAutomaticoSc,
};

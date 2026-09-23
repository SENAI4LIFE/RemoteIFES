const fs = require("fs");
const os = require("os");
const path = require("path");
const base = require("./base");
const config = require("../config");
const processos = require("../processos");

// Adaptador Windows.
//
// Modelo de segundo plano: **partida sob demanda pelo lançador**, sem serviço permanente.
// Isso não é paridade capenga com o systemd, é a escolha mais leve: como não existe serviço
// registrado, não há gerenciador de serviços para interpretar a saída por ociosidade como
// queda — o problema deixa de existir em vez de ser contornado. Um host de serviço SCM de
// verdade exigiria componente nativo compilado e validado, que não é entregue aqui; tudo que
// dependeria dele está isolado neste arquivo.
//
// O serviço *da aplicação* RemoteIFES, quando existe no Windows, é controlado por `sc.exe`
// consultado com `Get-Service`; quando não existe, o console diz "não instalado" em vez de
// fingir que parou alguma coisa.

const { ESTADO, recurso } = base;

const SERVICO_APP = process.env.CONSOLE_SERVICO_APP || "RemoteIFES";

function powershell(script, { timeoutMs = 20_000 } = {}) {
  // -NoProfile evita herdar perfil do operador; -NonInteractive impede qualquer prompt.
  return processos.executar(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { timeoutMs }
  );
}

async function estadoDoServico() {
  const r = await powershell(
    `$ErrorActionPreference='SilentlyContinue';` +
      `$s = Get-Service -Name '${SERVICO_APP}';` +
      `if ($null -eq $s) { 'NAOINSTALADO' } else { ` +
      `$p = Get-CimInstance Win32_Service -Filter "Name='${SERVICO_APP}'";` +
      `"Status=$($s.Status)"; "StartType=$($s.StartType)"; "ProcessId=$($p.ProcessId)"; "State=$($p.State)" }`
  );
  if (!r.ok) return recurso(ESTADO.INDISPONIVEL, r.erro || "não foi possível consultar o gerenciador de serviços");
  if (r.saida.includes("NAOINSTALADO")) {
    return recurso(
      ESTADO.NAO_INSTALADO,
      `o serviço "${SERVICO_APP}" não está registrado neste Windows. O RemoteIFES pode estar sendo executado ` +
        "manualmente (npm start); nesse caso o console observa a saúde pelo /health, mas não controla o ciclo de vida."
    );
  }
  const campos = {};
  for (const linha of r.saida.split("\n")) {
    const idx = linha.indexOf("=");
    if (idx > 0) campos[linha.slice(0, idx).trim()] = linha.slice(idx + 1).trim();
  }
  const ativo = campos.Status === "Running";
  return {
    ...recurso(ESTADO.SUPORTADO),
    ativo,
    habilitado: campos.StartType === "Automatic",
    estadoAtivo: ativo ? "active" : "inactive",
    subEstado: (campos.Status || "").toLowerCase(),
    arquivoUnidade: campos.StartType || null,
    pid: config.inteiro(campos.ProcessId, null, 0, 1e9),
    memoriaBytes: null,
    reinicios: null,
    desde: null,
    resultadoUltimaExecucao: null,
  };
}

async function controlarServico(acao) {
  const comandos = {
    iniciar: `Start-Service -Name '${SERVICO_APP}' -ErrorAction Stop`,
    parar: `Stop-Service -Name '${SERVICO_APP}' -Force -ErrorAction Stop`,
    reiniciar: `Restart-Service -Name '${SERVICO_APP}' -Force -ErrorAction Stop`,
  };
  if (!comandos[acao]) return recurso(ESTADO.NAO_SUPORTADO, `ação de serviço desconhecida: ${acao}`);

  const existe = await estadoDoServico();
  if (existe.estado === ESTADO.NAO_INSTALADO) return existe;

  const r = await powershell(comandos[acao], { timeoutMs: 90_000 });
  if (r.ok) return recurso(ESTADO.SUPORTADO);
  // Acesso negado é diferente de falha: o operador precisa saber que falta elevação.
  if (/Access is denied|Acesso negado|PermissionDenied/i.test(r.saida || "")) {
    return recurso(ESTADO.SEM_PERMISSAO, "controlar este serviço exige executar o console como Administrador");
  }
  return recurso(ESTADO.INDISPONIVEL, (r.saida || r.erro || "").slice(0, 400));
}

async function lerRegistros({ unidade = "aplicacao", linhas = 200 } = {}) {
  const n = Math.max(10, Math.min(Number(linhas) || 200, 2000));
  // O Windows não tem journal por unidade; o mais próximo é o log de Aplicativo filtrado pela
  // origem do serviço. Quando não há nada registrado, dizemos isso em vez de devolver vazio.
  const fontes = {
    aplicacao: SERVICO_APP,
    console: "RemoteIFES-Console",
    saude: SERVICO_APP,
    recuperacao: SERVICO_APP,
  };
  const fonte = fontes[unidade];
  if (!fonte) return recurso(ESTADO.NAO_SUPORTADO, "unidade de log não permitida");

  const r = await powershell(
    `$ErrorActionPreference='SilentlyContinue';` +
      `$e = Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='${fonte}'} -MaxEvents ${n};` +
      `if ($null -eq $e) { 'SEMEVENTOS' } else { $e | Sort-Object TimeCreated | ` +
      `ForEach-Object { "{0:yyyy-MM-ddTHH:mm:ss} [{1}] {2}" -f $_.TimeCreated, $_.LevelDisplayName, $_.Message } }`,
    { timeoutMs: 30_000, limiteBytes: 512 * 1024 }
  );
  if (!r.ok) return recurso(ESTADO.INDISPONIVEL, r.erro || "não foi possível ler o log de eventos");
  if (r.saida.includes("SEMEVENTOS")) {
    return {
      ...recurso(ESTADO.SUPORTADO),
      texto: "",
      fonte: "Log de Aplicativo do Windows",
      observacao: `Nenhum evento registrado pela origem "${fonte}". Um RemoteIFES iniciado manualmente escreve no console, não no log de eventos.`,
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
  // Sem serviço permanente não há o que reiniciar: o console sai e o lançador o reabre.
  return recurso(
    ESTADO.NAO_APLICAVEL,
    "no Windows o console é iniciado sob demanda pelo lançador; encerrá-lo basta, e a próxima abertura sobe a versão nova."
  );
}

async function disco(caminhos) {
  const saida = [];
  for (const caminho of caminhos) {
    const raiz = path.parse(path.resolve(caminho)).root.replace(/\\$/, "");
    const r = await powershell(
      `$ErrorActionPreference='SilentlyContinue';` +
        `$d = Get-PSDrive -Name '${raiz.replace(":", "")}' ;` +
        `if ($null -eq $d) { 'SEMDISCO' } else { "Used=$($d.Used)"; "Free=$($d.Free)" }`,
      { timeoutMs: 15_000 }
    );
    if (!r.ok || r.saida.includes("SEMDISCO")) {
      saida.push({ caminho, suportado: false, motivo: "não foi possível medir esta unidade" });
      continue;
    }
    const campos = {};
    for (const linha of r.saida.split("\n")) {
      const idx = linha.indexOf("=");
      if (idx > 0) campos[linha.slice(0, idx).trim()] = linha.slice(idx + 1).trim();
    }
    const usado = Number(campos.Used);
    const livre = Number(campos.Free);
    if (!Number.isFinite(usado) || !Number.isFinite(livre)) {
      saida.push({ caminho, suportado: false, motivo: "resposta inesperada" });
      continue;
    }
    const total = usado + livre;
    saida.push({
      caminho,
      suportado: true,
      dispositivo: raiz,
      totalBytes: total,
      usadoBytes: usado,
      livreBytes: livre,
      usoPercentual: total > 0 ? Math.round((usado / total) * 100) : null,
      montagem: raiz,
    });
  }
  return saida;
}

async function relogio() {
  const comum = { agora: new Date().toISOString(), fusoNode: Intl.DateTimeFormat().resolvedOptions().timeZone };
  const r = await powershell("w32tm /query /status", { timeoutMs: 15_000 });
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
 * Encerra a árvore de processos. O Windows não tem grupo de processos POSIX, então matar o PID
 * pai deixaria netos vivos — daí `taskkill /T`.
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
  // `detached` no Windows cria um novo grupo de console; combinado com taskkill /T, é o que
  // permite encerrar a árvore inteira.
  return { detached: true, windowsHide: true };
}

async function abrirNavegador(url) {
  // `start` do cmd resolve o navegador padrão do usuário. O primeiro argumento vazio é o
  // título da janela: sem ele, uma URL entre aspas viraria título e nada abriria.
  const r = await processos.executar("cmd.exe", ["/d", "/s", "/c", "start", "", url], { timeoutMs: 15_000 });
  return r.ok ? { ...recurso(ESTADO.SUPORTADO), url } : recurso(ESTADO.INDISPONIVEL, r.erro || "não foi possível abrir o navegador", { url });
}

/**
 * Proteção de arquivo por ACL. `chmod` no Windows só mexe no bit de somente-leitura e não
 * restringe ninguém: afirmar proteção com modo POSIX aqui seria falso.
 */
function protegerArquivo(caminho, { diretorio = false } = {}) {
  const usuario = process.env.USERNAME ? `${process.env.USERDOMAIN || os.hostname()}\\${process.env.USERNAME}` : null;
  if (!usuario) return recurso(ESTADO.INDISPONIVEL, "não foi possível identificar o usuário atual para aplicar a ACL");
  try {
    const { execFileSync } = require("child_process");
    // (OI)(CI) são flags de **herança**, que só fazem sentido em diretório. Aplicá-las a um
    // arquivo produz uma ACE sem efeito e o arquivo fica sem permissão nenhuma — inclusive
    // para o próprio dono, que passa a receber EPERM ao lê-lo.
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
      // NÃO se usa `/T` junto com a concessão acima: `/T` propagaria a mesma ACE — com flags
      // de herança, que só valem para diretório — para os arquivos já existentes dentro, e
      // eles ficariam sem permissão alguma, inclusive para o dono (EPERM ao ler).
      // O certo é deixar os filhos herdarem do diretório recém-configurado.
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
    // Qualquer concessão a Everyone/Todos/Users derruba a restrição.
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

async function registrarInicializacao({ comando, escopo = "usuario" } = {}) {
  if (!comando) return recurso(ESTADO.NAO_SUPORTADO, "comando de inicialização ausente");
  // Tarefa agendada em vez de serviço: o console é sob demanda e não precisa residir.
  const escopoTarefa = escopo === "sistema" ? "/RU SYSTEM" : "";
  const r = await powershell(
    `schtasks.exe /Create /F /TN "RemoteIFES Console" /TR "${comando.replace(/"/g, '\\"')}" /SC ONLOGON ${escopoTarefa}`,
    { timeoutMs: 30_000 }
  );
  if (r.ok) return { ...recurso(ESTADO.SUPORTADO), mecanismo: "Tarefa agendada (ONLOGON)" };
  if (/Access is denied|Acesso negado/i.test(r.saida || "")) {
    return recurso(ESTADO.SEM_PERMISSAO, "criar a tarefa neste escopo exige Administrador");
  }
  return recurso(ESTADO.INDISPONIVEL, (r.saida || r.erro || "").slice(0, 300));
}

async function removerInicializacao() {
  const r = await powershell(`schtasks.exe /Delete /F /TN "RemoteIFES Console"`, { timeoutMs: 20_000 });
  return r.ok ? recurso(ESTADO.SUPORTADO) : recurso(ESTADO.INDISPONIVEL, (r.saida || r.erro || "").slice(0, 300));
}

async function estadoDaInicializacao() {
  const r = await powershell(`schtasks.exe /Query /TN "RemoteIFES Console" /FO LIST`, { timeoutMs: 20_000 });
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
  disco,
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
};

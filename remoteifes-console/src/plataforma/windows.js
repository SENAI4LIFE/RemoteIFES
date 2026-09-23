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
// O serviço *da aplicação* RemoteIFES, quando existe no Windows, é consultado e controlado por
// `sc.exe`; quando não existe, o console diz "não instalado" em vez de fingir que parou alguma
// coisa.
//
// POR QUE `sc.exe` E NÃO `Get-Service`: cada chamada de PowerShell paga a partida de um
// processo que carrega o motor .NET — algo entre 1 e 5 s numa máquina modesta. A avaliação de
// prontidão consulta serviço e watchdog antes de **toda** operação, e com PowerShell isso
// passou de 15 s num runner de dois núcleos: o operador esperaria esse tempo só para ver a tela
// de confirmação. `sc.exe` é um binário nativo que responde em milissegundos. O PowerShell
// continua apenas onde não há equivalente nativo e a consulta é sob demanda (log de eventos,
// portas em escuta, pacotes pendentes), nunca no caminho percorrido antes de cada operação.

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

/** `sc.exe` com o nome do serviço passado como argumento, nunca interpolado num script. */
function sc(args, { timeoutMs = 15_000 } = {}) {
  return processos.executar("sc.exe", args, { timeoutMs });
}

// 1060 = ERROR_SERVICE_DOES_NOT_EXIST. É o código que distingue "não instalado" de "parado",
// e a mensagem varia com o idioma do Windows — por isso a decisão é pelo código.
const SERVICO_INEXISTENTE = /1060|does not exist as an installed service|não existe como serviço instalado/i;

function servicoNaoInstalado() {
  return recurso(
    ESTADO.NAO_INSTALADO,
    `o serviço "${SERVICO_APP}" não está registrado neste Windows. O RemoteIFES pode estar sendo executado ` +
      "manualmente (npm start); nesse caso o console observa a saúde pelo /health, mas não controla o ciclo de vida."
  );
}

/** Campos "CHAVE : valor" da saída de `sc query`/`sc qc`, tolerante a idioma e espaçamento. */
function camposSc(texto) {
  const campos = {};
  for (const linha of String(texto).split(/\r?\n/)) {
    const m = /^\s*([A-Z_]+)\s*:\s*(.+?)\s*$/.exec(linha);
    if (m) campos[m[1]] = m[2];
  }
  return campos;
}

async function estadoDoServico() {
  const consulta = await sc(["query", SERVICO_APP]);
  if (SERVICO_INEXISTENTE.test(consulta.saida || consulta.erro || "")) return servicoNaoInstalado();
  if (!consulta.ok) {
    return recurso(ESTADO.INDISPONIVEL, (consulta.saida || consulta.erro || "não foi possível consultar o gerenciador de serviços").slice(0, 300));
  }

  const campos = camposSc(consulta.saida);
  // "STATE : 4  RUNNING" — o número é estável entre idiomas, o rótulo não.
  const codigoEstado = config.inteiro((campos.STATE || "").trim().split(/\s+/)[0], null, 0, 10);
  const ativo = codigoEstado === 4;

  // Tipo de início e PID vêm de chamadas separadas e baratas; nenhuma é obrigatória para
  // responder o essencial, então uma falha ali não derruba a consulta inteira.
  const [configuracao, detalhe] = await Promise.all([sc(["qc", SERVICO_APP]), sc(["queryex", SERVICO_APP])]);
  const camposConfig = configuracao.ok ? camposSc(configuracao.saida) : {};
  const camposDetalhe = detalhe.ok ? camposSc(detalhe.saida) : {};
  const inicio = camposConfig.START_TYPE || "";

  return {
    ...recurso(ESTADO.SUPORTADO),
    ativo,
    habilitado: /AUTO_START/i.test(inicio),
    estadoAtivo: ativo ? "active" : "inactive",
    subEstado: (campos.STATE || "").replace(/^\d+\s+/, "").toLowerCase() || null,
    arquivoUnidade: inicio.replace(/^\d+\s+/, "") || null,
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

  // `sc stop`/`sc start` retornam assim que o SCM aceita o pedido, não quando ele termina.
  // Para reiniciar é preciso esperar a parada de fato, senão o start falha com "serviço já
  // está sendo parado" — e o console teria relatado sucesso sobre um serviço que não subiu.
  const negado = (r) => /Access is denied|Acesso negado|5:/i.test(r.saida || r.erro || "");

  if (acao === "parar" || acao === "reiniciar") {
    const parada = await sc(["stop", SERVICO_APP], { timeoutMs: 30_000 });
    // 1062 = o serviço não foi iniciado; parar algo já parado não é falha.
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
 * Espera o SCM chegar a um estado. Não é retentativa cega para esconder instabilidade: `sc` é
 * assíncrono por contrato, e confirmar a transição é o que separa "o pedido foi aceito" de "o
 * serviço está no estado pedido" — a diferença entre relatar sucesso e ter sucesso.
 */
async function esperarEstado(codigoDesejado, prazoMs) {
  const limite = Date.now() + prazoMs;
  for (;;) {
    const r = await sc(["query", SERVICO_APP]);
    const codigo = config.inteiro((camposSc(r.saida).STATE || "").trim().split(/\s+/)[0], null, 0, 10);
    if (codigo === codigoDesejado) return true;
    if (Date.now() >= limite) return false;
    await new Promise((resolver) => setTimeout(resolver, 500));
  }
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

async function registrarInicializacao({ comando, argumentos = [], escopo = "usuario" } = {}) {
  if (!comando) return recurso(ESTADO.NAO_SUPORTADO, "comando de inicialização ausente");
  // Tarefa agendada em vez de serviço: o console é sob demanda e não precisa residir.
  //
  // `schtasks.exe` é chamado direto, com cada argumento no seu lugar. Passando por um script de
  // PowerShell era preciso escapar aspas na mão, e o alvo é justamente um caminho com espaço
  // ("...\RemoteIFES Console\console-bootstrap.js"): a citação dupla — a do PowerShell e a do
  // schtasks — é onde esse tipo de comando quebra em silêncio e registra uma tarefa que não roda.
  //
  // Os `argumentos` também eram descartados aqui, então a tarefa chamava `node.exe` sem script
  // nenhum: ela era criada com sucesso e não abria coisa alguma.
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
  // Apagar uma tarefa que não existe não é falha: o resultado pedido já é o estado atual.
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
};

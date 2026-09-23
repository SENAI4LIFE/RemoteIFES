const fs = require("fs");
const os = require("os");
const path = require("path");
const base = require("./base");
const config = require("../config");
const processos = require("../processos");

// Adaptador macOS.
//
// Ativação: **LaunchAgent por usuário**, acionado sob demanda pelo lançador, com
// `RunAtLoad=false`. A ativação por socket do launchd existe, mas a semântica de herança de
// descritor é diferente da do systemd (o launchd entrega o socket por `launch_activate_socket`,
// uma API C, não como `LISTEN_FDS`) e exigiria um componente nativo. Como o console já sai por
// ociosidade, partida sob demanda dá o mesmo custo ocioso zero sem código nativo.
//
// Escopo: LaunchAgent (por usuário, sessão gráfica) é o padrão. LaunchDaemon (máquina inteira,
// root) é deliberadamente **não** usado: o console não precisa rodar como root, e um daemon
// root acionado por um lançador de usuário seria elevação de privilégio disfarçada.

const { ESTADO, recurso } = base;

const ROTULO_AGENTE = "br.edu.ifes.remoteifes.console";
const SERVICO_APP = process.env.CONSOLE_SERVICO_APP || "br.edu.ifes.remoteifes.servidor";

function caminhoAgente(rotulo = ROTULO_AGENTE) {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${rotulo}.plist`);
}

async function launchctl(args, { timeoutMs = 20_000 } = {}) {
  return processos.executar("launchctl", args, { timeoutMs });
}

function uidAtual() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

async function estadoDoServico() {
  const uid = uidAtual();
  if (uid === null) return recurso(ESTADO.INDISPONIVEL, "não foi possível determinar o uid atual");

  // `launchctl print` distingue com precisão "não carregado" de "carregado e parado".
  const r = await launchctl(["print", `gui/${uid}/${SERVICO_APP}`]);
  if (!r.ok) {
    const sistema = await launchctl(["print", `system/${SERVICO_APP}`]);
    if (!sistema.ok) {
      return recurso(
        ESTADO.NAO_INSTALADO,
        `nenhum serviço launchd "${SERVICO_APP}" está carregado. O RemoteIFES pode estar sendo executado manualmente ` +
          "(npm start); nesse caso o console observa a saúde pelo /health, mas não controla o ciclo de vida."
      );
    }
    return interpretarPrint(sistema.saida, "system");
  }
  return interpretarPrint(r.saida, "gui");
}

function interpretarPrint(texto, dominio) {
  const pid = /\bpid = (\d+)/.exec(texto);
  const estado = /\bstate = (\w+)/.exec(texto);
  const ultimaSaida = /last exit code = (\d+)/.exec(texto);
  const rodando = !!pid;
  return {
    ...recurso(ESTADO.SUPORTADO),
    ativo: rodando,
    habilitado: /\brunatload\b/i.test(texto),
    estadoAtivo: rodando ? "active" : "inactive",
    subEstado: estado ? estado[1] : rodando ? "running" : "not running",
    arquivoUnidade: dominio,
    pid: pid ? Number(pid[1]) : null,
    resultadoUltimaExecucao: ultimaSaida ? `exit ${ultimaSaida[1]}` : null,
    memoriaBytes: null,
    reinicios: null,
    desde: null,
  };
}

async function controlarServico(acao) {
  const uid = uidAtual();
  if (uid === null) return recurso(ESTADO.INDISPONIVEL, "não foi possível determinar o uid atual");
  const existente = await estadoDoServico();
  if (existente.estado === ESTADO.NAO_INSTALADO) return existente;

  const alvo = existente.arquivoUnidade === "system" ? `system/${SERVICO_APP}` : `gui/${uid}/${SERVICO_APP}`;
  const comandos = {
    iniciar: [["kickstart", alvo]],
    parar: [["kill", "SIGTERM", alvo]],
    reiniciar: [["kickstart", "-k", alvo]],
  };
  if (!comandos[acao]) return recurso(ESTADO.NAO_SUPORTADO, `ação de serviço desconhecida: ${acao}`);

  for (const args of comandos[acao]) {
    const r = await launchctl(args, { timeoutMs: 60_000 });
    if (!r.ok) {
      if (/Operation not permitted|not privileged/i.test(r.saida || "")) {
        return recurso(ESTADO.SEM_PERMISSAO, "esta operação exige privilégio que a sessão atual não tem");
      }
      return recurso(ESTADO.INDISPONIVEL, (r.saida || r.erro || "").slice(0, 300));
    }
  }
  return recurso(ESTADO.SUPORTADO);
}

async function estadoDoWatchdog() {
  return recurso(
    ESTADO.NAO_APLICAVEL,
    "o watchdog de saúde é um timer systemd e não existe no macOS. O launchd supervisiona o processo com KeepAlive."
  );
}

async function controlarWatchdog() {
  return estadoDoWatchdog();
}

async function lerRegistros({ unidade = "aplicacao", linhas = 200 } = {}) {
  const n = Math.max(10, Math.min(Number(linhas) || 200, 2000));
  const predicados = {
    aplicacao: `subsystem == "${SERVICO_APP}" OR process == "node"`,
    console: `subsystem == "${ROTULO_AGENTE}"`,
    saude: `subsystem == "${SERVICO_APP}"`,
    recuperacao: `subsystem == "${SERVICO_APP}"`,
  };
  if (!predicados[unidade]) return recurso(ESTADO.NAO_SUPORTADO, "unidade de log não permitida");

  const r = await processos.executar(
    "log",
    ["show", "--style", "compact", "--last", "2h", "--predicate", predicados[unidade]],
    { timeoutMs: 45_000, limiteBytes: 512 * 1024 }
  );
  if (!r.ok) return recurso(ESTADO.INDISPONIVEL, r.erro || "não foi possível ler o log unificado");
  const linhasTexto = r.saida.split("\n").filter(Boolean).slice(-n);
  return {
    ...recurso(ESTADO.SUPORTADO),
    texto: linhasTexto.join("\n"),
    fonte: "log unificado do macOS (últimas 2 h)",
    observacao: "O log unificado filtra por subsistema; um RemoteIFES iniciado manualmente pode escrever apenas no terminal.",
  };
}

async function reiniciarHost() {
  // `shutdown -r` exige root; sem sudo configurado, a recusa é explícita em vez de silenciosa.
  const r = await processos.executar("shutdown", ["-r", "now"], { timeoutMs: 20_000 });
  if (r.ok) return recurso(ESTADO.SUPORTADO);
  if (/not permitted|must be root|Operation not permitted/i.test(r.saida || "")) {
    return recurso(ESTADO.SEM_PERMISSAO, "reiniciar o host exige privilégio de administrador nesta sessão");
  }
  return recurso(ESTADO.INDISPONIVEL, (r.saida || r.erro || "").slice(0, 300));
}

async function reiniciarConsole() {
  const uid = uidAtual();
  if (uid === null) return recurso(ESTADO.INDISPONIVEL, "não foi possível determinar o uid atual");
  if (!fs.existsSync(caminhoAgente())) {
    return recurso(
      ESTADO.NAO_APLICAVEL,
      "o console é iniciado sob demanda pelo lançador; encerrá-lo basta, e a próxima abertura sobe a versão nova."
    );
  }
  const r = await launchctl(["kickstart", "-k", `gui/${uid}/${ROTULO_AGENTE}`], { timeoutMs: 30_000 });
  return r.ok ? recurso(ESTADO.SUPORTADO) : recurso(ESTADO.INDISPONIVEL, (r.saida || r.erro || "").slice(0, 300));
}

function memoria() {
  // vm_stat daria o detalhe, mas o total/livre do os já é suficiente e não custa um processo.
  return { totalBytes: os.totalmem(), disponivelBytes: os.freemem(), fonte: "os (macOS)" };
}

async function disco(caminhos) {
  const saida = [];
  for (const caminho of caminhos) {
    const r = await processos.executar("df", ["-P", "-k", caminho], { timeoutMs: 6000 });
    if (!r.ok) {
      saida.push({ caminho, suportado: false, motivo: r.erro || "df falhou" });
      continue;
    }
    const partes = r.saida.trim().split("\n").pop().trim().split(/\s+/);
    if (partes.length < 6) {
      saida.push({ caminho, suportado: false, motivo: "saída de df inesperada" });
      continue;
    }
    const total = Number(partes[1]) * 1024;
    const usado = Number(partes[2]) * 1024;
    saida.push({
      caminho,
      suportado: true,
      dispositivo: partes[0],
      totalBytes: total,
      usadoBytes: usado,
      livreBytes: Number(partes[3]) * 1024,
      usoPercentual: total > 0 ? Math.round((usado / total) * 100) : null,
      montagem: partes[5],
    });
  }
  return saida;
}

async function relogio() {
  const comum = { agora: new Date().toISOString(), fusoNode: Intl.DateTimeFormat().resolvedOptions().timeZone };
  const r = await processos.executar("systemsetup", ["-getusingnetworktime"], { timeoutMs: 15_000 });
  if (!r.ok) return { ...comum, sincronizado: null, suportado: false, motivo: "systemsetup exige privilégio; sincronização não consultada" };
  return { ...comum, suportado: true, sincronizado: /On/i.test(r.saida), fusoHorario: comum.fusoNode };
}

async function portasEmEscuta() {
  const r = await processos.executar("netstat", ["-an", "-p", "tcp"], { timeoutMs: 20_000 });
  if (!r.ok) return recurso(ESTADO.INDISPONIVEL, r.erro || "netstat indisponível");
  const linhas = r.saida
    .split("\n")
    .filter((l) => /LISTEN/.test(l))
    .slice(0, 40);
  return { ...recurso(ESTADO.SUPORTADO), comProcesso: false, linhas };
}

async function pacotesPendentes() {
  const r = await processos.executar("softwareupdate", ["-l"], { timeoutMs: 60_000 });
  if (!r.ok) return recurso(ESTADO.INDISPONIVEL, "softwareupdate não respondeu");
  if (/No new software available/i.test(r.saida)) {
    return { ...recurso(ESTADO.SUPORTADO), pendentes: 0, observacao: "Consulta ao softwareupdate; instalar atualizações continua sendo decisão humana." };
  }
  const n = (r.saida.match(/^\s*\*\s/gm) || []).length;
  return { ...recurso(ESTADO.SUPORTADO), pendentes: n, observacao: "Consulta ao softwareupdate; instalar atualizações continua sendo decisão humana." };
}

async function abrirNavegador(url) {
  const r = await processos.executar("open", [url], { timeoutMs: 15_000 });
  return r.ok ? { ...recurso(ESTADO.SUPORTADO), url } : recurso(ESTADO.INDISPONIVEL, r.erro || "open falhou", { url });
}

// O programa mora dentro do bundle, em Contents/Resources — é onde o macOS espera encontrar o
// conteúdo de um .app. Deixá-lo na raiz do bundle funcionaria, mas quebra a convenção e
// atrapalharia uma futura assinatura/notarização, que assina a estrutura, não uma pasta solta.
const BUNDLE = "RemoteIFES Console.app";

// Caminhos do macOS são POSIX por definição. Montá-los com `path.posix` mantém a forma certa
// mesmo quando o adaptador é carregado fora do macOS (CONSOLE_PLATAFORMA, nos testes), em vez
// de produzir barras invertidas que nenhum macOS entenderia.
const unir = (...partes) => path.posix.join(...partes.map((parte) => String(parte).split("\\").join("/")));

function diretoriosPadrao({ escopo = "usuario" } = {}) {
  if (escopo === "sistema") {
    return {
      escopo: "sistema",
      bundle: unir("/Applications", BUNDLE),
      raizInstalacao: unir("/Applications", BUNDLE, "Contents", "Resources"),
      estado: "/Library/Application Support/RemoteIFES Console",
      logs: "/Library/Logs/RemoteIFES Console",
      cache: "/Library/Caches/br.edu.ifes.remoteifes.console",
      atalhos: "/Applications",
    };
  }
  const casa = os.homedir();
  return {
    escopo: "usuario",
    bundle: unir(casa, "Applications", BUNDLE),
    raizInstalacao: unir(casa, "Applications", BUNDLE, "Contents", "Resources"),
    estado: unir(casa, "Library", "Application Support", "RemoteIFES Console"),
    logs: unir(casa, "Library", "Logs", "RemoteIFES Console"),
    cache: unir(casa, "Library", "Caches", "br.edu.ifes.remoteifes.console"),
    atalhos: unir(casa, "Applications"),
  };
}

/** Bundle que contém esta raiz de instalação, se ela estiver dentro de um. */
function bundleDaRaiz(raiz) {
  const partes = String(raiz).split("\\").join("/").split("/");
  const i = partes.lastIndexOf(BUNDLE);
  return i >= 0 ? partes.slice(0, i + 1).join("/") : null;
}

function plistDoAgente({ comando, argumentos = [], logs }) {
  const itens = [comando, ...argumentos]
    .map((v) => `      <string>${String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;")}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${ROTULO_AGENTE}</string>
    <key>ProgramArguments</key>
    <array>
${itens}
    </array>
    <!-- Sob demanda: o lançador aciona quando alguém abre o console, e o processo sai por
         ociosidade. RunAtLoad=false é o que mantém o custo ocioso em zero. -->
    <key>RunAtLoad</key>
    <false/>
    <key>KeepAlive</key>
    <false/>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${path.join(logs, "console.log")}</string>
    <key>StandardErrorPath</key>
    <string>${path.join(logs, "console.err")}</string>
  </dict>
</plist>
`;
}

async function registrarInicializacao({ comando, argumentos = [], logs } = {}) {
  if (!comando) return recurso(ESTADO.NAO_SUPORTADO, "comando de inicialização ausente");
  const uid = uidAtual();
  if (uid === null) return recurso(ESTADO.INDISPONIVEL, "não foi possível determinar o uid atual");
  const destino = caminhoAgente();
  try {
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(destino, plistDoAgente({ comando, argumentos, logs }), { mode: 0o644 });
  } catch (erro) {
    return recurso(ESTADO.INDISPONIVEL, `não foi possível gravar o LaunchAgent: ${erro.message}`);
  }
  await launchctl(["bootout", `gui/${uid}/${ROTULO_AGENTE}`]);
  const r = await launchctl(["bootstrap", `gui/${uid}`, destino], { timeoutMs: 30_000 });
  if (!r.ok) return recurso(ESTADO.INDISPONIVEL, (r.saida || r.erro || "").slice(0, 300));
  return { ...recurso(ESTADO.SUPORTADO), mecanismo: "LaunchAgent (sob demanda)", arquivo: destino };
}

async function removerInicializacao() {
  const uid = uidAtual();
  const destino = caminhoAgente();
  if (uid !== null) await launchctl(["bootout", `gui/${uid}/${ROTULO_AGENTE}`]);
  try {
    fs.rmSync(destino, { force: true });
  } catch {}
  return recurso(ESTADO.SUPORTADO);
}

async function estadoDaInicializacao() {
  const destino = caminhoAgente();
  if (!fs.existsSync(destino)) {
    return { ...recurso(ESTADO.SUPORTADO), habilitado: false, mecanismo: "LaunchAgent (sob demanda)" };
  }
  const uid = uidAtual();
  const r = uid === null ? { ok: false } : await launchctl(["print", `gui/${uid}/${ROTULO_AGENTE}`]);
  return { ...recurso(ESTADO.SUPORTADO), habilitado: !!r.ok, mecanismo: "LaunchAgent (sob demanda)", arquivo: destino };
}

module.exports = {
  ...base,
  nome: "macos",
  rotulo: "macOS",
  ROTULO_AGENTE,
  servicoDaAplicacao: SERVICO_APP,
  estadoDoServico,
  controlarServico,
  estadoDoWatchdog,
  controlarWatchdog,
  lerRegistros,
  reiniciarHost,
  reiniciarConsole,
  memoria,
  disco,
  relogio,
  portasEmEscuta,
  pacotesPendentes,
  abrirNavegador,
  diretoriosPadrao,
  bundleDaRaiz,
  plistDoAgente,
  registrarInicializacao,
  removerInicializacao,
  estadoDaInicializacao,
};

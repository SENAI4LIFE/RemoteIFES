const fs = require("fs");
const os = require("os");
const path = require("path");
const base = require("./base");
const config = require("../config");
const processos = require("../processos");

// Linux adapter: systemd socket activation, privileged helper with fixed verbs, journal and /proc
// reads. Distinguishes "systemd does not exist on this system" from "the unit is not installed".

const { ESTADO, recurso } = base;

let systemdDetectado = null;

function temSystemd() {
  if (systemdDetectado !== null) return systemdDetectado;
  // /run/systemd/system exists only when systemd is the running init.
  systemdDetectado = fs.existsSync("/run/systemd/system");
  return systemdDetectado;
}

function semSystemd(oQue) {
  return recurso(
    ESTADO.NAO_APLICAVEL,
    `${oQue} depende do systemd, que não é o gerenciador de serviços deste sistema. ` +
      "Use os comandos do gerenciador em uso; a recuperação por terminal do README continua válida."
  );
}

function semAuxiliar(resultado) {
  if (resultado.indisponivel) {
    return recurso(
      config.SEM_PRIVILEGIO ? ESTADO.NAO_APLICAVEL : ESTADO.NAO_INSTALADO,
      resultado.erro || "auxiliar privilegiado não instalado"
    );
  }
  return null;
}

function camposDeShow(texto) {
  const campos = {};
  for (const linha of String(texto).split("\n")) {
    const idx = linha.indexOf("=");
    if (idx > 0) campos[linha.slice(0, idx).trim()] = linha.slice(idx + 1).trim();
  }
  return campos;
}

async function estadoDoServico() {
  if (!temSystemd()) return semSystemd("o controle do serviço da aplicação");
  const r = await processos.chamarAuxiliar("servico-estado", [], { timeoutMs: 10_000 });
  const indisponivel = semAuxiliar(r);
  if (indisponivel) return indisponivel;
  if (!r.ok) return recurso(ESTADO.INDISPONIVEL, r.erro || "não foi possível consultar o systemd");

  const campos = camposDeShow(r.saida);
  // LoadState=not-found distinguishes "unit never installed" from "installed and stopped".
  if (campos.LoadState === "not-found") {
    return recurso(ESTADO.NAO_INSTALADO, "remoteifes.service não está instalado; rode install-service.sh no servidor");
  }
  return {
    ...recurso(ESTADO.SUPORTADO),
    ativo: campos.ActiveState === "active",
    habilitado: campos.UnitFileState === "enabled",
    estadoAtivo: campos.ActiveState || null,
    subEstado: campos.SubState || null,
    arquivoUnidade: campos.UnitFileState || null,
    desde: campos.ActiveEnterTimestamp || null,
    resultadoUltimaExecucao: campos.Result || null,
    reinicios: config.inteiro(campos.NRestarts, null, 0, 1e9),
    pid: config.inteiro(campos.MainPID, null, 0, 1e9),
    memoriaBytes: config.inteiro(campos.MemoryCurrent, null, 0, Number.MAX_SAFE_INTEGER),
  };
}

async function controlarServico(acao) {
  if (!temSystemd()) return semSystemd("o controle do serviço da aplicação");
  const verbos = { iniciar: "servico-iniciar", parar: "servico-parar", reiniciar: "servico-reiniciar" };
  if (!verbos[acao]) return recurso(ESTADO.NAO_SUPORTADO, `ação de serviço desconhecida: ${acao}`);
  const r = await processos.chamarAuxiliar(verbos[acao], [], { timeoutMs: 60_000 });
  const indisponivel = semAuxiliar(r);
  if (indisponivel) return indisponivel;
  return r.ok ? recurso(ESTADO.SUPORTADO) : recurso(ESTADO.INDISPONIVEL, r.erro || r.saida || "o systemd recusou a operação");
}

async function estadoDoWatchdog() {
  if (!temSystemd()) return semSystemd("o watchdog de saúde");
  const app = config.caminhosDaAplicacao();
  const falhas = (() => {
    try {
      return fs.readFileSync(app.falhasSaude, "utf8").trim();
    } catch {
      return null;
    }
  })();
  const comum = { falhasConsecutivas: falhas === null ? 0 : config.inteiro(falhas, 0, 0, 1000), limite: 3, intervaloMinutos: 2 };

  const r = await processos.chamarAuxiliar("watchdog-estado", [], { timeoutMs: 10_000 });
  const indisponivel = semAuxiliar(r);
  if (indisponivel) return { ...indisponivel, ...comum };
  if (!r.ok) return { ...recurso(ESTADO.INDISPONIVEL, r.erro), ...comum };

  const campos = camposDeShow(r.saida);
  if (campos.LoadState === "not-found") {
    return { ...recurso(ESTADO.NAO_INSTALADO, "remoteifes-health.timer não está instalado"), ...comum };
  }
  return {
    ...recurso(ESTADO.SUPORTADO),
    ...comum,
    ativo: campos.ActiveState === "active",
    habilitado: campos.UnitFileState === "enabled",
    proximaExecucao: campos.NextElapseUSecRealtime || null,
  };
}

async function controlarWatchdog(acao) {
  if (!temSystemd()) return semSystemd("o watchdog de saúde");
  const verbos = { ligar: "watchdog-ligar", desligar: "watchdog-desligar" };
  if (!verbos[acao]) return recurso(ESTADO.NAO_SUPORTADO, `ação de watchdog desconhecida: ${acao}`);
  const r = await processos.chamarAuxiliar(verbos[acao], [], { timeoutMs: 20_000 });
  const indisponivel = semAuxiliar(r);
  if (indisponivel) return indisponivel;
  return r.ok ? recurso(ESTADO.SUPORTADO) : recurso(ESTADO.INDISPONIVEL, r.erro || "o systemd recusou a operação");
}

const UNIDADES = { aplicacao: "app", saude: "health", console: "console", recuperacao: "recover" };

async function lerRegistros({ unidade = "aplicacao", linhas = 200, prioridade = null } = {}) {
  if (!temSystemd()) return semSystemd("a leitura do journal");
  if (!UNIDADES[unidade]) return recurso(ESTADO.NAO_SUPORTADO, "unidade de log não permitida");
  const n = Math.max(10, Math.min(Number(linhas) || 200, 2000));
  const args = [UNIDADES[unidade], String(n)];
  if (prioridade !== null && prioridade !== undefined && prioridade !== "") {
    if (!/^[0-7]$/.test(String(prioridade))) return recurso(ESTADO.NAO_SUPORTADO, "prioridade inválida");
    args.push(String(prioridade));
  }
  const r = await processos.chamarAuxiliar("journal", args, { timeoutMs: 20_000, limiteBytes: 512 * 1024 });
  const indisponivel = semAuxiliar(r);
  if (indisponivel) return indisponivel;
  return r.ok
    ? { ...recurso(ESTADO.SUPORTADO), texto: r.saida || "", fonte: "journalctl" }
    : recurso(ESTADO.INDISPONIVEL, r.erro || "não foi possível ler o journal");
}

async function reiniciarHost() {
  if (!temSystemd()) return semSystemd("o reinício do host");
  const r = await processos.chamarAuxiliar("reiniciar-host", [], { timeoutMs: 20_000 });
  const indisponivel = semAuxiliar(r);
  if (indisponivel) return indisponivel;
  return r.ok ? recurso(ESTADO.SUPORTADO) : recurso(ESTADO.INDISPONIVEL, r.erro);
}

async function reiniciarConsole() {
  if (!temSystemd()) return semSystemd("o reinício do serviço do console");
  const r = await processos.chamarAuxiliar("console-reiniciar", [], { timeoutMs: 20_000 });
  const indisponivel = semAuxiliar(r);
  if (indisponivel) return indisponivel;
  return r.ok ? recurso(ESTADO.SUPORTADO) : recurso(ESTADO.INDISPONIVEL, r.erro);
}

function memoria() {
  // /proc/meminfo gives real "available" memory; os.freemem() ignores reclaimable cache and makes a
  // healthy Pi look out of memory.
  let texto;
  try {
    texto = fs.readFileSync("/proc/meminfo", "utf8");
  } catch {
    return base.memoria();
  }
  const campos = {};
  for (const linha of texto.split("\n")) {
    const m = /^(\w+):\s+(\d+)\s*kB$/.exec(linha.trim());
    if (m) campos[m[1]] = Number(m[2]) * 1024;
  }
  return {
    totalBytes: campos.MemTotal ?? os.totalmem(),
    disponivelBytes: campos.MemAvailable ?? campos.MemFree ?? os.freemem(),
    swapTotalBytes: campos.SwapTotal ?? null,
    swapLivreBytes: campos.SwapFree ?? null,
    fonte: "/proc/meminfo",
  };
}

function temperaturaC() {
  try {
    const bruto = fs.readFileSync("/sys/class/thermal/thermal_zone0/temp", "utf8").trim();
    if (!/^\d+$/.test(bruto)) return null;
    const valor = Number(bruto);
    return Math.round((valor > 1000 ? valor / 1000 : valor) * 10) / 10;
  } catch {
    return null;
  }
}

async function throttle() {
  const r = await processos.executar("vcgencmd", ["get_throttled"], { timeoutMs: 4000 });
  if (!r.ok) return recurso(ESTADO.NAO_APLICAVEL, "vcgencmd não existe neste host (indicador específico do Raspberry Pi)");
  const m = /throttled=0x([0-9a-fA-F]+)/.exec(r.saida || "");
  if (!m) return recurso(ESTADO.INDISPONIVEL, "resposta inesperada de vcgencmd");
  const bits = Number.parseInt(m[1], 16);
  return {
    ...recurso(ESTADO.SUPORTADO),
    bruto: `0x${m[1]}`,
    subtensaoAgora: !!(bits & 0x1),
    limiteFrequenciaAgora: !!(bits & 0x2),
    throttlingAgora: !!(bits & 0x4),
    subtensaoDesdeOBoot: !!(bits & 0x10000),
    throttlingDesdeOBoot: !!(bits & 0x40000),
  };
}

async function disco(caminhos) {
  const saida = [];
  for (const caminho of caminhos) {
    const r = await processos.executar("df", ["-P", "-k", caminho], { timeoutMs: 6000 });
    if (!r.ok) {
      saida.push({ caminho, suportado: false, motivo: r.erro || "df falhou" });
      continue;
    }
    const linha = r.saida.trim().split("\n").pop();
    const partes = linha.trim().split(/\s+/);
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
  const r = await processos.executar("timedatectl", ["show"], { timeoutMs: 5000 });
  const comum = { agora: new Date().toISOString(), fusoNode: Intl.DateTimeFormat().resolvedOptions().timeZone };
  if (!r.ok) return { ...comum, sincronizado: null, suportado: false, motivo: "timedatectl indisponível" };
  const campos = camposDeShow(r.saida);
  return {
    ...comum,
    suportado: true,
    sincronizado: campos.NTPSynchronized === "yes",
    ntpAtivo: campos.NTP === "yes",
    fusoHorario: campos.Timezone || comum.fusoNode,
  };
}

async function pacotesPendentes() {
  const r = await processos.chamarAuxiliar("pacotes-pendentes", [], { timeoutMs: 20_000 });
  const indisponivel = semAuxiliar(r);
  if (indisponivel) return indisponivel;
  if (!r.ok) return recurso(ESTADO.INDISPONIVEL, r.erro);
  const texto = (r.saida || "").trim();
  if (texto === "indisponivel") return recurso(ESTADO.NAO_APLICAVEL, "gerenciador de pacotes não reconhecido");
  if (!/^\d+$/.test(texto)) return recurso(ESTADO.INDISPONIVEL, "resposta inesperada");
  return {
    ...recurso(ESTADO.SUPORTADO),
    pendentes: Number(texto),
    observacao: "Contagem do cache local, sem consultar repositórios. Instalar atualizações do sistema é operação de terminal.",
  };
}

async function portasEmEscuta() {
  const comAuxiliar = await processos.chamarAuxiliar("portas", [], { timeoutMs: 10_000 });
  if (comAuxiliar.ok) {
    return { ...recurso(ESTADO.SUPORTADO), comProcesso: true, linhas: comAuxiliar.saida.split("\n").filter(Boolean).slice(0, 40) };
  }
  const semPrivilegio = await processos.executar("ss", ["-ltn"], { timeoutMs: 8000 });
  if (semPrivilegio.ok) {
    return { ...recurso(ESTADO.SUPORTADO), comProcesso: false, linhas: semPrivilegio.saida.split("\n").filter(Boolean).slice(0, 40) };
  }
  return recurso(ESTADO.INDISPONIVEL, "ss não está disponível neste host");
}

async function abrirNavegador(url) {
  // xdg-open respects the user's graphical session. A headless host has no browser, and this is
  // stated instead of failing silently.
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return recurso(ESTADO.NAO_APLICAVEL, "este host não tem sessão gráfica; abra o endereço a partir da sua máquina por túnel SSH", { url });
  }
  const r = await processos.executar("xdg-open", [url], { timeoutMs: 10_000 });
  return r.ok ? { ...recurso(ESTADO.SUPORTADO), url } : recurso(ESTADO.INDISPONIVEL, r.erro || "xdg-open falhou", { url });
}

function diretoriosPadrao({ escopo = "sistema" } = {}) {
  if (escopo === "usuario") {
    const dados = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
    const estado = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
    const cache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
    return {
      escopo: "usuario",
      raizInstalacao: path.join(dados, "remoteifes-console"),
      estado: path.join(estado, "remoteifes-console"),
      logs: path.join(estado, "remoteifes-console", "logs"),
      cache: path.join(cache, "remoteifes-console"),
      atalhos: path.join(dados, "applications"),
    };
  }
  return {
    escopo: "sistema",
    raizInstalacao: "/opt/remoteifes-console",
    estado: "/var/lib/remoteifes-console",
    logs: "/var/log/remoteifes-console",
    cache: "/var/cache/remoteifes-console",
    atalhos: "/usr/share/applications",
  };
}

// --- System integration (systemd + privileged helper) ---------------------------------
//
// A single implementation, shared by package and scripted installs, so both produce the same
// layout.

const UNIDADE_SOCKET = "/etc/systemd/system/remoteifes-console.socket";
const UNIDADE_SERVICO = "/etc/systemd/system/remoteifes-console.service";
const DIR_AUXILIAR = "/usr/local/lib/remoteifes";
const CAMINHO_AUXILIAR = `${DIR_AUXILIAR}/console-helper.sh`;
const REGRA_SUDO = "/etc/sudoers.d/remoteifes-console";

function renderizar(modelo, valores) {
  let texto = fs.readFileSync(modelo, "utf8");
  for (const [chave, valor] of Object.entries(valores)) {
    texto = texto.split(`__${chave}__`).join(String(valor));
  }
  const sobrou = /__([A-Z_]+)__/.exec(texto);
  if (sobrou) throw new Error(`o modelo ${path.basename(modelo)} tem o marcador ${sobrou[0]} sem valor`);
  return texto;
}

/**
 * Installs the socket, service, privileged helper and sudo rule. Called by the installer in system
 * scope, already as root.
 *
 * The unit points at the stable layer (`console-bootstrap.js`), never at a version, which lets the
 * Console update without rewriting a systemd file.
 */
async function registrarInicializacao({ origem, raizInstalacao, dirEstado, dirDados, checkout, usuario, node, porta = 8099 }) {
  if (!temSystemd()) return semSystemd("a inicialização automática do console");
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    return recurso(ESTADO.SEM_PERMISSAO, "a instalação das unidades systemd exige root");
  }
  const modelos = path.join(origem, "systemd");
  const valores = {
    USUARIO: usuario,
    NODE: node,
    RAIZ_INSTALACAO: raizInstalacao,
    DIR_ESTADO: dirEstado,
    DIR_DADOS: dirDados,
    CHECKOUT: checkout,
    PORTA: porta,
  };

  // Privileged helper: root:root in a root:root directory. The helper, not the Console, holds root
  // access, and it accepts only fixed verbs.
  fs.mkdirSync(DIR_AUXILIAR, { recursive: true });
  fs.chmodSync(DIR_AUXILIAR, 0o755);
  fs.copyFileSync(path.join(origem, "helper", "console-helper.sh"), CAMINHO_AUXILIAR);
  fs.chmodSync(CAMINHO_AUXILIAR, 0o755);
  try {
    fs.chownSync(DIR_AUXILIAR, 0, 0);
    fs.chownSync(CAMINHO_AUXILIAR, 0, 0);
  } catch {}

  // The sudo rule is validated before taking effect: an invalid sudoers can lock the whole host, so
  // the file is written to a temporary, checked with visudo and only then moved.
  const regraTemp = `${REGRA_SUDO}.novo`;
  fs.writeFileSync(
    regraTemp,
    [
      "# Console de Operações RemoteIFES.",
      "# Uma única entrada, apontando para um script root:root em diretório root:root. O script",
      "# aceita somente verbos fixos com alvo fixo; não há git, npm, shell nem unidade arbitrários.",
      `${usuario} ALL=(root) NOPASSWD: ${CAMINHO_AUXILIAR}`,
      "",
    ].join("\n"),
    { mode: 0o440 }
  );
  const conferencia = await processos.executar("visudo", ["-cf", regraTemp], { timeoutMs: 15_000 });
  if (!conferencia.ok) {
    fs.rmSync(regraTemp, { force: true });
    return recurso(ESTADO.INDISPONIVEL, `regra de sudo recusada pelo visudo: ${conferencia.saida || conferencia.erro}`);
  }
  fs.renameSync(regraTemp, REGRA_SUDO);
  fs.chmodSync(REGRA_SUDO, 0o440);

  fs.writeFileSync(UNIDADE_SOCKET, renderizar(path.join(modelos, "remoteifes-console.socket.modelo"), valores), { mode: 0o644 });
  fs.writeFileSync(UNIDADE_SERVICO, renderizar(path.join(modelos, "remoteifes-console.service.modelo"), valores), { mode: 0o644 });

  await processos.executar("systemctl", ["daemon-reload"], { timeoutMs: 30_000 });
  const habilitar = await processos.executar("systemctl", ["enable", "remoteifes-console.socket"], { timeoutMs: 30_000 });
  if (!habilitar.ok) return recurso(ESTADO.INDISPONIVEL, `systemctl enable falhou: ${habilitar.saida || habilitar.erro}`);
  await processos.executar("systemctl", ["restart", "remoteifes-console.socket"], { timeoutMs: 30_000 });

  return {
    ...recurso(ESTADO.SUPORTADO),
    mecanismo: `socket systemd em 127.0.0.1:${porta} (nenhum processo residente; o console sobe na primeira conexão)`,
    porta,
    auxiliar: CAMINHO_AUXILIAR,
  };
}

async function removerInicializacao() {
  if (!temSystemd()) return semSystemd("a remoção da inicialização automática do console");
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    return recurso(ESTADO.SEM_PERMISSAO, "a remoção das unidades systemd exige root");
  }
  const existia = fs.existsSync(UNIDADE_SOCKET) || fs.existsSync(UNIDADE_SERVICO);
  await processos.executar("systemctl", ["disable", "--now", "remoteifes-console.socket"], { timeoutMs: 30_000 });
  await processos.executar("systemctl", ["stop", "remoteifes-console.service"], { timeoutMs: 30_000 });
  for (const arquivo of [UNIDADE_SOCKET, UNIDADE_SERVICO, REGRA_SUDO, CAMINHO_AUXILIAR]) {
    try {
      fs.rmSync(arquivo, { force: true });
    } catch {}
  }
  try {
    fs.rmdirSync(DIR_AUXILIAR);
  } catch {}
  await processos.executar("systemctl", ["daemon-reload"], { timeoutMs: 30_000 });
  return {
    ...recurso(ESTADO.SUPORTADO),
    mecanismo: existia
      ? "unidades systemd, regra de sudo e auxiliar privilegiado removidos"
      : "não havia unidades systemd instaladas",
  };
}

async function estadoDaInicializacao() {
  if (!temSystemd()) return semSystemd("a inicialização automática do console");
  const r = await processos.executar("systemctl", ["is-enabled", "remoteifes-console.socket"], { timeoutMs: 8000 });
  if (!r.ok && !/disabled|enabled/.test(r.saida)) {
    return recurso(ESTADO.NAO_INSTALADO, "remoteifes-console.socket não está instalado");
  }
  return { ...recurso(ESTADO.SUPORTADO), habilitado: r.saida.trim() === "enabled", mecanismo: "systemd socket" };
}

module.exports = {
  ...base,
  nome: "linux",
  rotulo: "Linux",
  temSystemd,
  estadoDoServico,
  controlarServico,
  estadoDoWatchdog,
  controlarWatchdog,
  lerRegistros,
  reiniciarHost,
  reiniciarConsole,
  memoria,
  temperaturaC,
  throttle,
  disco,
  relogio,
  pacotesPendentes,
  portasEmEscuta,
  abrirNavegador,
  diretoriosPadrao,
  registrarInicializacao,
  removerInicializacao,
  estadoDaInicializacao,
};

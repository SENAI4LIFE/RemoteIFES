const fs = require("fs");
const os = require("os");
const path = require("path");
const config = require("../config");
const processos = require("../processos");

// Platform adapter: common contract and portable implementations.
//
// Only what truly depends on the operating system lives here. Authentication, action definitions,
// readiness, job outcomes, deploy semantics, backup policy and the interface stay portable and know
// no platform.
//
// Every capability answers with an **explicit state**, never a boolean. "Cannot" has different
// causes the operator must tell apart: a service that does not exist on this system differs from
// one that exists but is not installed, and both differ from missing permission.

const ESTADO = Object.freeze({
  SUPORTADO: "suportado",
  NAO_INSTALADO: "nao-instalado",
  SEM_PERMISSAO: "sem-permissao",
  INDISPONIVEL: "indisponivel",
  NAO_APLICAVEL: "nao-aplicavel",
  NAO_SUPORTADO: "nao-suportado",
});

function recurso(estado, motivo, extra = {}) {
  return { estado, disponivel: estado === ESTADO.SUPORTADO, motivo: motivo || null, ...extra };
}

const NAO_IMPLEMENTADO = (nome) =>
  recurso(ESTADO.NAO_SUPORTADO, `${nome} não tem implementação para ${process.platform} nesta versão do console`);

/**
 * Architecture classification. Hardware, kernel, userland, runtime and artifact are different
 * things, and conflating them is the classic Raspberry Pi 3 mistake: 64-bit hardware, a 64-bit
 * kernel and a 32-bit userland coexist on the same device. `uname -m` answers for the kernel and
 * leads to the wrong conclusion; the **runtime** (`process.arch`) and, when present, the package
 * manager architecture decide which artifact applies.
 */
async function classificarArquitetura() {
  const runtime = process.arch;
  const kernel = (() => {
    try {
      return os.machine ? os.machine() : null;
    } catch {
      return null;
    }
  })();

  let userland = null;
  let fonteUserland = null;
  if (process.platform === "linux") {
    const dpkg = await processos.executar("dpkg", ["--print-architecture"], { timeoutMs: 5000 });
    if (dpkg.ok && dpkg.saida.trim()) {
      userland = dpkg.saida.trim();
      fonteUserland = "dpkg --print-architecture";
    } else {
      const rpm = await processos.executar("rpm", ["--eval", "%{_arch}"], { timeoutMs: 5000 });
      if (rpm.ok && rpm.saida.trim()) {
        userland = rpm.saida.trim();
        fonteUserland = "rpm --eval %{_arch}";
      }
    }
  }

  const modelo = (() => {
    try {
      return fs.readFileSync("/proc/device-tree/model", "utf8").replace(/\0/g, "").trim();
    } catch {
      return null;
    }
  })();

  const armv7 = runtime === "arm" || (userland && /armhf|armv7/.test(userland));
  return {
    runtime,
    kernel,
    userland,
    fonteUserland,
    hardware: modelo,
    // The artifact target follows the runtime: it is what will execute the code.
    alvoDeArtefato: `${process.platform}-${runtime}`,
    armv7,
    ressalva: armv7
      ? "Userland ARMv7 (32 bits). O Node 22 é a última linha com suporte normal a ARMv7 e sai de suporte em 2027-04-30; " +
        "o Node 24 rebaixa ARMv7 a experimental. Para produção de longo prazo, migre este host para um sistema de 64 bits (arm64)."
      : null,
    observacao:
      "Hardware, kernel, userland e runtime podem divergir. Um Raspberry Pi 3 roda hardware e kernel de 64 bits com " +
      "userland de 32 bits; quem decide o artefato é o runtime.",
  };
}

/**
 * Node used by the Console to launch its own runners.
 */
function runtimeAtual() {
  const bruto = process.versions.node;
  const [maior, menor] = bruto.split(".").map(Number);
  const minimo = { maior: 22, menor: 13 };
  const atende = maior > minimo.maior || (maior === minimo.maior && menor >= minimo.menor);
  return {
    versao: bruto,
    executavel: process.execPath,
    minimoExigido: `${minimo.maior}.${minimo.menor}.0`,
    atende,
    motivo: atende ? null : `Node ${bruto} é anterior ao mínimo ${minimo.maior}.${minimo.menor}.0 exigido pelo RemoteIFES`,
  };
}

/**
 * External tools the managed deploy needs on the host.
 */
async function ferramentas() {
  const saida = {};
  for (const [nome, args] of [
    ["git", ["--version"]],
    ["npm", ["--version"]],
  ]) {
    const executavel = process.platform === "win32" && nome === "npm" ? "npm.cmd" : nome;
    const r = await processos.executar(executavel, args, { timeoutMs: 15_000 });
    saida[nome] = r.ok
      ? recurso(ESTADO.SUPORTADO, null, { versao: r.saida.trim().split("\n")[0], executavel })
      : recurso(ESTADO.NAO_INSTALADO, `${nome} não foi encontrado no PATH deste serviço`, { executavel });
  }
  return saida;
}

// --- Portable implementations ----------------------------------------------------------------

function memoria() {
  return { totalBytes: os.totalmem(), disponivelBytes: os.freemem(), fonte: "os" };
}

function temperaturaC() {
  return null;
}

async function throttle() {
  return recurso(ESTADO.NAO_APLICAVEL, "indicadores de subtensão/limitação são específicos do Raspberry Pi");
}

/**
 * Disk space through Node's own `statfs`, with no subprocess, on all three systems.
 *
 * Readiness measures two paths before **every** operation; `fs.statfsSync` answers in microseconds,
 * while a PowerShell start per path loads the .NET engine and took over 15 s on modest hardware.
 *
 * `bavail` (not `bfree`) is what can actually be used: on POSIX part of the free space is reserved
 * for root, and promising it to a backup would promise what does not exist.
 */
async function disco(caminhos) {
  return caminhos.map((caminho) => {
    let info;
    try {
      info = fs.statfsSync(caminho);
    } catch (erro) {
      return { caminho, suportado: false, motivo: `não foi possível medir ${caminho}: ${erro.code || erro.message}` };
    }
    const bloco = Number(info.bsize) || 0;
    const total = Number(info.blocks) * bloco;
    const livre = Number(info.bavail) * bloco;
    const usado = (Number(info.blocks) - Number(info.bfree)) * bloco;
    if (!Number.isFinite(total) || total <= 0) {
      return { caminho, suportado: false, motivo: "o sistema de arquivos não informou tamanho" };
    }
    const montagem = path.parse(path.resolve(caminho)).root;
    return {
      caminho,
      suportado: true,
      dispositivo: montagem,
      totalBytes: total,
      usadoBytes: usado,
      livreBytes: livre,
      usoPercentual: Math.round((usado / total) * 100),
      montagem,
    };
  });
}

async function relogio() {
  return {
    agora: new Date().toISOString(),
    fusoNode: Intl.DateTimeFormat().resolvedOptions().timeZone,
    sincronizado: null,
    suportado: false,
  };
}

async function pacotesPendentes() {
  return recurso(ESTADO.NAO_APLICAVEL, "contagem de atualizações do sistema não se aplica a esta plataforma");
}

async function portasEmEscuta() {
  return recurso(ESTADO.NAO_SUPORTADO, "listagem de portas não implementada nesta plataforma");
}

async function estadoDoServico() {
  return NAO_IMPLEMENTADO("controle de serviço");
}

async function controlarServico() {
  return NAO_IMPLEMENTADO("controle de serviço");
}

async function estadoDoWatchdog() {
  return recurso(ESTADO.NAO_APLICAVEL, "o watchdog de saúde é uma unidade systemd e só existe no Linux");
}

async function controlarWatchdog() {
  return recurso(ESTADO.NAO_APLICAVEL, "o watchdog de saúde é uma unidade systemd e só existe no Linux");
}

async function lerRegistros() {
  return recurso(ESTADO.NAO_SUPORTADO, "leitura de registros do sistema não implementada nesta plataforma");
}

async function reiniciarHost() {
  return NAO_IMPLEMENTADO("reinício do host");
}

async function reiniciarConsole() {
  return NAO_IMPLEMENTADO("reinício do próprio console");
}

/**
 * Ends the process tree. The portable implementation uses the POSIX process group; Windows
 * overrides it with taskkill, because there is no POSIX group there.
 */
function encerrarArvore(pid, sinal) {
  if (!pid) return;
  try {
    process.kill(-pid, sinal);
  } catch {
    try {
      process.kill(pid, sinal);
    } catch {}
  }
}

/**
 * Spawn options so the child gets its own group and survives the Console.
 */
function opcoesDeGrupo() {
  return { detached: true };
}

/**
 * Opens a URL in the operator session's browser. Never receives a credential: the URL is always the
 * Console's or the application's, and authentication happens inside the page.
 */
async function abrirNavegador(url) {
  return recurso(ESTADO.NAO_SUPORTADO, "abertura de navegador não implementada nesta plataforma", { url });
}

/**
 * Protects a file so only its owner reads it. POSIX uses the mode; Windows overrides with an ACL.
 */
function protegerArquivo(caminho, { diretorio = false } = {}) {
  try {
    fs.chmodSync(caminho, diretorio ? 0o700 : 0o600);
    return recurso(ESTADO.SUPORTADO);
  } catch (erro) {
    return recurso(ESTADO.INDISPONIVEL, erro.message);
  }
}

/**
 * Checks whether a path is writable by anyone other than its owner.
 */
function permissaoRestrita(caminho) {
  try {
    const info = fs.statSync(caminho);
    const modo = info.mode & 0o777;
    const abertoParaOutros = (modo & 0o022) !== 0;
    return { restrito: !abertoParaOutros, modo: modo.toString(8).padStart(3, "0"), verificavel: true };
  } catch (erro) {
    return { restrito: null, verificavel: false, motivo: erro.message };
  }
}

/**
 * Platform default directories. Overridden by each adapter.
 */
function diretoriosPadrao() {
  const base = path.join(os.homedir(), ".remoteifes-console");
  return {
    escopo: "usuario",
    raizInstalacao: path.join(base, "programa"),
    estado: base,
    logs: path.join(base, "logs"),
    cache: path.join(base, "cache"),
    atalhos: null,
  };
}

/**
 * Registers the Console to start in the background.
 */
async function registrarInicializacao() {
  return NAO_IMPLEMENTADO("registro de inicialização automática");
}

async function removerInicializacao() {
  return NAO_IMPLEMENTADO("remoção do registro de inicialização automática");
}

async function estadoDaInicializacao() {
  return NAO_IMPLEMENTADO("consulta do registro de inicialização automática");
}

module.exports = {
  ESTADO,
  recurso,
  nome: "portatil",
  rotulo: `${os.type()} (genérico)`,
  classificarArquitetura,
  runtimeAtual,
  ferramentas,
  memoria,
  temperaturaC,
  throttle,
  disco,
  relogio,
  pacotesPendentes,
  portasEmEscuta,
  estadoDoServico,
  controlarServico,
  estadoDoWatchdog,
  controlarWatchdog,
  lerRegistros,
  reiniciarHost,
  reiniciarConsole,
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

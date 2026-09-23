const fs = require("fs");
const os = require("os");
const path = require("path");
const config = require("../config");
const processos = require("../processos");

// Adaptador de plataforma: contrato comum e implementações portáteis.
//
// Só entra aqui o que depende mesmo do sistema operacional. Autenticação, definição de ações,
// prontidão, desfecho de trabalhos, semântica de implantação, política de backup e a interface
// continuam portáteis e não conhecem plataforma nenhuma.
//
// Todo recurso responde com um **estado explícito**, nunca um booleano. "Não dá" tem causas
// diferentes e o operador precisa distinguir: um serviço que não existe neste sistema é outra
// coisa de um serviço que existe mas não está instalado, e as duas são outra coisa de falta de
// permissão.

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
 * Classificação de arquitetura. Hardware, kernel, userland, runtime e artefato são coisas
 * diferentes, e confundi-las é o erro clássico do Raspberry Pi 3: hardware de 64 bits, kernel
 * de 64 bits e userland de 32 bits convivem no mesmo aparelho. `uname -m` responde pelo kernel
 * e leva à conclusão errada; o que decide qual artefato serve é o **runtime** (`process.arch`)
 * e, quando existe, a arquitetura do gerenciador de pacotes.
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
    // O alvo de artefato segue o runtime: é ele que vai executar o código.
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

/** Node que o console usa para lançar seus próprios executores. */
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

/** Ferramentas externas que a implantação administrada precisa no host. */
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

// --- Implementações portáteis ----------------------------------------------------------------

function memoria() {
  return { totalBytes: os.totalmem(), disponivelBytes: os.freemem(), fonte: "os" };
}

function temperaturaC() {
  return null;
}

async function throttle() {
  return recurso(ESTADO.NAO_APLICAVEL, "indicadores de subtensão/limitação são específicos do Raspberry Pi");
}

async function disco(caminhos) {
  return caminhos.map((caminho) => ({ caminho, suportado: false, motivo: "medição de disco não implementada nesta plataforma" }));
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
 * Encerra a árvore de processos. A implementação portátil usa o grupo de processos POSIX;
 * Windows sobrescreve com taskkill, porque lá não existe grupo POSIX.
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

/** Opções de spawn para que o filho fique num grupo próprio e sobreviva ao console. */
function opcoesDeGrupo() {
  return { detached: true };
}

/**
 * Abre uma URL no navegador da sessão do operador. Nunca recebe credencial: a URL é sempre a
 * do console ou a da aplicação, e a autenticação acontece dentro da página.
 */
async function abrirNavegador(url) {
  return recurso(ESTADO.NAO_SUPORTADO, "abertura de navegador não implementada nesta plataforma", { url });
}

/** Protege um arquivo para que só o dono leia. POSIX usa modo; Windows sobrescreve com ACL. */
function protegerArquivo(caminho, { diretorio = false } = {}) {
  try {
    fs.chmodSync(caminho, diretorio ? 0o700 : 0o600);
    return recurso(ESTADO.SUPORTADO);
  } catch (erro) {
    return recurso(ESTADO.INDISPONIVEL, erro.message);
  }
}

/** Confere se um caminho é gravável por alguém além do dono. */
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

/** Diretórios padrão da plataforma. Sobrescrito por cada adaptador. */
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

/** Registro do console para iniciar em segundo plano. */
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

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const config = require("./config");

// Execução de processos do console. Regras, sem exceção:
//  - nunca com shell: sempre executável + vetor de argumentos;
//  - ambiente montado a partir de uma lista fixa, nunca herdado inteiro;
//  - diretório de trabalho escolhido pelo console, nunca pela requisição;
//  - saída limitada em bytes e duração limitada em tempo.
// Um endpoint genérico de comando não existe: quem chama aqui é o registro de ações.

const AMBIENTE_BASE = ["PATH", "LANG", "LC_ALL", "TZ", "HOME", "USER", "LOGNAME", "SHELL", "TERM"];

function ambienteLimpo(extra = {}) {
  const env = {};
  for (const chave of AMBIENTE_BASE) {
    if (process.env[chave] !== undefined) env[chave] = process.env[chave];
  }
  if (!env.PATH) env.PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
  // Evita que o git abra editor, pager ou peça credencial interativa em processo sem terminal.
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_PAGER = "cat";
  env.PAGER = "cat";
  env.SYSTEMD_PAGER = "";
  env.SYSTEMD_COLORS = "0";
  env.NO_COLOR = "1";
  for (const [chave, valor] of Object.entries(extra)) {
    if (valor === undefined || valor === null) continue;
    if (!/^[A-Z][A-Z0-9_]*$/.test(chave)) throw new Error(`variável de ambiente inválida: ${chave}`);
    env[chave] = String(valor);
  }
  return env;
}

// Buffer circular por bytes: retém o começo e o fim quando a saída estoura o limite, porque
// numa falha as duas pontas importam e o meio raramente importa.
class SaidaLimitada {
  constructor(limite) {
    this.limite = limite;
    this.inicio = [];
    this.bytesInicio = 0;
    this.fim = [];
    this.bytesFim = 0;
    this.total = 0;
    this.truncado = false;
  }

  escrever(pedaco) {
    const buf = Buffer.isBuffer(pedaco) ? pedaco : Buffer.from(String(pedaco));
    this.total += buf.length;
    const metade = Math.floor(this.limite / 2);
    if (this.bytesInicio < metade) {
      const cabe = Math.min(buf.length, metade - this.bytesInicio);
      this.inicio.push(buf.subarray(0, cabe));
      this.bytesInicio += cabe;
      if (cabe === buf.length) return;
      pedaco = buf.subarray(cabe);
    } else {
      pedaco = buf;
    }
    this.fim.push(pedaco);
    this.bytesFim += pedaco.length;
    while (this.bytesFim > metade && this.fim.length > 1) {
      this.bytesFim -= this.fim.shift().length;
      this.truncado = true;
    }
    if (this.bytesFim > metade) {
      const excesso = this.bytesFim - metade;
      this.fim[0] = this.fim[0].subarray(excesso);
      this.bytesFim -= excesso;
      this.truncado = true;
    }
  }

  texto() {
    const inicio = Buffer.concat(this.inicio).toString("utf8");
    const fim = Buffer.concat(this.fim).toString("utf8");
    if (!this.truncado) return inicio + fim;
    const omitidos = this.total - this.bytesInicio - this.bytesFim;
    return `${inicio}\n… [${omitidos} bytes omitidos no meio da saída] …\n${fim}`;
  }
}

function validarExecutavel(executavel) {
  if (typeof executavel !== "string" || !executavel) throw new Error("executável ausente");
  if (/[\n\r\0]/.test(executavel)) throw new Error("executável inválido");
  return executavel;
}

function validarArgumentos(args) {
  if (!Array.isArray(args)) throw new Error("argumentos devem ser uma lista");
  return args.map((a) => {
    if (typeof a === "number") return String(a);
    if (typeof a !== "string") throw new Error("argumento não textual");
    if (a.includes("\0")) throw new Error("argumento com byte nulo");
    return a;
  });
}

/**
 * Executa e devolve a saída completa (limitada). Para trabalhos longos use o motor de execução,
 * que grava em arquivo e sobrevive à queda do navegador.
 */
function executar(executavel, args = [], opcoes = {}) {
  const {
    cwd = config.RAIZ_CONSOLE,
    timeoutMs = 30_000,
    limiteBytes = 256 * 1024,
    env = {},
    entrada = null,
  } = opcoes;

  validarExecutavel(executavel);
  const argumentos = validarArgumentos(args);

  return new Promise((resolve) => {
    let filho;
    try {
      filho = spawn(executavel, argumentos, {
        cwd,
        env: ambienteLimpo(env),
        stdio: [entrada === null ? "ignore" : "pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
      });
    } catch (erro) {
      return resolve({ ok: false, codigo: null, sinal: null, saida: "", erro: erro.message, expirou: false });
    }

    const saida = new SaidaLimitada(limiteBytes);
    let expirou = false;
    const relogio = setTimeout(() => {
      expirou = true;
      try {
        filho.kill("SIGKILL");
      } catch {}
    }, timeoutMs);

    filho.stdout.on("data", (d) => saida.escrever(d));
    filho.stderr.on("data", (d) => saida.escrever(d));
    filho.on("error", (erro) => {
      clearTimeout(relogio);
      resolve({ ok: false, codigo: null, sinal: null, saida: saida.texto(), erro: erro.message, expirou });
    });
    filho.on("close", (codigo, sinal) => {
      clearTimeout(relogio);
      resolve({
        ok: codigo === 0 && !expirou,
        codigo,
        sinal,
        saida: saida.texto(),
        erro: expirou ? `tempo esgotado após ${Math.round(timeoutMs / 1000)}s` : null,
        expirou,
      });
    });

    if (entrada !== null && filho.stdin) {
      filho.stdin.on("error", () => {});
      filho.stdin.end(entrada);
    }
  });
}

// --- Auxiliar privilegiado -------------------------------------------------------------
// Único caminho para root. Verbos fixos; nada de nome de unidade, caminho ou comando livre.
const VERBOS_AUXILIAR = new Set([
  "servico-estado",
  "servico-iniciar",
  "servico-parar",
  "servico-reiniciar",
  "watchdog-estado",
  "watchdog-ligar",
  "watchdog-desligar",
  "journal",
  "console-reiniciar",
  "reiniciar-host",
  "portas",
  "pacotes-pendentes",
]);

function auxiliarDisponivel() {
  if (config.SEM_PRIVILEGIO) return false;
  try {
    return fs.statSync(config.AUXILIAR).isFile();
  } catch {
    return false;
  }
}

/**
 * Chama o auxiliar root. O verbo tem de estar na lista e os argumentos são validados pelo
 * chamador antes de chegar aqui; o próprio auxiliar revalida do lado privilegiado.
 */
function chamarAuxiliar(verbo, args = [], opcoes = {}) {
  if (!VERBOS_AUXILIAR.has(verbo)) {
    return Promise.resolve({ ok: false, codigo: null, sinal: null, saida: "", erro: `verbo não permitido: ${verbo}`, expirou: false });
  }
  if (!auxiliarDisponivel()) {
    return Promise.resolve({
      ok: false,
      codigo: null,
      sinal: null,
      saida: "",
      erro: config.SEM_PRIVILEGIO
        ? "operações privilegiadas desativadas neste ambiente (CONSOLE_SEM_PRIVILEGIO)"
        : `auxiliar privilegiado não instalado em ${config.AUXILIAR}`,
      expirou: false,
      indisponivel: true,
    });
  }
  return executar(config.SUDO, ["-n", config.AUXILIAR, verbo, ...validarArgumentos(args)], {
    cwd: config.RAIZ_CONSOLE,
    timeoutMs: opcoes.timeoutMs || 30_000,
    limiteBytes: opcoes.limiteBytes || 256 * 1024,
  });
}

// --- Caminhos --------------------------------------------------------------------------

/**
 * Resolve um caminho garantindo que ele fica dentro de `raiz`, inclusive depois de seguir
 * symlinks. Usado por restauração de backup e leitura de artefato: um nome vindo do navegador
 * nunca pode sair da pasta permitida.
 */
function caminhoContidoEm(raiz, nome) {
  if (typeof nome !== "string" || !nome || nome.includes("\0")) throw new Error("nome de arquivo inválido");
  if (path.isAbsolute(nome)) throw new Error("caminho absoluto não é aceito");
  if (nome.split(/[\\/]/).some((parte) => parte === "..")) throw new Error("caminho com travessia não é aceito");
  const raizReal = fs.realpathSync(raiz);
  const alvo = path.resolve(raizReal, nome);
  const relativo = path.relative(raizReal, alvo);
  if (relativo.startsWith("..") || path.isAbsolute(relativo)) throw new Error("caminho fora da pasta permitida");
  // Se o arquivo existe, o caminho real também tem de ficar dentro: bloqueia symlink apontando
  // para fora (por exemplo backups/x.db -> /etc/shadow).
  if (fs.existsSync(alvo)) {
    const alvoReal = fs.realpathSync(alvo);
    const relativoReal = path.relative(raizReal, alvoReal);
    if (relativoReal.startsWith("..") || path.isAbsolute(relativoReal)) {
      throw new Error("caminho aponta (por link) para fora da pasta permitida");
    }
    return alvoReal;
  }
  return alvo;
}

module.exports = {
  executar,
  chamarAuxiliar,
  auxiliarDisponivel,
  caminhoContidoEm,
  ambienteLimpo,
  SaidaLimitada,
  VERBOS_AUXILIAR,
};

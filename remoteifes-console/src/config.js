const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

// Root of the running payload. Installed, it is <raiz>/versoes/<versao>; in development, the
// checkout itself. Both resolve the same way because the module is always two levels below the
// payload root.
const RAIZ_CONSOLE = path.join(__dirname, "..");

function inteiro(valor, padrao, min, max) {
  if (valor === undefined || valor === null || String(valor).trim() === "") return padrao;
  if (!/^\d+$/.test(String(valor).trim())) return padrao;
  const n = Number(valor);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : padrao;
}

// The Console serves on loopback only (ARQUITETURA.md, section 4); operators on another machine use
// an SSH tunnel. Only IP literals are checked: a hostname, localhost included, resolves through
// files and DNS the Console does not control, so it is refused rather than trusted.
const LOOPBACK = new net.BlockList();
LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK.addAddress("::1", "ipv6");

function enderecoLoopback(endereco) {
  const familia = typeof endereco === "string" ? net.isIP(endereco) : 0;
  if (!familia) return false;
  return LOOPBACK.check(endereco, familia === 4 ? "ipv4" : "ipv6");
}

function booleano(valor, padrao) {
  if (valor === undefined || valor === null || String(valor).trim() === "") return padrao;
  return ["1", "true", "sim", "yes", "on"].includes(String(valor).trim().toLowerCase());
}

// Console state directory: outside the checkout (an update cannot delete it) and outside the
// application's data/ (a database restore cannot mistake it for application data).
//
// Each system has its own convention, and replacing them all with a dotfolder in home would be
// wrong on two of them. The scope (system vs user) is decided at installation and recorded; here
// only the default for a not-yet-installed program is resolved.
function estadoPadrao() {
  if (process.platform === "linux") return "/var/lib/remoteifes-console";
  if (process.platform === "win32") {
    return path.join(process.env.ProgramData || "C:\\ProgramData", "RemoteIFES Console");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "RemoteIFES Console");
  }
  return path.join(os.homedir(), ".remoteifes-console");
}

const DIR_ESTADO = process.env.CONSOLE_ESTADO_DIR ? path.resolve(process.env.CONSOLE_ESTADO_DIR) : estadoPadrao();

// RemoteIFES checkout managed by the Console. Detected from the installation when the Console runs
// from inside the repository; otherwise read from the file recorded at installation.
function detectarCheckout() {
  if (process.env.CONSOLE_CHECKOUT_DIR) return path.resolve(process.env.CONSOLE_CHECKOUT_DIR);
  const gravado = path.join(DIR_ESTADO, "checkout-dir");
  try {
    const conteudo = fs.readFileSync(gravado, "utf8").trim();
    if (conteudo) return path.resolve(conteudo);
  } catch {}
  // Installation without an associated checkout yet: the Console starts and says it needs to be
  // pointed at one. Console running from inside its own checkout (development).
  const candidato = path.join(RAIZ_CONSOLE, "..");
  if (fs.existsSync(path.join(candidato, "remoteifes-server", "package.json"))) return path.resolve(candidato);
  return path.resolve(candidato);
}

// Installation root (stable layer): contains `versoes/<v>/`, the active version pointer and the
// staging area. RAIZ_CONSOLE is the running payload; RAIZ_INSTALACAO is what the package installs
// and the updater manages. In development, running from the checkout, both coincide and the
// side-by-side layout does not exist.
function detectarRaizInstalacao() {
  if (process.env.CONSOLE_RAIZ_INSTALACAO) return path.resolve(process.env.CONSOLE_RAIZ_INSTALACAO);
  // .../<raiz>/versoes/<versao>/  ->  <raiz>
  const pai = path.dirname(RAIZ_CONSOLE);
  if (path.basename(pai) === "versoes") return path.dirname(pai);
  return RAIZ_CONSOLE;
}

const RAIZ_INSTALACAO = detectarRaizInstalacao();

const DIR_CHECKOUT = detectarCheckout();
const DIR_SERVIDOR = path.join(DIR_CHECKOUT, "remoteifes-server");
const DIR_WEB = path.join(DIR_CHECKOUT, "remoteifes-web");
const DIR_CORDOVA = path.join(DIR_CHECKOUT, "remoteifes-cordova");

// Application data directory. Mirrors the server's src/config/paths.js without loading it: the
// server module would pull the database along and create files in a process that only observes.
function lerEnvServidor() {
  const arquivo = path.join(DIR_SERVIDOR, ".env");
  const valores = {};
  let texto;
  try {
    texto = fs.readFileSync(arquivo, "utf8");
  } catch {
    return valores;
  }
  for (const linha of texto.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(linha);
    if (!m) continue;
    let valor = m[2].trim();
    if ((valor.startsWith('"') && valor.endsWith('"')) || (valor.startsWith("'") && valor.endsWith("'"))) {
      valor = valor.slice(1, -1);
    }
    valores[m[1]] = valor;
  }
  return valores;
}

/**
 * Address at which a browser can actually reach the application. The origin configured in
 * CORS_ORIGIN is the one users use; only when there is none does it fall back to loopback with the
 * configured port. Never an assumed fixed port.
 */
function urlDaAplicacao() {
  const env = lerEnvServidor();
  const origens = String(env.CORS_ORIGIN || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const origem of origens) {
    try {
      const u = new URL(origem);
      if (u.hostname && u.hostname !== "localhost" && u.hostname !== "127.0.0.1") return u.origin;
    } catch {}
  }
  return `http://127.0.0.1:${caminhosDaAplicacao().porta}/`;
}

function caminhosDaAplicacao() {
  const env = lerEnvServidor();
  const dirDados = env.REMOTEIFES_DATA_DIR
    ? path.resolve(DIR_SERVIDOR, env.REMOTEIFES_DATA_DIR)
    : path.join(DIR_SERVIDOR, "data");
  const banco = env.REMOTEIFES_DB_PATH
    ? path.resolve(DIR_SERVIDOR, env.REMOTEIFES_DB_PATH)
    : path.join(dirDados, "remoteifes.db");
  const backups = env.BACKUP_DIR ? path.resolve(DIR_SERVIDOR, env.BACKUP_DIR) : path.join(dirDados, "backups");
  // publish-android-release.js writes to REMOTEIFES_MOBILE_RELEASE_DIR and mobileAppRoutes.js reads
  // from MOBILE_APP_RELEASE_DIR: different names for the same destination. What counts is what the
  // server serves, so the read follows MOBILE_APP_RELEASE_DIR and the Console shows both.
  const releasesMobile = env.MOBILE_APP_RELEASE_DIR
    ? path.resolve(DIR_SERVIDOR, env.MOBILE_APP_RELEASE_DIR)
    : path.join(dirDados, "releases", "mobile");
  return {
    env,
    dirDados,
    banco,
    backups,
    releasesMobile,
    releasesMobilePublicacao: env.REMOTEIFES_MOBILE_RELEASE_DIR
      ? path.resolve(DIR_SERVIDOR, env.REMOTEIFES_MOBILE_RELEASE_DIR)
      : null,
    porta: inteiro(env.PORTA, 8080, 1, 65535),
    ambiente: env.NODE_ENV || "development",
    travaDeploy: path.join(dirDados, ".deploy-lock"),
    logDeploy: path.join(dirDados, "deploy.log"),
    versaoAtual: path.join(dirDados, "current-version"),
    versaoAnterior: path.join(dirDados, "previous-version"),
    falhasSaude: path.join(dirDados, ".health-falhas"),
  };
}

const config = {
  RAIZ_CONSOLE,
  RAIZ_INSTALACAO,
  DIR_ESTADO,
  DIR_CHECKOUT,
  DIR_SERVIDOR,
  DIR_WEB,
  DIR_CORDOVA,
  DIR_WEB_CONSOLE: path.join(RAIZ_CONSOLE, "web"),

  // Network: loopback only. CONSOLE_BIND chooses IPv4 or IPv6 loopback; console.js refuses to start
  // on anything else. Under socket activation systemd owns the address and the port.
  ENDERECO: process.env.CONSOLE_BIND || "127.0.0.1",
  PORTA: inteiro(process.env.CONSOLE_PORTA, 8099, 1, 65535),
  // Hosts accepted in the Host header. Closes DNS rebinding: a name resolving to 127.0.0.1 is not
  // accepted unless listed here.
  HOSTS_ACEITOS: (process.env.CONSOLE_HOSTS || "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
  ATRAS_DE_TLS: booleano(process.env.CONSOLE_ATRAS_DE_TLS, false),

  // Lifecycle: exits by itself after being idle, because the systemd socket reopens the service on
  // the next connection. Zero disables automatic exit.
  OCIOSIDADE_S: inteiro(process.env.CONSOLE_OCIOSIDADE_S, 900, 0, 86400),

  // Session and elevation.
  SESSAO_MAX_S: inteiro(process.env.CONSOLE_SESSAO_MAX_S, 8 * 3600, 300, 7 * 86400),
  SESSAO_OCIOSA_S: inteiro(process.env.CONSOLE_SESSAO_OCIOSA_S, 30 * 60, 60, 86400),
  ELEVACAO_S: inteiro(process.env.CONSOLE_ELEVACAO_S, 5 * 60, 60, 3600),
  TERMINAL_OCIOSO_S: inteiro(process.env.CONSOLE_TERMINAL_OCIOSO_S, 10 * 60, 60, 3600),
  TERMINAL_MAX_S: inteiro(process.env.CONSOLE_TERMINAL_MAX_S, 60 * 60, 300, 12 * 3600),
  TERMINAL_MAX_SESSOES: inteiro(process.env.CONSOLE_TERMINAL_MAX_SESSOES, 2, 1, 8),

  // Execution limits and retained output.
  JOB_SAIDA_MAX_BYTES: inteiro(process.env.CONSOLE_JOB_SAIDA_MAX, 256 * 1024, 4096, 8 * 1024 * 1024),
  JOB_HISTORICO_MAX: inteiro(process.env.CONSOLE_JOB_HISTORICO_MAX, 20, 3, 200),
  JOB_TIMEOUT_PADRAO_MS: inteiro(process.env.CONSOLE_JOB_TIMEOUT_MS, 20 * 60 * 1000, 5000, 6 * 3600 * 1000),

  // Privileged helper. Fixed path; never taken from a request.
  AUXILIAR: process.env.CONSOLE_AUXILIAR || "/usr/local/lib/remoteifes/console-helper.sh",
  SUDO: process.env.CONSOLE_SUDO || "sudo",
  // Disables sudo/helper use (development and tests).
  SEM_PRIVILEGIO: booleano(process.env.CONSOLE_SEM_PRIVILEGIO, process.platform !== "linux"),

  inteiro,
  booleano,
  enderecoLoopback,
  lerEnvServidor,
  caminhosDaAplicacao,
  urlDaAplicacao,
};

// Paths derived from the state directory.
config.ARQUIVO_OPERADORES = path.join(DIR_ESTADO, "operadores.json");
config.ARQUIVO_SESSOES = path.join(DIR_ESTADO, "sessoes.json");
config.ARQUIVO_TRABALHOS = path.join(DIR_ESTADO, "trabalhos.json");
config.ARQUIVO_AUDITORIA = path.join(DIR_ESTADO, "auditoria.log");
config.ARQUIVO_OBSERVACAO_REMOTA = path.join(DIR_ESTADO, "observacao-remota.json");
config.ARQUIVO_SEGREDOS = path.join(DIR_ESTADO, "segredos.json");
config.DIR_SAIDAS = path.join(DIR_ESTADO, "saidas");
// Launcher contract: address where the backend answers and the process identity proof. Kept in
// (protected) state, never in a URL, process argument or shortcut.
config.ARQUIVO_ENDERECO = path.join(DIR_ESTADO, "endereco.json");
config.ARQUIVO_BOOTSTRAP = path.join(DIR_ESTADO, "bootstrap-token");

module.exports = config;

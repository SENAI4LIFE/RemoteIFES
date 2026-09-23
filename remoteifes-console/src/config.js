const fs = require("fs");
const os = require("os");
const path = require("path");

// Raiz do payload em execução. Instalado, é <raiz>/versoes/<versao>; em desenvolvimento, o
// próprio checkout. Os dois casos resolvem igual porque o módulo está sempre dois níveis abaixo
// da raiz do payload.
const RAIZ_CONSOLE = path.join(__dirname, "..");

function inteiro(valor, padrao, min, max) {
  if (valor === undefined || valor === null || String(valor).trim() === "") return padrao;
  if (!/^\d+$/.test(String(valor).trim())) return padrao;
  const n = Number(valor);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : padrao;
}

function booleano(valor, padrao) {
  if (valor === undefined || valor === null || String(valor).trim() === "") return padrao;
  return ["1", "true", "sim", "yes", "on"].includes(String(valor).trim().toLowerCase());
}

// Diretório de estado do console: fora do checkout (uma atualização não pode apagá-lo) e fora
// do data/ da aplicação (uma restauração de banco não pode confundi-lo com dado da aplicação).
//
// Cada sistema tem convenção própria, e trocar todas por um dotfolder no home seria errado em
// dois deles. O escopo (sistema x usuário) é decidido na instalação e gravado; aqui só se
// resolve o padrão de quem ainda não instalou.
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

// Checkout do RemoteIFES que o console administra. Detectado a partir da instalação quando o
// console roda de dentro do repositório; caso contrário vem do arquivo gravado na instalação.
function detectarCheckout() {
  if (process.env.CONSOLE_CHECKOUT_DIR) return path.resolve(process.env.CONSOLE_CHECKOUT_DIR);
  const gravado = path.join(DIR_ESTADO, "checkout-dir");
  try {
    const conteudo = fs.readFileSync(gravado, "utf8").trim();
    if (conteudo) return path.resolve(conteudo);
  } catch {}
  // Instalação sem checkout associado ainda: o console sobe e diz que precisa ser apontado.
  // Console rodando de dentro do próprio checkout (desenvolvimento).
  const candidato = path.join(RAIZ_CONSOLE, "..");
  if (fs.existsSync(path.join(candidato, "remoteifes-server", "package.json"))) return path.resolve(candidato);
  return path.resolve(candidato);
}

// Raiz da instalação (camada estável): contém `versoes/<v>/`, o ponteiro da versão ativa e a
// área de estágio. RAIZ_CONSOLE é o payload em execução; RAIZ_INSTALACAO é o que o pacote
// instala e o que o atualizador administra. Em desenvolvimento, rodando do checkout, as duas
// coincidem e o layout lado a lado simplesmente não existe.
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

// Diretório de dados da aplicação. Espelha src/config/paths.js do servidor sem carregá-lo: o
// módulo do servidor arrastaria o banco junto e criaria arquivos num processo que só observa.
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
 * Endereço em que a aplicação é realmente alcançável por um navegador. A origem configurada em
 * CORS_ORIGIN é a que os usuários usam; só quando não há nenhuma é que se cai no loopback com a
 * porta configurada. Nunca uma porta fixa presumida.
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
  // publish-android-release.js grava em REMOTEIFES_MOBILE_RELEASE_DIR e mobileAppRoutes.js lê de
  // MOBILE_APP_RELEASE_DIR: nomes diferentes para o mesmo destino. O que vale é o que o servidor
  // serve, então a leitura segue MOBILE_APP_RELEASE_DIR e o console mostra os dois.
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

  // Rede: loopback por padrão. A porta só é usada quando não há ativação por socket.
  ENDERECO: process.env.CONSOLE_BIND || "127.0.0.1",
  PORTA: inteiro(process.env.CONSOLE_PORTA, 8099, 1, 65535),
  // Hosts aceitos no cabeçalho Host. Fecha DNS rebinding: um nome que resolva para 127.0.0.1
  // não serve se não estiver aqui.
  HOSTS_ACEITOS: (process.env.CONSOLE_HOSTS || "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
  ATRAS_DE_TLS: booleano(process.env.CONSOLE_ATRAS_DE_TLS, false),

  // Ciclo de vida: sai sozinho depois de ficar ocioso, porque o socket do systemd reabre o
  // serviço na próxima conexão. Zero desliga a saída automática.
  OCIOSIDADE_S: inteiro(process.env.CONSOLE_OCIOSIDADE_S, 900, 0, 86400),

  // Sessão e elevação.
  SESSAO_MAX_S: inteiro(process.env.CONSOLE_SESSAO_MAX_S, 8 * 3600, 300, 7 * 86400),
  SESSAO_OCIOSA_S: inteiro(process.env.CONSOLE_SESSAO_OCIOSA_S, 30 * 60, 60, 86400),
  ELEVACAO_S: inteiro(process.env.CONSOLE_ELEVACAO_S, 5 * 60, 60, 3600),
  TERMINAL_OCIOSO_S: inteiro(process.env.CONSOLE_TERMINAL_OCIOSO_S, 10 * 60, 60, 3600),
  TERMINAL_MAX_S: inteiro(process.env.CONSOLE_TERMINAL_MAX_S, 60 * 60, 300, 12 * 3600),
  TERMINAL_MAX_SESSOES: inteiro(process.env.CONSOLE_TERMINAL_MAX_SESSOES, 2, 1, 8),

  // Limites de execução e de saída retida.
  JOB_SAIDA_MAX_BYTES: inteiro(process.env.CONSOLE_JOB_SAIDA_MAX, 256 * 1024, 4096, 8 * 1024 * 1024),
  JOB_HISTORICO_MAX: inteiro(process.env.CONSOLE_JOB_HISTORICO_MAX, 20, 3, 200),
  JOB_TIMEOUT_PADRAO_MS: inteiro(process.env.CONSOLE_JOB_TIMEOUT_MS, 20 * 60 * 1000, 5000, 6 * 3600 * 1000),

  // Auxiliar privilegiado. Caminho fixo; nunca vem de requisição.
  AUXILIAR: process.env.CONSOLE_AUXILIAR || "/usr/local/lib/remoteifes/console-helper.sh",
  SUDO: process.env.CONSOLE_SUDO || "sudo",
  // Desliga o uso de sudo/auxiliar (desenvolvimento e teste).
  SEM_PRIVILEGIO: booleano(process.env.CONSOLE_SEM_PRIVILEGIO, process.platform !== "linux"),

  inteiro,
  booleano,
  lerEnvServidor,
  caminhosDaAplicacao,
  urlDaAplicacao,
};

// Caminhos derivados do estado.
config.ARQUIVO_OPERADORES = path.join(DIR_ESTADO, "operadores.json");
config.ARQUIVO_SESSOES = path.join(DIR_ESTADO, "sessoes.json");
config.ARQUIVO_TRABALHOS = path.join(DIR_ESTADO, "trabalhos.json");
config.ARQUIVO_AUDITORIA = path.join(DIR_ESTADO, "auditoria.log");
config.ARQUIVO_OBSERVACAO_REMOTA = path.join(DIR_ESTADO, "observacao-remota.json");
config.ARQUIVO_SEGREDOS = path.join(DIR_ESTADO, "segredos.json");
config.DIR_SAIDAS = path.join(DIR_ESTADO, "saidas");
// Contrato do lançador: endereço em que o backend atende e prova de identidade do processo.
// Fica no estado (protegido), nunca em URL, argumento de processo ou atalho.
config.ARQUIVO_ENDERECO = path.join(DIR_ESTADO, "endereco.json");
config.ARQUIVO_BOOTSTRAP = path.join(DIR_ESTADO, "bootstrap-token");

module.exports = config;

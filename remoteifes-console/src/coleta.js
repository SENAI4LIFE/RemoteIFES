const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const config = require("./config");
const processos = require("./processos");
const trava = require("./trava");
const plataforma = require("./plataforma");

// Host and application observation.
//
// Non-negotiable rule: this module does **not** load `src/app.js`, `src/config/database.js` or any
// server service. Those modules create the data directory, open SQLite and run `criarSchema()` and
// `popularBanco()` on require; a passive diagnostic process importing them would create and migrate
// the database from another process. Only these sources are used:
//  - /health over HTTP on loopback (cheap, and the source of truth for the running process);
//  - on-demand, read-only access to the SQLite file, writing nothing;
//  - state files the scripts already write;
//  - operating system observations.
// What cannot be observed becomes `null`/"unknown", never zero.

const DESCONHECIDO = null;

function lerTexto(arquivo) {
  try {
    return fs.readFileSync(arquivo, "utf8").trim();
  } catch {
    return null;
  }
}

// --- Application --------------------------------------------------------------------------

function consultarSaude({ timeoutMs = 3000 } = {}) {
  const app = config.caminhosDaAplicacao();
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port: app.porta, path: "/health", method: "GET", timeout: timeoutMs },
      (res) => {
        let corpo = "";
        res.setEncoding("utf8");
        res.on("data", (d) => {
          if (corpo.length < 8192) corpo += d;
        });
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(corpo);
          } catch {}
          resolve({
            respondeu: true,
            status: res.statusCode,
            ok: res.statusCode === 200 && json && json.ok === true,
            banco: json ? json.banco : DESCONHECIDO,
            ambiente: json ? json.ambiente : DESCONHECIDO,
            commit: json && typeof json.commit === "string" ? json.commit : DESCONHECIDO,
            uptimeSegundos: json && Number.isFinite(json.uptimeSegundos) ? json.uptimeSegundos : DESCONHECIDO,
            porta: app.porta,
          });
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ respondeu: false, erro: `sem resposta em ${timeoutMs} ms`, porta: app.porta });
    });
    req.on("error", (erro) => resolve({ respondeu: false, erro: erro.code || erro.message, porta: app.porta }));
    req.end();
  });
}

/**
 * Opportunistic read-only database access. Used only when the operator requests the full panel or a
 * prerequisite check: never in polling.
 */
function espiarBanco({ permitirLeitura = null } = {}) {
  const app = config.caminhosDaAplicacao();
  const resultado = { existe: false, bytes: DESCONHECIDO, wal: false, lido: false, erro: null };
  let stat;
  try {
    stat = fs.statSync(app.banco);
  } catch {
    return resultado;
  }
  resultado.existe = true;
  resultado.bytes = stat.size;
  resultado.modificadoEm = stat.mtime.toISOString();
  resultado.wal = fs.existsSync(`${app.banco}-wal`);
  const temShm = fs.existsSync(`${app.banco}-shm`);

  // Opening a WAL database creates the -shm/-wal files when missing, even with readOnly. A process
  // that only observes must leave no trace in the application's data directory, so the read happens
  // only when someone already has the database open (-shm exists) or when the caller confirmed the
  // application is running. Otherwise only file metadata is reported, with the reason stated.
  const podeAbrir = permitirLeitura === true || (permitirLeitura === null && temShm);
  if (!podeAbrir) {
    resultado.erro =
      "leitura do conteúdo não realizada: com a aplicação parada, abrir o banco criaria arquivos auxiliares (-shm/-wal) no diretório de dados";
    return resultado;
  }

  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch (erro) {
    resultado.erro = "node:sqlite indisponível neste runtime";
    return resultado;
  }
  let conexao;
  try {
    conexao = new DatabaseSync(app.banco, { readOnly: true });
    const contar = (sql) => {
      try {
        const linha = conexao.prepare(sql).get();
        const valor = linha ? Object.values(linha)[0] : null;
        return Number.isFinite(Number(valor)) ? Number(valor) : DESCONHECIDO;
      } catch {
        return DESCONHECIDO;
      }
    };
    resultado.lido = true;
    resultado.usuarios = contar("SELECT COUNT(*) n FROM usuarios");
    resultado.salas = contar("SELECT COUNT(*) n FROM salas");
    resultado.salasComMac = contar("SELECT COUNT(*) n FROM salas WHERE mac IS NOT NULL AND mac <> ''");
    resultado.agendamentosAtivos = contar("SELECT COUNT(*) n FROM agendamentos WHERE ativo = 1");
    resultado.sessoesAbertas = contar("SELECT COUNT(*) n FROM sessoes WHERE logout IS NULL");
    resultado.schemaVersao = contar("PRAGMA user_version");
  } catch (erro) {
    resultado.erro = erro.message;
  } finally {
    try {
      if (conexao) conexao.close();
    } catch {}
  }
  return resultado;
}

// --- Service, watchdog and logs (through the platform adapter) ---------------------------
//
// `src/plataforma/` decides how to query the service, watchdog and logs, and returns an **explicit
// state** instead of a boolean, so "does not exist on this system" is never confused with
// "installed and stopped".

async function estadoDoServico() {
  const r = await plataforma.estadoDoServico();
  // The UI and the existing tests speak of `suportado`; the adapter speaks of states.
  return { ...r, suportado: r.disponivel, motivo: r.motivo };
}

async function estadoDoWatchdog() {
  const r = await plataforma.estadoDoWatchdog();
  return {
    falhasConsecutivas: r.falhasConsecutivas ?? 0,
    limite: r.limite ?? 3,
    intervaloMinutos: r.intervaloMinutos ?? 2,
    ...r,
    suportado: r.disponivel,
  };
}

async function lerJournal({ unidade = "aplicacao", linhas = 200, prioridade = null } = {}) {
  const r = await plataforma.lerRegistros({ unidade, linhas, prioridade });
  return {
    ok: !!r.disponivel,
    texto: r.texto || "",
    fonte: r.fonte || null,
    observacao: r.observacao || null,
    estado: r.estado,
    erro: r.disponivel ? null : r.motivo || "não foi possível ler os registros",
  };
}

// --- Host ---------------------------------------------------------------------------------

async function coletarHost({ completo = false } = {}) {
  const app = config.caminhosDaAplicacao();
  const memoria = plataforma.memoria();
  const carga = os.loadavg();
  const host = {
    hostname: os.hostname(),
    plataforma: `${os.type()} ${os.release()}`,
    rotuloPlataforma: plataforma.rotulo,
    arquitetura: os.arch(),
    cpus: os.cpus().length,
    modelo: lerTexto("/proc/device-tree/model") || (os.cpus()[0] && os.cpus()[0].model) || DESCONHECIDO,
    uptimeSegundos: Math.round(os.uptime()),
    cargaMedia: { um: carga[0], cinco: carga[1], quinze: carga[2] },
    memoria,
    temperaturaC: plataforma.temperaturaC(),
    node: process.version,
    consoleRss: process.memoryUsage().rss,
    coletadoEm: new Date().toISOString(),
  };
  if (!completo) return host;
  const [disco, throttle, relogio, pacotes, arquiteturaDetalhada] = await Promise.all([
    plataforma.disco([...new Set([app.dirDados, config.DIR_CHECKOUT, config.DIR_ESTADO])]),
    plataforma.throttle(),
    plataforma.relogio(),
    plataforma.pacotesPendentes(),
    plataforma.classificarArquitetura(),
  ]);
  return { ...host, disco, throttle, relogio, pacotes, arquiteturaDetalhada };
}

async function lerDisco(caminhos) {
  return plataforma.disco(caminhos);
}

// --- Backups -----------------------------------------------------------------------------

const RE_BACKUP = /^remoteifes-\d{8}-\d{6}-[0-9a-f]{6}(?:-[a-z0-9-]+)?\.db$/;
const RE_PRE_RESTAURACAO = /^pre-restauracao-\d{8}-\d{6}-[0-9a-f]{6}\.db$/;

function listarBackups() {
  const app = config.caminhosDaAplicacao();
  let nomes;
  try {
    nomes = fs.readdirSync(app.backups);
  } catch (erro) {
    return { dir: app.backups, disponivel: false, motivo: erro.code === "ENOENT" ? "pasta de backups ainda não existe" : erro.message, itens: [] };
  }
  const mapear = (regex) =>
    nomes
      .filter((n) => regex.test(n))
      .map((nome) => {
        const info = fs.statSync(path.join(app.backups, nome));
        return { nome, bytes: info.size, modificadoEm: info.mtime.toISOString(), mtimeMs: info.mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .map(({ mtimeMs, ...resto }) => resto);
  const itens = mapear(RE_BACKUP);
  return {
    dir: app.backups,
    disponivel: true,
    itens,
    preRestauracao: mapear(RE_PRE_RESTAURACAO),
    quarentena: nomes.filter((n) => n.includes(".corrompido-")),
    ultimo: itens[0] || null,
  };
}

function quarentenaDoBanco() {
  const app = config.caminhosDaAplicacao();
  let nomes = [];
  try {
    nomes = fs.readdirSync(path.dirname(app.banco));
  } catch {
    return [];
  }
  const base = path.basename(app.banco);
  return nomes.filter((n) => n.startsWith(`${base}.corrompido-`));
}

// --- Deployment state recorded by the scripts --------------------------------------

function historicoDeploy(limite = 15) {
  const app = config.caminhosDaAplicacao();
  const texto = lerTexto(app.logDeploy);
  if (!texto) return [];
  return texto
    .split("\n")
    .filter(Boolean)
    .slice(-limite)
    .reverse()
    .map((linha) => {
      const m = /^(\S+)\s+(deploy|rollback)\s+(\S+)\s+->\s+(\S+)\s+(.*)$/.exec(linha);
      if (!m) return { bruto: linha };
      const detalhe = m[5];
      return {
        em: m[1],
        tipo: m[2],
        de: m[3],
        para: m[4],
        sucesso: !/FALHOU/.test(detalhe),
        detalhe,
      };
    });
}

function versoesRegistradas() {
  const app = config.caminhosDaAplicacao();
  return {
    atual: lerTexto(app.versaoAtual),
    anterior: lerTexto(app.versaoAnterior),
  };
}

function versoesDeclaradas() {
  const ler = (arquivo, extrair) => {
    const texto = lerTexto(arquivo);
    if (!texto) return DESCONHECIDO;
    try {
      return extrair(texto);
    } catch {
      return DESCONHECIDO;
    }
  };
  return {
    servidor: ler(path.join(config.DIR_SERVIDOR, "package.json"), (t) => JSON.parse(t).version),
    frontend: ler(path.join(config.DIR_WEB, "version.json"), (t) => JSON.parse(t).version),
    cordova: ler(path.join(config.DIR_CORDOVA, "package.json"), (t) => JSON.parse(t).version),
    android: (() => {
      const texto = lerTexto(path.join(config.DIR_CORDOVA, "config.xml"));
      if (!texto) return DESCONHECIDO;
      const nome = /\bversion="([^"]+)"/.exec(texto);
      const codigo = /android-versionCode="([^"]+)"/.exec(texto);
      return { versionName: nome ? nome[1] : DESCONHECIDO, versionCode: codigo ? codigo[1] : DESCONHECIDO };
    })(),
    firmware: (() => {
      const texto = lerTexto(path.join(config.DIR_CHECKOUT, "remoteifes-esp32", "platformio.ini"));
      if (!texto) return DESCONHECIDO;
      const m = /-DFW_VERSAO=\\"(\d+\.\d+\.\d+)\\"/.exec(texto);
      return m ? m[1] : DESCONHECIDO;
    })(),
  };
}

// --- Dashboard --------------------------------------------------------------------------------

async function painel({ completo = false } = {}) {
  const [saude, servico, watchdog, host] = await Promise.all([
    consultarSaude(),
    estadoDoServico(),
    estadoDoWatchdog(),
    coletarHost({ completo }),
  ]);
  const backups = listarBackups();
  return {
    coletadoEm: new Date().toISOString(),
    aplicacao: saude,
    servico,
    watchdog,
    host,
    backups: {
      dir: backups.dir,
      disponivel: backups.disponivel,
      motivo: backups.motivo || null,
      total: backups.itens.length,
      ultimo: backups.ultimo,
      quarentena: backups.quarentena ? backups.quarentena.length : 0,
    },
    bancoQuarentenado: quarentenaDoBanco().length,
    versoes: versoesDeclaradas(),
    versoesRegistradas: versoesRegistradas(),
    manutencao: trava.situacao(),
  };
}

module.exports = {
  consultarSaude,
  espiarBanco,
  estadoDoServico,
  estadoDoWatchdog,
  lerJournal,
  coletarHost,
  lerDisco,
  listarBackups,
  quarentenaDoBanco,
  historicoDeploy,
  versoesRegistradas,
  versoesDeclaradas,
  painel,
  lerTexto,
};

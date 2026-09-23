const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const config = require("./config");
const processos = require("./processos");
const trava = require("./trava");

// Observação do host e da aplicação.
//
// Regra inegociável: este módulo **não** carrega `src/app.js`, `src/config/database.js` nem
// qualquer serviço do servidor. Aqueles módulos criam o diretório de dados, abrem o SQLite,
// rodam `criarSchema()` e `popularBanco()` já no require — um "processo passivo de diagnóstico"
// que os importasse criaria e migraria o banco de outro processo. Aqui só há:
//  - /health por HTTP no loopback (barato e é a fonte de verdade do processo em execução);
//  - leitura somente-leitura e sob demanda do arquivo SQLite, sem escrever nada;
//  - arquivos de estado que os scripts já gravam;
//  - observações do sistema operacional.
// O que não puder ser observado vira `null`/"desconhecido", nunca zero.

const DESCONHECIDO = null;

function lerTexto(arquivo) {
  try {
    return fs.readFileSync(arquivo, "utf8").trim();
  } catch {
    return null;
  }
}

// --- Aplicação --------------------------------------------------------------------------

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
 * Leitura oportunista e somente-leitura do banco. Usada só quando o operador pede o painel
 * completo ou uma checagem de pré-requisitos: nunca em polling.
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

  // Abrir um banco em modo WAL cria os arquivos -shm/-wal quando eles não existem, mesmo com
  // readOnly. Um processo que só observa não pode deixar rastro no diretório de dados da
  // aplicação, então a leitura só acontece quando alguém já tem o banco aberto (o -shm existe)
  // ou quando o chamador confirmou que a aplicação está no ar. Caso contrário ficam apenas os
  // metadados do arquivo, com o motivo dito em voz alta.
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

// --- Serviço systemd ---------------------------------------------------------------------

async function estadoDoServico() {
  if (config.SEM_PRIVILEGIO && !processos.auxiliarDisponivel()) {
    return { suportado: false, motivo: "systemd não disponível neste ambiente" };
  }
  const r = await processos.chamarAuxiliar("servico-estado", [], { timeoutMs: 10_000 });
  if (!r.ok) {
    return { suportado: false, motivo: r.erro || "não foi possível consultar o systemd", indisponivel: !!r.indisponivel };
  }
  const campos = {};
  for (const linha of r.saida.split("\n")) {
    const [chave, ...resto] = linha.split("=");
    if (chave && resto.length) campos[chave.trim()] = resto.join("=").trim();
  }
  const ativo = campos.ActiveState === "active";
  const habilitado = campos.UnitFileState === "enabled";
  return {
    suportado: true,
    ativo,
    habilitado,
    estadoAtivo: campos.ActiveState || DESCONHECIDO,
    subEstado: campos.SubState || DESCONHECIDO,
    arquivoUnidade: campos.UnitFileState || DESCONHECIDO,
    desde: campos.ActiveEnterTimestamp || DESCONHECIDO,
    resultadoUltimaExecucao: campos.Result || DESCONHECIDO,
    reinicios: config.inteiro(campos.NRestarts, DESCONHECIDO, 0, 1e9),
    pid: config.inteiro(campos.MainPID, DESCONHECIDO, 0, 1e9),
    memoriaBytes: config.inteiro(campos.MemoryCurrent, DESCONHECIDO, 0, Number.MAX_SAFE_INTEGER),
    watchdogTimer: campos.TimerState || DESCONHECIDO,
  };
}

async function estadoDoWatchdog() {
  const r = await processos.chamarAuxiliar("watchdog-estado", [], { timeoutMs: 10_000 });
  const app = config.caminhosDaAplicacao();
  const falhas = lerTexto(app.falhasSaude);
  const base = {
    falhasConsecutivas: falhas === null ? 0 : config.inteiro(falhas, 0, 0, 1000),
    limite: 3,
    intervaloMinutos: 2,
  };
  if (!r.ok) return { ...base, suportado: false, motivo: r.erro };
  const campos = {};
  for (const linha of r.saida.split("\n")) {
    const [chave, ...resto] = linha.split("=");
    if (chave && resto.length) campos[chave.trim()] = resto.join("=").trim();
  }
  return {
    ...base,
    suportado: true,
    ativo: campos.ActiveState === "active",
    habilitado: campos.UnitFileState === "enabled",
    proximaExecucao: campos.NextElapseUSecRealtime || DESCONHECIDO,
  };
}

async function lerJournal({ unidade = "aplicacao", linhas = 200, prioridade = null } = {}) {
  const permitidas = { aplicacao: "app", saude: "health", console: "console", recuperacao: "recover" };
  if (!permitidas[unidade]) throw new Error("unidade de log não permitida");
  const n = Math.max(10, Math.min(Number(linhas) || 200, 2000));
  const args = [permitidas[unidade], String(n)];
  if (prioridade) {
    if (!/^[0-7]$/.test(String(prioridade))) throw new Error("prioridade inválida");
    args.push(String(prioridade));
  }
  const r = await processos.chamarAuxiliar("journal", args, { timeoutMs: 20_000, limiteBytes: 512 * 1024 });
  return { ok: r.ok, texto: r.saida || "", erro: r.ok ? null : r.erro || "não foi possível ler o journal" };
}

// --- Host --------------------------------------------------------------------------------

function lerMemoria() {
  // /proc/meminfo dá "disponível" de verdade; os.freemem() ignora cache recuperável e faz um
  // Pi saudável parecer sem memória.
  const texto = lerTexto("/proc/meminfo");
  if (!texto) {
    return { totalBytes: os.totalmem(), disponivelBytes: os.freemem(), fonte: "os" };
  }
  const campos = {};
  for (const linha of texto.split("\n")) {
    const m = /^(\w+):\s+(\d+)\s*kB$/.exec(linha.trim());
    if (m) campos[m[1]] = Number(m[2]) * 1024;
  }
  return {
    totalBytes: campos.MemTotal ?? os.totalmem(),
    disponivelBytes: campos.MemAvailable ?? campos.MemFree ?? os.freemem(),
    swapTotalBytes: campos.SwapTotal ?? DESCONHECIDO,
    swapLivreBytes: campos.SwapFree ?? DESCONHECIDO,
    fonte: "/proc/meminfo",
  };
}

function lerTemperatura() {
  const bruto = lerTexto("/sys/class/thermal/thermal_zone0/temp");
  if (!bruto || !/^\d+$/.test(bruto)) return DESCONHECIDO;
  const valor = Number(bruto);
  return Math.round((valor > 1000 ? valor / 1000 : valor) * 10) / 10;
}

async function lerThrottle() {
  // vcgencmd só existe no Raspberry Pi OS; ausência é "não suportado", não "tudo bem".
  const r = await processos.executar("vcgencmd", ["get_throttled"], { timeoutMs: 4000 });
  if (!r.ok) return { suportado: false };
  const m = /throttled=0x([0-9a-fA-F]+)/.exec(r.saida || "");
  if (!m) return { suportado: false };
  const bits = Number.parseInt(m[1], 16);
  return {
    suportado: true,
    bruto: `0x${m[1]}`,
    subtensaoAgora: !!(bits & 0x1),
    limiteFrequenciaAgora: !!(bits & 0x2),
    throttlingAgora: !!(bits & 0x4),
    subtensaoDesdeOBoot: !!(bits & 0x10000),
    throttlingDesdeOBoot: !!(bits & 0x40000),
  };
}

async function lerDisco(caminhos) {
  if (process.platform === "win32") {
    return caminhos.map((c) => ({ caminho: c, suportado: false }));
  }
  const saida = [];
  for (const caminho of caminhos) {
    const r = await processos.executar("df", ["-P", "-k", caminho], { timeoutMs: 6000 });
    if (!r.ok) {
      saida.push({ caminho, suportado: false, erro: r.erro || "df falhou" });
      continue;
    }
    const linha = r.saida.trim().split("\n").pop();
    const partes = linha.trim().split(/\s+/);
    if (partes.length < 6) {
      saida.push({ caminho, suportado: false });
      continue;
    }
    const total = Number(partes[1]) * 1024;
    const usado = Number(partes[2]) * 1024;
    const livre = Number(partes[3]) * 1024;
    saida.push({
      caminho,
      dispositivo: partes[0],
      totalBytes: total,
      usadoBytes: usado,
      livreBytes: livre,
      usoPercentual: total > 0 ? Math.round((usado / total) * 100) : DESCONHECIDO,
      montagem: partes[5],
      suportado: true,
    });
  }
  return saida;
}

async function lerPacotesPendentes() {
  // Apenas a contagem, a partir do cache que o sistema já tem. O auxiliar nunca roda
  // `apt update` (rede e I/O num cartão SD) nem instala nada: alterar pacote do sistema
  // continua sendo decisão humana, no terminal.
  const r = await processos.chamarAuxiliar("pacotes-pendentes", [], { timeoutMs: 20_000 });
  if (!r.ok) return { suportado: false, motivo: r.erro };
  const texto = (r.saida || "").trim();
  if (texto === "indisponivel") return { suportado: false, motivo: "gerenciador de pacotes não reconhecido" };
  if (!/^\d+$/.test(texto)) return { suportado: false, motivo: "resposta inesperada" };
  return {
    suportado: true,
    pendentes: Number(texto),
    observacao: "Contagem do cache local, sem consultar repositórios. Instalar atualizações do sistema é operação de terminal.",
  };
}

async function lerRelogio() {
  const r = await processos.executar("timedatectl", ["show"], { timeoutMs: 5000 });
  const base = { agora: new Date().toISOString(), fusoNode: Intl.DateTimeFormat().resolvedOptions().timeZone };
  if (!r.ok) return { ...base, sincronizado: DESCONHECIDO, suportado: false };
  const campos = {};
  for (const linha of r.saida.split("\n")) {
    const [chave, ...resto] = linha.split("=");
    if (chave && resto.length) campos[chave.trim()] = resto.join("=").trim();
  }
  return {
    ...base,
    suportado: true,
    sincronizado: campos.NTPSynchronized === "yes",
    ntpAtivo: campos.NTP === "yes",
    fusoHorario: campos.Timezone || base.fusoNode,
  };
}

async function coletarHost({ completo = false } = {}) {
  const app = config.caminhosDaAplicacao();
  const memoria = lerMemoria();
  const carga = os.loadavg();
  const host = {
    hostname: os.hostname(),
    plataforma: `${os.type()} ${os.release()}`,
    arquitetura: os.arch(),
    cpus: os.cpus().length,
    modelo: lerTexto("/proc/device-tree/model") || (os.cpus()[0] && os.cpus()[0].model) || DESCONHECIDO,
    uptimeSegundos: Math.round(os.uptime()),
    cargaMedia: { um: carga[0], cinco: carga[1], quinze: carga[2] },
    memoria,
    temperaturaC: lerTemperatura(),
    node: process.version,
    consoleRss: process.memoryUsage().rss,
    coletadoEm: new Date().toISOString(),
  };
  if (!completo) return host;
  const [disco, throttle, relogio, pacotes] = await Promise.all([
    lerDisco([...new Set([app.dirDados, config.DIR_CHECKOUT, config.DIR_ESTADO, "/"])]),
    lerThrottle(),
    lerRelogio(),
    lerPacotesPendentes(),
  ]);
  return { ...host, disco, throttle, relogio, pacotes };
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

// --- Estado de implantação registrado pelos scripts --------------------------------------

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

// --- Painel --------------------------------------------------------------------------------

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
  lerPacotesPendentes,
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

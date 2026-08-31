const fs = require("fs");
const path = require("path");
const os = require("os");
const db = require("../config/database");
const logger = require("../utils/logger");
const { CAMINHO_DB, DIR_DADOS } = require("../config/paths");
const notificacoesService = require("./notificacoesService");

const INICIO_PROCESSO = Date.now();
const RECONEXAO_FLAP_MS = 60 * 1000;
const DEDUP_NOTIFICACAO_MS = 6 * 60 * 60 * 1000;
const DISCO_LIVRE_ALERTA_PCT = 10;
const DISCO_LIVRE_CRITICO_PCT = 5;
const DISCO_LIVRE_CRITICO_BYTES = 512 * 1024 * 1024;

const contadores = {
  comandoFalha: 0,
  telemetriaFalha: 0,
  otaFalha: 0,
  credencialFalha: 0,
  reconexaoAnormal: 0,
  schedulerFalha: 0,
  bancoFalha: 0,
};
const ultimaOcorrencia = {};
const ultimaConexaoPorSala = new Map();

function registrar(evento, detalhe) {
  if (!(evento in contadores)) contadores[evento] = 0;
  contadores[evento] += 1;
  ultimaOcorrencia[evento] = new Date().toISOString();
  if (detalhe) logger.warn("monitoramento-evento", { evento, ...detalhe });
}

function registrarConexaoDispositivo(sala) {
  const agora = Date.now();
  const anterior = ultimaConexaoPorSala.get(sala);
  ultimaConexaoPorSala.set(sala, agora);
  if (anterior && agora - anterior < RECONEXAO_FLAP_MS) {
    registrar("reconexaoAnormal", { sala });
  }
}

function tamanhoArquivo(caminho) {
  try {
    return fs.statSync(caminho).size;
  } catch {
    return 0;
  }
}

function coletarBanco() {
  const inicio = process.hrtime.bigint();
  let ok = true;
  try {
    db.prepare("SELECT 1 AS ok").get();
  } catch (erro) {
    ok = false;
    logger.error("monitoramento-banco-indisponivel", { mensagem: erro && erro.message });
  }
  const respostaMs = Number(process.hrtime.bigint() - inicio) / 1e6;
  const emMemoria = CAMINHO_DB === ":memory:";
  let paginas = {};
  let tabelas = {};
  if (ok) {
    try {
      const pageSize = Number(db.prepare("PRAGMA page_size").get().page_size);
      const pageCount = Number(db.prepare("PRAGMA page_count").get().page_count);
      const freePages = Number(db.prepare("PRAGMA freelist_count").get().freelist_count);
      paginas = { pageSize, pageCount, freePages, reutilizavelBytes: freePages * pageSize };
      tabelas = require("./retencaoService").estatisticasTabelas();
    } catch (erro) {
      logger.warn("monitoramento-banco-estatisticas-falhou", { mensagem: erro.message });
    }
  }
  return {
    ok,
    respostaMs: Math.round(respostaMs * 100) / 100,
    caminho: emMemoria ? ":memory:" : CAMINHO_DB,
    arquivoBytes: emMemoria ? 0 : tamanhoArquivo(CAMINHO_DB),
    walBytes: emMemoria ? 0 : tamanhoArquivo(`${CAMINHO_DB}-wal`),
    ...paginas,
    tabelas,
  };
}

function coletarArmazenamento() {
  const alvo = CAMINHO_DB === ":memory:" ? os.tmpdir() : DIR_DADOS;
  try {
    const st = fs.statfsSync(alvo);
    const totalBytes = st.blocks * st.bsize;
    const livreBytes = st.bavail * st.bsize;
    const avaliacao = avaliarEspaco(totalBytes, livreBytes);
    return {
      caminho: alvo,
      totalBytes,
      livreBytes,
      ...avaliacao,
    };
  } catch (erro) {
    return { caminho: alvo, erro: erro.message };
  }
}

function avaliarEspaco(totalBytes, livreBytes) {
  const livrePercent = totalBytes > 0 ? Math.round((livreBytes / totalBytes) * 1000) / 10 : null;
  return {
    livrePercent,
    alerta: livrePercent !== null && livrePercent < DISCO_LIVRE_ALERTA_PCT,
    critico: (livrePercent !== null && livrePercent < DISCO_LIVRE_CRITICO_PCT) || livreBytes < DISCO_LIVRE_CRITICO_BYTES,
  };
}

function coletarBackup() {
  let backupService;
  try {
    backupService = require("./backupService");
  } catch {
    return { disponivel: false };
  }
  const automatico = String(
    process.env.BACKUP_AUTOMATICO ?? (process.env.NODE_ENV === "production" ? "true" : "false")
  ).toLowerCase() === "true";
  const intervaloHoras = backupService.normalizarInteiro(process.env.BACKUP_INTERVALO_HORAS, 24, 1, 8760);
  let backups = [];
  try {
    backups = backupService.listarBackups();
  } catch {
    backups = [];
  }
  const ultimo = backups[0] || null;
  const idadeHoras = ultimo
    ? Math.round(((Date.now() - new Date(ultimo.modificadoEm).getTime()) / 3_600_000) * 10) / 10
    : null;
  return {
    automatico,
    intervaloHoras,
    quantidade: backups.length,
    ultimo: ultimo ? ultimo.nome : null,
    idadeHoras,
    alerta: automatico && (idadeHoras === null || idadeHoras > intervaloHoras * 2),
  };
}

function coletarEsp32() {
  const deviceHub = require("./deviceHub");
  const otaService = require("./otaService");
  const comMac = db.prepare("SELECT COUNT(*) n FROM salas WHERE mac IS NOT NULL").get().n;
  const online = db.prepare("SELECT COUNT(*) n FROM salas WHERE mac IS NOT NULL AND online = 1").get().n;
  const conectadosWs = Object.keys(deviceHub.listarEstados()).length;

  const reconexoes1h = db.prepare(`
    SELECT sala, COUNT(*) n FROM esp_eventos
    WHERE status = 'online' AND criadoEm >= datetime('now', '-1 hour')
    GROUP BY sala
  `).all();
  const totalReconexoes1h = reconexoes1h.reduce((acc, r) => acc + r.n, 0);
  const salasInstaveis = reconexoes1h.filter((r) => r.n > 3).map((r) => ({ sala: r.sala, reconexoes: r.n }));

  const otaAtivos = Object.values(otaService.listarEstados())
    .filter((e) => ["ofertado", "baixando", "gravado", "reiniciando"].includes(e.fase)).length;
  const otaFalhas = Object.values(otaService.listarEstados()).filter((e) => e.fase === "falhou").length;

  return {
    comMac,
    online,
    offlineInesperado: comMac - online,
    conectadosWs,
    reconexoesAnormais1h: totalReconexoes1h,
    salasInstaveis,
    otaEmAndamento: otaAtivos,
    otaComFalha: otaFalhas,
  };
}

function coletarCredenciais() {
  try {
    return require("./esp32CredenciaisService").resumoMigracao();
  } catch {
    return null;
  }
}

function coletar() {
  const banco = coletarBanco();
  if (!banco.ok) registrar("bancoFalha");
  const armazenamento = coletarArmazenamento();
  const backup = coletarBackup();
  const esp32 = coletarEsp32();
  const credenciais = coletarCredenciais();

  const esp32OfflineUlt24h = db.prepare(`
    SELECT COUNT(*) n FROM esp_eventos WHERE status = 'offline' AND criadoEm >= datetime('now', '-1 day')
  `).get().n;

  const alertas = [];
  if (!banco.ok) alertas.push("banco de dados não respondeu");
  if (armazenamento.alerta) alertas.push(`disco com apenas ${armazenamento.livrePercent}% livres em ${armazenamento.caminho}`);
  if (backup.alerta) {
    alertas.push(backup.idadeHoras === null
      ? "backup automático ligado, mas nenhum backup foi encontrado"
      : `último backup tem ${backup.idadeHoras}h (intervalo configurado: ${backup.intervaloHoras}h)`);
  }
  for (const s of esp32.salasInstaveis) {
    alertas.push(`sala ${s.sala}: ${s.reconexoes} reconexões de ESP32 na última hora`);
  }
  if (esp32.otaComFalha > 0) alertas.push(`${esp32.otaComFalha} atualização(ões) de firmware com falha pendente(s) de revisão`);
  for (const [evento, total] of Object.entries(contadores)) {
    if (total > 0 && ["schedulerFalha", "telemetriaFalha", "comandoFalha"].includes(evento)) {
      alertas.push(`${evento}: ${total} desde a inicialização (último em ${ultimaOcorrencia[evento]})`);
    }
  }

  const mem = process.memoryUsage();
  return {
    geradoEm: new Date().toISOString(),
    servico: {
      uptimeSegundos: Math.round((Date.now() - INICIO_PROCESSO) / 1000),
      pid: process.pid,
      nodeVersao: process.version,
      plataforma: `${os.type()} ${os.release()}`,
      ambiente: process.env.NODE_ENV || "development",
      memoriaRssMB: Math.round((mem.rss / 1_048_576) * 10) / 10,
      cargaMedia1min: Math.round(os.loadavg()[0] * 100) / 100,
    },
    banco,
    armazenamento,
    backup,
    esp32: { ...esp32, offlineUlt24h: esp32OfflineUlt24h },
    credenciais,
    falhas: { contadores: { ...contadores }, ultimaOcorrencia: { ...ultimaOcorrencia } },
    alertas,
  };
}

function notificacaoRecenteExiste(mensagem) {
  const limite = new Date(Date.now() - DEDUP_NOTIFICACAO_MS).toISOString().slice(0, 19).replace("T", " ");
  const recentes = db.prepare(`
    SELECT mensagem FROM notificacoes
    WHERE tipo = 'monitoramento' AND criadoEm >= ?
  `).all(limite);
  const chave = chaveAlerta(mensagem);
  return recentes.some((linha) => chaveAlerta(linha.mensagem) === chave);
}

function chaveAlerta(mensagem) {
  if (mensagem.startsWith("backup automático") || mensagem.startsWith("último backup")) return "backup";
  if (mensagem.startsWith("disco com apenas ")) return `disco:${mensagem.split(" livres em ")[1] || "local"}`;
  const sala = mensagem.match(/^sala ([^:]+): .* reconexões/);
  if (sala) return `reconexoes:${sala[1]}`;
  if (/atualização\(ões\) de firmware com falha/.test(mensagem)) return "ota-falha";
  const falha = mensagem.match(/^(schedulerFalha|telemetriaFalha|comandoFalha):/);
  if (falha) return `falha:${falha[1]}`;
  return mensagem;
}

function avaliar() {
  try {
    const estado = coletar();
    if (estado.armazenamento.critico) require("./retencaoService").executarLimpezaRetencao();
    const { alertas } = estado;
    for (const mensagem of alertas) {
      if (!notificacaoRecenteExiste(mensagem)) {
        notificacoesService.criar({ tipo: "monitoramento", mensagem });
      }
    }
  } catch (erro) {
    logger.warn("monitoramento-avaliar-falhou", { mensagem: erro.message });
  }
}

module.exports = { registrar, registrarConexaoDispositivo, coletar, avaliar, avaliarEspaco };

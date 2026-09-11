const fs = require("fs");
const path = require("path");
const os = require("os");
const db = require("../config/database");
const logger = require("../utils/logger");
const { CAMINHO_DB, DIR_DADOS } = require("../config/paths");
const notificacoesService = require("./notificacoesService");

const INICIO_PROCESSO = Date.now();
const INICIO_PROCESSO_SQL = new Date(INICIO_PROCESSO).toISOString().slice(0, 19).replace("T", " ");
const RECONEXAO_FLAP_MS = 60 * 1000;
const DEDUP_NOTIFICACAO_MS = 6 * 60 * 60 * 1000;
const DISCO_LIVRE_ALERTA_PCT = 10;
const DISCO_LIVRE_CRITICO_PCT = 5;
const DISCO_LIVRE_CRITICO_BYTES = 512 * 1024 * 1024;

const AMOSTRAGEM_SEGUNDOS = 60;
const RETENCAO_AMOSTRAS_HORAS = 48;
const RETENCAO_HORAS_DIAS = 30;
const CACHE_HISTORICO_MS = 30 * 1000;
const NUCLEOS = Math.max(1, typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length);

const MEDIDAS = [
  { coluna: "rssMB", extras: ["max"] },
  { coluna: "cpuPercent", extras: ["max"] },
  { coluna: "carga1", extras: [] },
  { coluna: "bancoMs", extras: ["max"] },
  { coluna: "bancoBytes", extras: [] },
  { coluna: "walBytes", extras: ["max"] },
  { coluna: "discoLivreBytes", extras: ["min"] },
  { coluna: "discoTotalBytes", extras: [] },
  { coluna: "espComMac", extras: [] },
  { coluna: "espOnline", extras: ["min"] },
  { coluna: "espWs", extras: [] },
];
const CONTADORES_AMOSTRADOS = {
  telemetriaFalhas: "telemetriaFalha",
  credencialFalhas: "credencialFalha",
  schedulerFalhas: "schedulerFalha",
  bancoFalhas: "bancoFalha",
};
const FAIXAS = {
  "3h": { rotulo: "3 horas", segundos: 3 * 3600, bucket: 3 * 60, fonte: "amostras" },
  "24h": { rotulo: "24 horas", segundos: 24 * 3600, bucket: 15 * 60, fonte: "amostras" },
  "7d": { rotulo: "7 dias", segundos: 7 * 86400, bucket: 3600, fonte: "horas" },
  "30d": { rotulo: "30 dias", segundos: 30 * 86400, bucket: 6 * 3600, fonte: "horas" },
};
const FASES_OTA = ["ofertado", "baixando", "gravado", "reiniciando", "concluido", "falhou"];

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
const contadoresAmostrados = {};
let cpuAnterior = process.cpuUsage();
let cpuMedidoEm = process.hrtime.bigint();
const cacheHistorico = new Map();

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

function medirBanco() {
  const inicio = process.hrtime.bigint();
  let ok = true;
  try {
    db.prepare("SELECT 1 AS ok").get();
  } catch (erro) {
    ok = false;
    logger.error("monitoramento-banco-indisponivel", { mensagem: erro && erro.message });
  }
  const respostaMs = Number(process.hrtime.bigint() - inicio) / 1e6;
  return { ok, respostaMs: Math.round(respostaMs * 100) / 100 };
}

function coletarBanco() {
  const { ok, respostaMs } = medirBanco();
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
    respostaMs,
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

function contagensEsp32() {
  const deviceHub = require("./deviceHub");
  const comMac = db.prepare("SELECT COUNT(*) n FROM salas WHERE mac IS NOT NULL").get().n;
  const online = db.prepare("SELECT COUNT(*) n FROM salas WHERE mac IS NOT NULL AND online = 1").get().n;
  const conectadosWs = Object.keys(deviceHub.listarEstados()).length;
  return { comMac, online, conectadosWs };
}

function coletarEsp32() {
  const otaService = require("./otaService");
  const { comMac, online, conectadosWs } = contagensEsp32();

  const reconexoes1h = db.prepare(`
    SELECT sala, COUNT(*) n FROM esp_eventos
    WHERE status = 'online' AND criadoEm >= datetime('now', '-1 hour')
    GROUP BY sala
  `).all();
  const totalReconexoes1h = reconexoes1h.reduce((acc, r) => acc + r.n, 0);
  const salasInstaveis = reconexoes1h.filter((r) => r.n > 3).map((r) => ({ sala: r.sala, reconexoes: r.n }));

  const otaPorFase = Object.fromEntries(FASES_OTA.map((fase) => [fase, 0]));
  for (const estado of Object.values(otaService.listarEstados())) {
    if (!Object.prototype.hasOwnProperty.call(otaPorFase, estado.fase)) continue;
    otaPorFase[estado.fase] += 1;
  }
  const otaAtivos = otaPorFase.ofertado + otaPorFase.baixando + otaPorFase.gravado + otaPorFase.reiniciando;

  return {
    comMac,
    online,
    offlineInesperado: comMac - online,
    conectadosWs,
    reconexoesAnormais1h: totalReconexoes1h,
    salasInstaveis,
    otaEmAndamento: otaAtivos,
    otaComFalha: otaPorFase.falhou,
    otaPorFase,
  };
}

function coletarCredenciais() {
  try {
    return require("./esp32CredenciaisService").resumoMigracao();
  } catch {
    return null;
  }
}

function coletarPm2() {
  const env = process.env;
  if (env.pm_id === undefined || env.pm_id === "") return null;
  const inteiro = (valor) => (/^\d+$/.test(String(valor ?? "")) ? Number(valor) : null);
  const iniciado = inteiro(env.pm_uptime);
  return {
    id: inteiro(env.pm_id),
    nome: typeof env.name === "string" && env.name ? env.name.slice(0, 80) : null,
    instancia: inteiro(env.NODE_APP_INSTANCE),
    modo: typeof env.exec_mode === "string" && env.exec_mode ? env.exec_mode.slice(0, 20) : null,
    reinicios: inteiro(env.restart_time),
    reiniciosInstaveis: inteiro(env.unstable_restarts),
    iniciadoEm: iniciado ? new Date(iniciado).toISOString() : null,
  };
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
      nucleos: NUCLEOS,
      pm2: coletarPm2(),
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

function medirCpuPercent() {
  const agora = process.hrtime.bigint();
  const uso = process.cpuUsage(cpuAnterior);
  const decorridoUs = Number(agora - cpuMedidoEm) / 1000;
  cpuAnterior = process.cpuUsage();
  cpuMedidoEm = agora;
  if (decorridoUs <= 0) return null;
  const percentual = ((uso.user + uso.system) / decorridoUs) * 100;
  return Math.round(Math.min(100 * NUCLEOS, Math.max(0, percentual)) * 10) / 10;
}

function deltasContadores() {
  const deltas = {};
  for (const [coluna, contador] of Object.entries(CONTADORES_AMOSTRADOS)) {
    const atual = contadores[contador] || 0;
    const anterior = contadoresAmostrados[contador] || 0;
    deltas[coluna] = Math.max(0, atual - anterior);
    contadoresAmostrados[contador] = atual;
  }
  return deltas;
}

const COLUNAS_AMOSTRA = ["inicioProcesso", ...MEDIDAS.map((m) => m.coluna), ...Object.keys(CONTADORES_AMOSTRADOS)];

function gravarAmostra(valores, criadoEm) {
  const colunas = criadoEm ? ["criadoEm", ...COLUNAS_AMOSTRA] : COLUNAS_AMOSTRA;
  const parametros = colunas.map((coluna) => {
    if (coluna === "criadoEm") return criadoEm;
    if (coluna === "inicioProcesso") return valores.inicioProcesso || INICIO_PROCESSO_SQL;
    const valor = valores[coluna];
    if (coluna in CONTADORES_AMOSTRADOS) return Number.isFinite(valor) ? Math.max(0, Math.round(valor)) : 0;
    return Number.isFinite(valor) ? valor : null;
  });
  db.prepare(`INSERT INTO monitoramento_amostras (${colunas.join(", ")}) VALUES (${colunas.map(() => "?").join(", ")})`).run(...parametros);
  cacheHistorico.clear();
}

function amostrar() {
  const cpuPercent = medirCpuPercent();
  const banco = medirBanco();
  if (!banco.ok) registrar("bancoFalha");
  const emMemoria = CAMINHO_DB === ":memory:";
  const armazenamento = coletarArmazenamento();
  const esp = contagensEsp32();
  const mem = process.memoryUsage();
  gravarAmostra({
    rssMB: Math.round((mem.rss / 1_048_576) * 10) / 10,
    cpuPercent,
    carga1: Math.round(os.loadavg()[0] * 100) / 100,
    bancoMs: banco.ok ? banco.respostaMs : null,
    bancoBytes: emMemoria ? null : tamanhoArquivo(CAMINHO_DB),
    walBytes: emMemoria ? null : tamanhoArquivo(`${CAMINHO_DB}-wal`),
    discoLivreBytes: armazenamento.erro ? null : armazenamento.livreBytes,
    discoTotalBytes: armazenamento.erro ? null : armazenamento.totalBytes,
    espComMac: esp.comMac,
    espOnline: esp.online,
    espWs: esp.conectadosWs,
    ...deltasContadores(),
  });
  consolidarHoras();
}

function capitalizar(texto) {
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

function colunasHora() {
  const colunas = [];
  for (const m of MEDIDAS) {
    colunas.push(m.coluna);
    for (const extra of m.extras) colunas.push(`${m.coluna}${capitalizar(extra)}`);
  }
  return [...colunas, ...Object.keys(CONTADORES_AMOSTRADOS)];
}

function agregacoesAmostras() {
  const partes = [];
  for (const m of MEDIDAS) {
    partes.push(`AVG(${m.coluna}) ${m.coluna}`);
    for (const extra of m.extras) partes.push(`${extra.toUpperCase()}(${m.coluna}) ${m.coluna}${capitalizar(extra)}`);
  }
  for (const coluna of Object.keys(CONTADORES_AMOSTRADOS)) partes.push(`SUM(${coluna}) ${coluna}`);
  return partes.join(", ");
}

function agregacoesHoras() {
  const partes = [];
  for (const m of MEDIDAS) {
    partes.push(`SUM(${m.coluna} * amostras) / SUM(CASE WHEN ${m.coluna} IS NULL THEN 0 ELSE amostras END) ${m.coluna}`);
    for (const extra of m.extras) {
      const nome = `${m.coluna}${capitalizar(extra)}`;
      partes.push(`${extra.toUpperCase()}(${nome}) ${nome}`);
    }
  }
  for (const coluna of Object.keys(CONTADORES_AMOSTRADOS)) partes.push(`SUM(${coluna}) ${coluna}`);
  return partes.join(", ");
}

function consolidarHoras() {
  const horaAtual = db.prepare("SELECT strftime('%Y-%m-%d %H:00:00', 'now') h").get().h;
  const ultima = db.prepare("SELECT MAX(hora) h FROM monitoramento_horas").get().h || null;
  const pendentes = db.prepare(`
    SELECT DISTINCT strftime('%Y-%m-%d %H:00:00', criadoEm) hora FROM monitoramento_amostras
    WHERE criadoEm < ? AND criadoEm >= COALESCE(datetime(?, '+1 hour'), '0000-00-00')
    ORDER BY hora
  `).all(horaAtual, ultima);
  if (!pendentes.length) return 0;
  const colunas = colunasHora();
  const inserir = db.prepare(`
    INSERT OR REPLACE INTO monitoramento_horas (hora, amostras, reinicios, ${colunas.join(", ")})
    SELECT ?, COUNT(*), ?, ${agregacoesAmostras()}
    FROM monitoramento_amostras WHERE criadoEm >= ? AND criadoEm < datetime(?, '+1 hour')
  `);
  for (const { hora } of pendentes) {
    const fim = db.prepare("SELECT datetime(?, '+1 hour') h").get(hora).h;
    const reinicios = iniciosDeProcesso(hora).filter((boot) => boot.primeira < fim).length;
    inserir.run(hora, reinicios, hora, hora);
  }
  cacheHistorico.clear();
  return pendentes.length;
}

function iniciosDeProcesso(primeiraAmostraDesde) {
  return db.prepare(`
    SELECT inicioProcesso, primeira FROM (
      SELECT inicioProcesso, MIN(criadoEm) primeira FROM monitoramento_amostras GROUP BY inicioProcesso
    ) WHERE primeira >= ? ORDER BY primeira
  `).all(primeiraAmostraDesde);
}

function faixaValida(faixa) {
  return typeof faixa === "string" && Object.prototype.hasOwnProperty.call(FAIXAS, faixa);
}

function faixasPublicas() {
  return Object.entries(FAIXAS).map(([id, f]) => ({ id, rotulo: f.rotulo, bucketSegundos: f.bucket, fonte: f.fonte }));
}

function sqlData(epoch) {
  return new Date(epoch * 1000).toISOString().slice(0, 19).replace("T", " ");
}

function mesclarBucket(destino, origem) {
  if (!destino) return { ...origem };
  const total = (destino.n || 0) + (origem.n || 0);
  const saida = { ...destino, n: total };
  for (const m of MEDIDAS) {
    const a = destino[m.coluna];
    const b = origem[m.coluna];
    if (a === null || a === undefined) saida[m.coluna] = b;
    else if (b === null || b === undefined) saida[m.coluna] = a;
    else saida[m.coluna] = total > 0 ? (a * (destino.n || 0) + b * (origem.n || 0)) / total : null;
    for (const extra of m.extras) {
      const nome = `${m.coluna}${capitalizar(extra)}`;
      const x = destino[nome];
      const y = origem[nome];
      if (x === null || x === undefined) saida[nome] = y;
      else if (y === null || y === undefined) saida[nome] = x;
      else saida[nome] = extra === "max" ? Math.max(x, y) : Math.min(x, y);
    }
  }
  for (const coluna of Object.keys(CONTADORES_AMOSTRADOS)) saida[coluna] = (destino[coluna] || 0) + (origem[coluna] || 0);
  return saida;
}

function expressaoBucket(coluna, bucket) {
  const tamanho = Math.trunc(Number(bucket));
  if (!Number.isSafeInteger(tamanho) || tamanho <= 0) throw new Error("bucket inválido");
  return `(CAST(strftime('%s', ${coluna}) AS INTEGER) / ${tamanho}) * ${tamanho}`;
}

function bucketsAmostras(bucket, desde) {
  return db.prepare(`
    SELECT ${expressaoBucket("criadoEm", bucket)} t, COUNT(*) n, ${agregacoesAmostras()}
    FROM monitoramento_amostras WHERE criadoEm >= ? GROUP BY t
  `).all(desde);
}

function bucketsHoras(bucket, desde, ate) {
  return db.prepare(`
    SELECT ${expressaoBucket("hora", bucket)} t, SUM(amostras) n, ${agregacoesHoras()}
    FROM monitoramento_horas WHERE hora >= ? AND hora <= ? GROUP BY t
  `).all(desde, ate);
}

function contagensEventos(bucket, desde) {
  const eventos = db.prepare(`
    SELECT ${expressaoBucket("criadoEm", bucket)} t,
           SUM(status = 'online') reconexoes, SUM(status = 'offline') quedas
    FROM esp_eventos WHERE criadoEm >= ? GROUP BY t
  `).all(desde);
  const comandos = db.prepare(`
    SELECT ${expressaoBucket("criadoEm", bucket)} t, origem, COUNT(*) n
    FROM comandos_log WHERE criadoEm >= ? GROUP BY t, origem
  `).all(desde);
  const ota = db.prepare(`
    SELECT ${expressaoBucket("criadoEm", bucket)} t,
           SUM(tipo = 'esp32_ota_falha') otaFalhas, SUM(tipo = 'esp32_ota_ok') otaOk
    FROM notificacoes WHERE tipo IN ('esp32_ota_falha', 'esp32_ota_ok') AND criadoEm >= ? GROUP BY t
  `).all(desde);
  return { eventos, comandos, ota };
}

function calcularHistorico(id) {
  const faixa = FAIXAS[id];
  const bucket = faixa.bucket;
  const pontos = Math.round(faixa.segundos / bucket);
  const atual = Math.floor(Date.now() / 1000 / bucket) * bucket;
  const inicio = atual - (pontos - 1) * bucket;
  const desde = sqlData(inicio);

  const porBucket = new Map();
  const reinicios = [];
  if (faixa.fonte === "horas") {
    const ultimaHora = db.prepare("SELECT MAX(hora) h FROM monitoramento_horas").get().h || null;
    if (ultimaHora && ultimaHora >= desde) {
      for (const linha of bucketsHoras(bucket, desde, ultimaHora)) porBucket.set(linha.t, mesclarBucket(porBucket.get(linha.t), linha));
      for (const linha of db.prepare("SELECT hora, reinicios FROM monitoramento_horas WHERE hora >= ? AND reinicios > 0").all(desde)) {
        reinicios.push({ em: `${linha.hora.replace(" ", "T")}Z`, exato: false, quantidade: linha.reinicios });
      }
    }
    const desdeBruto = ultimaHora && ultimaHora >= desde
      ? db.prepare("SELECT datetime(?, '+1 hour') h").get(ultimaHora).h
      : desde;
    for (const linha of bucketsAmostras(bucket, desdeBruto)) porBucket.set(linha.t, mesclarBucket(porBucket.get(linha.t), linha));
    for (const boot of iniciosDeProcesso(desdeBruto)) {
      reinicios.push({ em: `${boot.inicioProcesso.replace(" ", "T")}Z`, exato: true, quantidade: 1 });
    }
  } else {
    for (const linha of bucketsAmostras(bucket, desde)) porBucket.set(linha.t, linha);
    for (const boot of iniciosDeProcesso(desde)) {
      reinicios.push({ em: `${boot.inicioProcesso.replace(" ", "T")}Z`, exato: true, quantidade: 1 });
    }
  }
  const inicioJanela = new Date(inicio * 1000).toISOString();
  const reiniciosNaJanela = reinicios.filter((r) => r.em >= inicioJanela).sort((a, b) => (a.em < b.em ? -1 : a.em > b.em ? 1 : 0));

  const { eventos, comandos, ota } = contagensEventos(bucket, desde);
  const eventosPorT = new Map(eventos.map((l) => [l.t, l]));
  const otaPorT = new Map(ota.map((l) => [l.t, l]));
  const comandosPorT = new Map();
  for (const linha of comandos) {
    const chave = linha.origem === "manual" ? "comandosManual"
      : linha.origem === "agendamento" ? "comandosAgendamento"
        : linha.origem === "esp32_local" ? "comandosEsp32" : "comandosOutros";
    const atualT = comandosPorT.get(linha.t) || {};
    atualT[chave] = (atualT[chave] || 0) + linha.n;
    comandosPorT.set(linha.t, atualT);
  }

  const t = [];
  const n = [];
  const medidas = Object.fromEntries(colunasHora().filter((c) => !(c in CONTADORES_AMOSTRADOS)).map((c) => [c, []]));
  const contagens = Object.fromEntries([
    ...Object.keys(CONTADORES_AMOSTRADOS),
    "reconexoes", "quedas", "otaFalhas", "otaOk",
    "comandosManual", "comandosAgendamento", "comandosEsp32", "comandosOutros",
  ].map((c) => [c, []]));
  let amostras = 0;
  for (let i = 0; i < pontos; i += 1) {
    const inicioBucket = inicio + i * bucket;
    const linha = porBucket.get(inicioBucket);
    const quantidade = linha ? Number(linha.n) || 0 : 0;
    amostras += quantidade;
    t.push(inicioBucket * 1000);
    n.push(quantidade);
    for (const coluna of Object.keys(medidas)) {
      const valor = linha && quantidade > 0 ? linha[coluna] : null;
      medidas[coluna].push(valor === null || valor === undefined ? null : Math.round(Number(valor) * 100) / 100);
    }
    for (const coluna of Object.keys(CONTADORES_AMOSTRADOS)) contagens[coluna].push(linha ? Number(linha[coluna]) || 0 : 0);
    const ev = eventosPorT.get(inicioBucket);
    contagens.reconexoes.push(ev ? Number(ev.reconexoes) || 0 : 0);
    contagens.quedas.push(ev ? Number(ev.quedas) || 0 : 0);
    const o = otaPorT.get(inicioBucket);
    contagens.otaFalhas.push(o ? Number(o.otaFalhas) || 0 : 0);
    contagens.otaOk.push(o ? Number(o.otaOk) || 0 : 0);
    const c = comandosPorT.get(inicioBucket) || {};
    contagens.comandosManual.push(c.comandosManual || 0);
    contagens.comandosAgendamento.push(c.comandosAgendamento || 0);
    contagens.comandosEsp32.push(c.comandosEsp32 || 0);
    contagens.comandosOutros.push(c.comandosOutros || 0);
  }

  const primeira = db.prepare(`
    SELECT MIN(inicio) inicio FROM (
      SELECT MIN(hora) inicio FROM monitoramento_horas
      UNION ALL SELECT MIN(criadoEm) inicio FROM monitoramento_amostras
    )
  `).get().inicio || null;
  const primeiraAmostraEm = primeira ? `${primeira.replace(" ", "T")}Z` : null;

  return {
    faixa: id,
    rotulo: faixa.rotulo,
    faixas: faixasPublicas(),
    fonte: faixa.fonte,
    geradoEm: new Date().toISOString(),
    amostragemSegundos: AMOSTRAGEM_SEGUNDOS,
    bucketSegundos: bucket,
    retencao: { amostrasHoras: RETENCAO_AMOSTRAS_HORAS, horasDias: RETENCAO_HORAS_DIAS },
    janela: { inicio: new Date(inicio * 1000).toISOString(), fim: new Date((atual + bucket) * 1000).toISOString() },
    cobertura: {
      desde: primeiraAmostraEm,
      amostras,
      completa: !!primeiraAmostraEm && new Date(primeiraAmostraEm).getTime() <= inicio * 1000,
    },
    t,
    n,
    medidas,
    contagens,
    reinicios: reiniciosNaJanela,
  };
}

function historico(faixa) {
  const id = faixaValida(faixa) ? faixa : "24h";
  const guardado = cacheHistorico.get(id);
  const agora = Date.now();
  if (guardado && agora - guardado.em < CACHE_HISTORICO_MS) return guardado.dados;
  const dados = calcularHistorico(id);
  cacheHistorico.set(id, { em: agora, dados });
  return dados;
}

function limparCacheHistorico() {
  cacheHistorico.clear();
}

module.exports = {
  registrar,
  registrarConexaoDispositivo,
  coletar,
  avaliar,
  avaliarEspaco,
  amostrar,
  gravarAmostra,
  consolidarHoras,
  historico,
  faixaValida,
  faixasPublicas,
  limparCacheHistorico,
  coletarPm2,
  AMOSTRAGEM_SEGUNDOS,
  RETENCAO_AMOSTRAS_HORAS,
  RETENCAO_HORAS_DIAS,
  FAIXAS,
};

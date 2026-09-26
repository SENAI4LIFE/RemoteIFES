// Measurement probe, loaded with `--require` into an isolated server.js by the soak and latency
// tools (support/servidor-isolado.js with `sonda: true`). Never part of a production start.
//
// It answers requests on the IPC channel with the process's own metrics and the size of its
// in-memory structures, read through the same module instances the server uses. Modules are
// required lazily, inside a request: loading them here, before server.js, would change the order
// in which the application initialises.

const fs = require("fs");
const path = require("path");
const { createHistogram } = require("perf_hooks");

const SRC = path.join(__dirname, "..", "..", "src");
const modulo = (rel) => require(path.join(SRC, rel));
const MB = (bytes) => Math.round((bytes / 1048576) * 10) / 10;
const ms = (ns) => Math.round((ns / 1e6) * 100) / 100;

// Event-loop delay as the time a queued callback waits to run (setImmediate latency), sampled every
// 50 ms. Unlike a timer-based monitor it does not include the timer granularity, which is about
// 15.6 ms on Windows.
const atraso = createHistogram();
const amostragem = setInterval(() => {
  const t = process.hrtime.bigint();
  setImmediate(() => atraso.record(Math.max(1, Number(process.hrtime.bigint() - t))));
}, 50);
amostragem.unref();

// Append-only tables: their growth is what a long run writes.
const TABELAS = ["comandos_log", "esp_eventos", "esp_indisponibilidades", "auditoria_eventos", "notificacoes", "monitoramento_amostras", "energia_estados"];

function contarRecursos() {
  const contagem = {};
  for (const tipo of process.getActiveResourcesInfo()) contagem[tipo] = (contagem[tipo] || 0) + 1;
  return contagem;
}

function banco() {
  const db = modulo("config/database");
  const { CAMINHO_DB } = modulo("config/paths");
  const linhas = {};
  for (const tabela of TABELAS) {
    try {
      linhas[tabela] = Number(db.prepare(`SELECT COUNT(*) n FROM ${tabela}`).get().n);
    } catch {
      linhas[tabela] = null;
    }
  }
  const tamanho = (sufixo) => {
    try {
      return fs.statSync(`${CAMINHO_DB}${sufixo}`).size;
    } catch {
      return 0;
    }
  };
  return { arquivoMB: MB(tamanho("")), walMB: MB(tamanho("-wal")), linhas };
}

// `zerarLaco` starts a new event-loop window: the soak reads one window per cycle, and its polling
// in between must not cut that window short.
function metricas({ gc = false, zerarLaco = false } = {}) {
  if (gc && typeof global.gc === "function") global.gc();
  const memoria = process.memoryUsage();
  const laco = atraso.count
    ? { amostras: atraso.count, mediaMs: ms(atraso.mean), p99Ms: ms(atraso.percentile(99)), maxMs: ms(atraso.max) }
    : { amostras: 0, mediaMs: null, p99Ms: null, maxMs: null };
  if (zerarLaco) atraso.reset();

  const deviceHub = modulo("services/deviceHub");
  const conexoes = deviceHub.listarConexoes();
  const porTransporte = {};
  for (const [, entrada] of conexoes) porTransporte[entrada.canal.transporte] = (porTransporte[entrada.canal.transporte] || 0) + 1;
  const topo = modulo("services/meshService").topologia();
  const porEstado = {};
  let filaPendente = 0;
  for (const no of topo.nos) {
    porEstado[no.estado] = (porEstado[no.estado] || 0) + 1;
    filaPendente += no.entregas.pendentes;
  }
  const ota = modulo("services/otaService").listarEstados();
  const otaAtivas = Object.values(ota).filter((e) => ["ofertado", "baixando", "gravado", "reiniciando", "validando"].includes(e.fase)).length;
  const confirmadas = conexoes.filter(([sala]) => deviceHub.estadoPublico(sala).estadoConfirmado === true).length;

  return {
    em: new Date().toISOString(),
    uptimeS: Math.round(process.uptime()),
    memoria: { rssMB: MB(memoria.rss), heapUsadoMB: MB(memoria.heapUsed), heapTotalMB: MB(memoria.heapTotal), externoMB: MB(memoria.external) },
    laco,
    recursos: contarRecursos(),
    dispositivos: { sessoes: conexoes.length, porTransporte, confirmadas },
    malha: {
      gateways: topo.gateways.length,
      nosObservados: topo.nos.length,
      porEstado,
      handshakesPendentes: porEstado.autenticando || 0,
      filaPendente,
      limiteObservados: 256,
    },
    ota: { estados: Object.keys(ota).length, ativas: otaAtivas },
    banco: banco(),
  };
}

// Synthetic rooms for runs larger than the campus plan (86 rooms). Only in an isolated instance.
function criarSalas({ quantidade, prefixo = "ENSAIO" }) {
  const db = modulo("config/database");
  const nomes = [];
  const inserir = db.prepare("INSERT OR IGNORE INTO salas (sala, nome, bloco, andar, ligado, temperaturaAlvo, turboAtivo) VALUES (?, ?, 'Z', 1, 0, 24, 0)");
  for (let i = 1; i <= quantidade; i += 1) {
    const sala = `${prefixo}-${String(i).padStart(3, "0")}`;
    inserir.run(sala, sala);
    nomes.push(sala);
  }
  return nomes;
}

const OPERACOES = { metricas, "criar-salas": criarSalas };

process.on("message", (msg) => {
  if (!msg || typeof msg !== "object" || !OPERACOES[msg.tipo]) return;
  try {
    process.send({ id: msg.id, resultado: OPERACOES[msg.tipo](msg) });
  } catch (erro) {
    process.send({ id: msg.id, erro: erro.message });
  }
});
// The channel must not keep the server alive on its own.
if (process.channel) process.channel.unref();

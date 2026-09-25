// Operational heatmaps: per-room aggregations computed on demand. Nothing runs in the background;
// each request is a single indexed query over histories that already exist and already have bounded
// retention.
const db = require("../config/database");

const PERIODOS = {
  "24h": { rotulo: "24 horas", horas: 24 },
  "7d": { rotulo: "7 dias", horas: 24 * 7 },
  "30d": { rotulo: "30 dias", horas: 24 * 30 },
};

const CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX = 40;
const cache = new Map();

// Each metric declares the real data source the system already retains. Metrics without a reliable
// per-room source do not exist here.
const METRICAS = {
  disponibilidade: {
    rotulo: "Disponibilidade do ESP32",
    unidade: "%",
    casas: 1,
    maiorEhPior: false,
    exigeDispositivo: true,
    fonte: "esp_indisponibilidades",
    descricao: "Percentual do período em que o dispositivo da sala esteve conectado.",
  },
  indisponibilidade: {
    rotulo: "Tempo offline do ESP32",
    unidade: "min",
    casas: 0,
    maiorEhPior: true,
    exigeDispositivo: true,
    fonte: "esp_indisponibilidades",
    descricao: "Minutos acumulados em que o dispositivo ficou offline no período.",
  },
  quedas: {
    rotulo: "Quedas de conexão",
    unidade: "",
    casas: 0,
    maiorEhPior: true,
    exigeDispositivo: true,
    fonte: "esp_indisponibilidades",
    descricao: "Quantidade de vezes que o dispositivo caiu no período.",
  },
  comandos: {
    rotulo: "Comandos enviados",
    unidade: "",
    casas: 0,
    maiorEhPior: true,
    exigeDispositivo: false,
    fonte: "comandos_log",
    descricao: "Comandos registrados para a sala, de qualquer origem.",
  },
  comandosOffline: {
    rotulo: "Comandos com o dispositivo offline",
    unidade: "",
    casas: 0,
    maiorEhPior: true,
    exigeDispositivo: true,
    fonte: "comandos_log + esp_indisponibilidades",
    descricao: "Comandos registrados enquanto o dispositivo da sala estava fora do ar.",
  },
  agendamentos: {
    rotulo: "Agendamentos criados",
    unidade: "",
    casas: 0,
    maiorEhPior: true,
    exigeDispositivo: false,
    fonte: "agendamentos",
    descricao: "Agendamentos criados para a sala no período.",
  },
  execucoes: {
    rotulo: "Execuções de agendamento",
    unidade: "",
    casas: 0,
    maiorEhPior: true,
    exigeDispositivo: false,
    fonte: "agendamentos_execucoes",
    descricao: "Acionamentos automáticos (ligar/desligar) efetivamente executados.",
  },
  relatos: {
    rotulo: "Relatos de problema",
    unidade: "",
    casas: 0,
    maiorEhPior: true,
    exigeDispositivo: false,
    fonte: "relatos",
    descricao: "Relatos abertos pelos usuários apontando esta sala.",
  },
  relatosPendentes: {
    rotulo: "Relatos sem resolução",
    unidade: "",
    casas: 0,
    maiorEhPior: true,
    exigeDispositivo: false,
    fonte: "relatos",
    descricao: "Relatos desta sala ainda em novo, aberto ou em análise.",
  },
};

function metricasPublicas() {
  return Object.entries(METRICAS).map(([id, m]) => ({
    id,
    rotulo: m.rotulo,
    unidade: m.unidade,
    maiorEhPior: m.maiorEhPior,
    descricao: m.descricao,
  }));
}

function periodosPublicos() {
  return Object.entries(PERIODOS).map(([id, p]) => ({ id, rotulo: p.rotulo, horas: p.horas }));
}

function normalizar(metrica, periodo) {
  const m = typeof metrica === "string" && METRICAS[metrica] ? metrica : "disponibilidade";
  const p = typeof periodo === "string" && PERIODOS[periodo] ? periodo : "7d";
  return { metrica: m, periodo: p };
}

// Connectivity history follows audit retention: a period longer than that covers fewer days than
// the label suggests, and this must be visible.
function diasRetencaoConectividade() {
  const valor = require("./configuracoesService").obter().retencaoAuditoriaDias;
  return Number.isInteger(valor) && valor >= 1 && valor <= 365 ? valor : 7;
}

function salasBase() {
  return db.prepare("SELECT sala, nome, mac FROM salas ORDER BY sala").all();
}

function segundosOfflinePorSala(inicio, fim) {
  const linhas = db
    .prepare(
      `SELECT sala,
              SUM((julianday(MIN(COALESCE(onlineEm, ?), ?)) - julianday(MAX(offlineEm, ?))) * 86400) segundos,
              COUNT(*) intervalos
         FROM esp_indisponibilidades
        WHERE offlineEm < ? AND (onlineEm IS NULL OR onlineEm > ?)
        GROUP BY sala`
    )
    .all(fim, fim, inicio, fim, inicio);
  return new Map(linhas.map((l) => [l.sala, { segundos: Math.max(0, l.segundos || 0), intervalos: l.intervalos }]));
}

function contagemPorSala(sql, ...parametros) {
  return new Map(db.prepare(sql).all(...parametros).map((l) => [l.sala, l.n]));
}

function agregar(metrica, inicio, fim, janelaSegundos, offlinePorSala, quedasPorSala) {
  if (metrica === "disponibilidade" || metrica === "indisponibilidade") {
    return (sala) => {
      const registro = offlinePorSala.get(sala);
      const segundos = registro ? Math.min(registro.segundos, janelaSegundos) : 0;
      if (metrica === "indisponibilidade") return segundos / 60;
      return janelaSegundos > 0 ? Math.max(0, Math.min(100, 100 * (1 - segundos / janelaSegundos))) : null;
    };
  }
  if (metrica === "quedas") {
    return (sala) => quedasPorSala.get(sala) || 0;
  }
  if (metrica === "comandos") {
    const mapa = contagemPorSala(
      "SELECT sala, COUNT(*) n FROM comandos_log WHERE criadoEm >= ? AND criadoEm < ? GROUP BY sala",
      inicio,
      fim
    );
    return (sala) => mapa.get(sala) || 0;
  }
  if (metrica === "comandosOffline") {
    const mapa = contagemPorSala(
      // Walks the outages (small table) and counts each interval's commands through the (sala,
      // criadoEm) index. The reverse path, with EXISTS per command, cost orders of magnitude more
      // over 30 days.
      `SELECT i.sala sala, COUNT(c.id) n
         FROM esp_indisponibilidades i
         JOIN comandos_log c
           ON c.sala = i.sala
          AND c.criadoEm >= MAX(i.offlineEm, ?)
          AND c.criadoEm < MIN(COALESCE(i.onlineEm, ?), ?)
        WHERE i.offlineEm < ? AND (i.onlineEm IS NULL OR i.onlineEm > ?)
        GROUP BY i.sala`,
      inicio,
      fim,
      fim,
      fim,
      inicio
    );
    return (sala) => mapa.get(sala) || 0;
  }
  if (metrica === "agendamentos") {
    const mapa = contagemPorSala(
      "SELECT sala, COUNT(*) n FROM agendamentos WHERE criadoEm >= ? AND criadoEm < ? GROUP BY sala",
      inicio,
      fim
    );
    return (sala) => mapa.get(sala) || 0;
  }
  if (metrica === "execucoes") {
    const mapa = contagemPorSala(
      `SELECT a.sala sala, COUNT(*) n
         FROM agendamentos_execucoes e
         JOIN agendamentos a ON a.id = e.agendamentoId
        WHERE e.executadoEm >= ? AND e.executadoEm < ?
        GROUP BY a.sala`,
      inicio,
      fim
    );
    return (sala) => mapa.get(sala) || 0;
  }
  if (metrica === "relatosPendentes") {
    const mapa = contagemPorSala(
      `SELECT sala, COUNT(*) n FROM relatos
        WHERE sala IS NOT NULL AND criadoEm >= ? AND criadoEm < ?
          AND status IN ('novo', 'aberto', 'em_analise')
        GROUP BY sala`,
      inicio,
      fim
    );
    return (sala) => mapa.get(sala) || 0;
  }
  const mapa = contagemPorSala(
    "SELECT sala, COUNT(*) n FROM relatos WHERE sala IS NOT NULL AND criadoEm >= ? AND criadoEm < ? GROUP BY sala",
    inicio,
    fim
  );
  return (sala) => mapa.get(sala) || 0;
}

function calcular(metricaPedida, periodoPedido) {
  const { metrica, periodo } = normalizar(metricaPedida, periodoPedido);
  const definicao = METRICAS[metrica];
  const horas = PERIODOS[periodo].horas;

  const { inicio, fim } = db
    .prepare("SELECT datetime('now', ?) inicio, datetime('now') fim")
    .get(`-${horas} hours`);

  const retencaoDias = diasRetencaoConectividade();
  const excedeRetencao = definicao.fonte.includes("esp_indisponibilidades") && horas / 24 > retencaoDias;
  const proporcional = metrica === "disponibilidade" || metrica === "indisponibilidade";
  const horasEfetivas = excedeRetencao && proporcional ? retencaoDias * 24 : horas;
  const inicioConectividade = horasEfetivas === horas
    ? inicio
    : db.prepare("SELECT datetime('now', ?) inicio").get(`-${horasEfetivas} hours`).inicio;
  const janelaConectividadeSegundos = horasEfetivas * 3600;

  const salas = salasBase();
  // As duas consultas de conectividade servem tanto ao valor quanto ao detalhe do tooltip.
  const precisaConectividade = definicao.exigeDispositivo;
  const offlinePorSala = precisaConectividade ? segundosOfflinePorSala(inicioConectividade, fim) : new Map();
  const quedasPorSala = precisaConectividade
    ? contagemPorSala(
        "SELECT sala, COUNT(*) n FROM esp_indisponibilidades WHERE offlineEm >= ? AND offlineEm < ? GROUP BY sala",
        inicioConectividade,
        fim
      )
    : new Map();
  const valorDe = agregar(metrica, inicioConectividade, fim, janelaConectividadeSegundos, offlinePorSala, quedasPorSala);

  let minimo = null;
  let maximo = null;
  let comDados = 0;
  const lista = salas.map((s) => {
    const semDispositivo = precisaConectividade && !s.mac;
    const bruto = semDispositivo ? null : valorDe(s.sala);
    const valor = bruto === null || !Number.isFinite(bruto) ? null : +bruto.toFixed(definicao.casas);
    if (valor !== null) {
      comDados += 1;
      minimo = minimo === null ? valor : Math.min(minimo, valor);
      maximo = maximo === null ? valor : Math.max(maximo, valor);
    }
    const item = { sala: s.sala, nome: s.nome, valor };
    if (precisaConectividade && !semDispositivo) {
      const offline = offlinePorSala.get(s.sala);
      item.quedas = quedasPorSala.get(s.sala) || 0;
      item.minutosOffline = Math.round(Math.min(offline ? offline.segundos : 0, janelaConectividadeSegundos) / 60);
    }
    return item;
  });

  return {
    metrica,
    periodo,
    rotuloMetrica: definicao.rotulo,
    rotuloPeriodo: PERIODOS[periodo].rotulo,
    descricao: definicao.descricao,
    unidade: definicao.unidade,
    casas: definicao.casas,
    maiorEhPior: definicao.maiorEhPior,
    janela: { inicio, fim, horas, horasEfetivas, inicioEfetivo: inicioConectividade },
    minimo,
    maximo,
    comDados,
    total: lista.length,
    avisoRetencao: excedeRetencao
      ? (proporcional
        ? `O histórico de conectividade é mantido por ${retencaoDias} dia(s); os valores cobrem apenas as últimas ${horasEfetivas} h, não o período inteiro.`
        : `O histórico de conectividade é mantido por ${retencaoDias} dia(s); o período selecionado cobre apenas esse trecho.`)
      : null,
    salas: lista,
  };
}

// Short cache only for repeating the same query (tab switch, resize). Expires by time, with no
// event-based invalidation.
function obter(metrica, periodo) {
  const { metrica: m, periodo: p } = normalizar(metrica, periodo);
  const chave = `${m}|${p}`;
  const agora = Date.now();
  const guardado = cache.get(chave);
  if (guardado && agora - guardado.em < CACHE_TTL_MS) return guardado.dados;
  const dados = calcular(m, p);
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(chave, { em: agora, dados });
  return dados;
}

function limparCache() {
  cache.clear();
}

module.exports = { obter, calcular, metricasPublicas, periodosPublicos, limparCache, METRICAS, PERIODOS };

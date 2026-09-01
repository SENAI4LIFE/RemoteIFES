// Mapas de calor operacionais: agregacoes por sala calculadas sob demanda.
// Nada roda em segundo plano; cada consulta e uma unica query indexada sobre
// historicos que ja existem e ja tem retencao limitada.
const db = require("../config/database");

const PERIODOS = {
  "24h": { rotulo: "24 horas", horas: 24 },
  "7d": { rotulo: "7 dias", horas: 24 * 7 },
  "30d": { rotulo: "30 dias", horas: 24 * 30 },
};

const CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX = 40;
const cache = new Map();

// Cada metrica declara a fonte de dados real que ja e retida pelo sistema.
// Metricas sem fonte confiavel por sala simplesmente nao existem aqui.
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

// Historico de conectividade segue a retencao de auditoria: um periodo maior que
// ela cobre menos dias do que o rotulo sugere, e isso precisa ficar visivel.
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
      // Percorre as indisponibilidades (tabela pequena) e conta os comandos de cada
      // intervalo pelo indice (sala, criadoEm). O caminho inverso, com EXISTS por
      // comando, custava ordens de grandeza mais em 30 dias.
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
  const janelaSegundos = horas * 3600;

  const { inicio, fim } = db
    .prepare("SELECT datetime('now', ?) inicio, datetime('now') fim")
    .get(`-${horas} hours`);

  const salas = salasBase();
  // As duas consultas de conectividade servem tanto ao valor quanto ao detalhe do tooltip.
  const precisaConectividade = definicao.exigeDispositivo;
  const offlinePorSala = precisaConectividade ? segundosOfflinePorSala(inicio, fim) : new Map();
  const quedasPorSala = precisaConectividade
    ? contagemPorSala(
        "SELECT sala, COUNT(*) n FROM esp_indisponibilidades WHERE offlineEm >= ? AND offlineEm < ? GROUP BY sala",
        inicio,
        fim
      )
    : new Map();
  const valorDe = agregar(metrica, inicio, fim, janelaSegundos, offlinePorSala, quedasPorSala);

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
      item.minutosOffline = Math.round(Math.min(offline ? offline.segundos : 0, janelaSegundos) / 60);
    }
    return item;
  });

  const retencaoDias = diasRetencaoConectividade();
  const excedeRetencao = definicao.fonte.includes("esp_indisponibilidades") && horas / 24 > retencaoDias;

  return {
    metrica,
    periodo,
    rotuloMetrica: definicao.rotulo,
    rotuloPeriodo: PERIODOS[periodo].rotulo,
    descricao: definicao.descricao,
    unidade: definicao.unidade,
    casas: definicao.casas,
    maiorEhPior: definicao.maiorEhPior,
    janela: { inicio, fim, horas },
    minimo,
    maximo,
    comDados,
    total: lista.length,
    avisoRetencao: excedeRetencao
      ? `O histórico de conectividade é mantido por ${retencaoDias} dia(s); o período selecionado cobre apenas esse trecho.`
      : null,
    salas: lista,
  };
}

// Cache curto apenas para repetir a mesma consulta (troca de aba, redimensionamento).
// Expira por tempo, sem invalidacao por evento.
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

const db = require("../config/database");
const logger = require("../utils/logger");
const { FUSO } = require("../utils/tempo");

const TELEMETRIA_VALIDA_MS = 5 * 60 * 1000;
const INTERVALO_MAXIMO_MS = 30 * 60 * 1000;
const FATOR_INVERTER_SEM_TELEMETRIA = 0.65;
const POTENCIA_MIN = 100;
const POTENCIA_MAX = 100000;
const TIPOS = new Set(["inverter", "fixo"]);
const formatadorData = new Intl.DateTimeFormat("en-CA", { timeZone: FUSO, year: "numeric", month: "2-digit", day: "2-digit" });

function dataLocal(ms) {
  return formatadorData.format(new Date(ms));
}

function sqlData(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

function epochSql(valor) {
  if (!valor) return null;
  const ms = new Date(String(valor).replace(" ", "T") + "Z").getTime();
  return Number.isFinite(ms) ? ms : null;
}

function inicioDataLocal(data) {
  const base = Date.parse(`${data}T00:00:00Z`);
  let baixo = base - 12 * 60 * 60 * 1000;
  let alto = base + 12 * 60 * 60 * 1000;
  while (alto - baixo > 1000) {
    const meio = Math.floor((baixo + alto) / 2);
    if (dataLocal(meio) < data) baixo = meio + 1;
    else alto = meio;
  }
  return alto;
}

function inicioProximoDia(ms) {
  const atual = dataLocal(ms);
  let baixo = ms;
  let alto = ms + 30 * 60 * 60 * 1000;
  while (alto - baixo > 1000) {
    const meio = Math.floor((baixo + alto) / 2);
    if (dataLocal(meio) === atual) baixo = meio + 1;
    else alto = meio;
  }
  return alto;
}

function fatorInverter(ambiente, alvo) {
  if (!Number.isFinite(ambiente) || !Number.isFinite(alvo)) return FATOR_INVERTER_SEM_TELEMETRIA;
  return Math.max(0.35, Math.min(1, 0.35 + Math.max(0, ambiente - alvo) * 0.12));
}

function salaAtual(sala) {
  return db.prepare("SELECT sala, nome, bloco, andar, ligado, temperatura, temperaturaAlvo, ultimoHeartbeat FROM salas WHERE sala = ?").get(sala);
}

function inserirEstadoAtual(sala, agoraMs) {
  const atual = salaAtual(sala);
  if (!atual) return null;
  const telemetriaMs = epochSql(atual.ultimoHeartbeat);
  const ambienteValido = Number.isFinite(Number(atual.temperatura)) && telemetriaMs !== null;
  db.prepare(`
    INSERT INTO energia_estados (sala, ligado, temperaturaAlvo, temperaturaAmbiente, telemetriaEm, processadoAte)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(sala) DO UPDATE SET
      ligado = excluded.ligado,
      temperaturaAlvo = excluded.temperaturaAlvo,
      temperaturaAmbiente = excluded.temperaturaAmbiente,
      telemetriaEm = excluded.telemetriaEm,
      processadoAte = excluded.processadoAte
  `).run(atual.sala, atual.ligado ? 1 : 0, Number(atual.temperaturaAlvo), ambienteValido ? Number(atual.temperatura) : null, ambienteValido ? atual.ultimoHeartbeat : null, sqlData(agoraMs));
  return atual;
}

function acumularTrecho(estado, inicioMs, fimMs) {
  const segundos = Math.max(0, (fimMs - inicioMs) / 1000);
  if (segundos <= 0) return;
  const telemetriaMs = epochSql(estado.telemetriaEm);
  const temAmbiente = Number.isFinite(Number(estado.temperaturaAmbiente)) && telemetriaMs !== null;
  const fimTelemetria = temAmbiente ? telemetriaMs + TELEMETRIA_VALIDA_MS : inicioMs;
  const inicioCoberto = temAmbiente ? Math.max(inicioMs, telemetriaMs) : fimMs;
  const segundosTelemetria = Math.max(0, (Math.min(fimMs, fimTelemetria) - inicioCoberto) / 1000);
  const ligado = !!estado.ligado;
  const fatorComTelemetria = fatorInverter(Number(estado.temperaturaAmbiente), Number(estado.temperaturaAlvo));
  const cargaInverter = ligado
    ? segundosTelemetria * fatorComTelemetria + (segundos - segundosTelemetria) * FATOR_INVERTER_SEM_TELEMETRIA
    : 0;
  const ambiente = Number(estado.temperaturaAmbiente);
  const minimo = segundosTelemetria > 0 ? ambiente : null;
  const maximo = segundosTelemetria > 0 ? ambiente : null;
  db.prepare(`
    INSERT INTO energia_resumos_diarios (
      sala, data, segundosObservados, segundosLigado, segundosCargaInverter,
      segundosTelemetriaLigado, temperaturaAlvoPonderada,
      temperaturaAmbientePonderada, segundosTemperaturaAmbiente,
      temperaturaAmbienteMin, temperaturaAmbienteMax, atualizadoEm
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(sala, data) DO UPDATE SET
      segundosObservados = segundosObservados + excluded.segundosObservados,
      segundosLigado = segundosLigado + excluded.segundosLigado,
      segundosCargaInverter = segundosCargaInverter + excluded.segundosCargaInverter,
      segundosTelemetriaLigado = segundosTelemetriaLigado + excluded.segundosTelemetriaLigado,
      temperaturaAlvoPonderada = temperaturaAlvoPonderada + excluded.temperaturaAlvoPonderada,
      temperaturaAmbientePonderada = temperaturaAmbientePonderada + excluded.temperaturaAmbientePonderada,
      segundosTemperaturaAmbiente = segundosTemperaturaAmbiente + excluded.segundosTemperaturaAmbiente,
      temperaturaAmbienteMin = CASE WHEN temperaturaAmbienteMin IS NULL THEN excluded.temperaturaAmbienteMin WHEN excluded.temperaturaAmbienteMin IS NULL THEN temperaturaAmbienteMin ELSE MIN(temperaturaAmbienteMin, excluded.temperaturaAmbienteMin) END,
      temperaturaAmbienteMax = CASE WHEN temperaturaAmbienteMax IS NULL THEN excluded.temperaturaAmbienteMax WHEN excluded.temperaturaAmbienteMax IS NULL THEN temperaturaAmbienteMax ELSE MAX(temperaturaAmbienteMax, excluded.temperaturaAmbienteMax) END,
      atualizadoEm = datetime('now')
  `).run(
    estado.sala,
    dataLocal(inicioMs),
    segundos,
    ligado ? segundos : 0,
    cargaInverter,
    ligado ? segundosTelemetria : 0,
    ligado ? Number(estado.temperaturaAlvo) * segundos : 0,
    segundosTelemetria > 0 ? ambiente * segundosTelemetria : 0,
    segundosTelemetria,
    minimo,
    maximo
  );
}

function consolidarSala(sala, agora = new Date()) {
  const fimMs = agora instanceof Date ? agora.getTime() : Number(agora);
  if (!Number.isFinite(fimMs)) throw new Error("instante invalido");
  let estado = db.prepare("SELECT * FROM energia_estados WHERE sala = ?").get(sala);
  if (!estado) {
    inserirEstadoAtual(sala, fimMs);
    return 0;
  }
  const originalMs = epochSql(estado.processadoAte);
  if (originalMs === null || originalMs >= fimMs) {
    db.prepare("UPDATE energia_estados SET processadoAte = ? WHERE sala = ?").run(sqlData(fimMs), sala);
    return 0;
  }
  let inicioMs = Math.max(originalMs, fimMs - INTERVALO_MAXIMO_MS);
  let total = 0;
  while (inicioMs < fimMs) {
    const trechoFim = Math.min(fimMs, inicioProximoDia(inicioMs));
    acumularTrecho(estado, inicioMs, trechoFim);
    total += (trechoFim - inicioMs) / 1000;
    inicioMs = trechoFim;
  }
  db.prepare("UPDATE energia_estados SET processadoAte = ? WHERE sala = ?").run(sqlData(fimMs), sala);
  return total;
}

function sincronizarSala(sala, agora = new Date()) {
  const agoraMs = agora instanceof Date ? agora.getTime() : Number(agora);
  consolidarSala(sala, agoraMs);
  return inserirEstadoAtual(sala, agoraMs);
}

function consolidarTodas(agora = new Date()) {
  const salas = db.prepare("SELECT sala FROM salas").all();
  let processadas = 0;
  for (const { sala } of salas) {
    try {
      sincronizarSala(sala, agora);
      processadas += 1;
    } catch (erro) {
      logger.warn("energia-consolidacao-falhou", { sala, mensagem: erro.message });
    }
  }
  return processadas;
}

function configurar(sala, dados) {
  if (!salaAtual(sala)) throw new Error("sala nao encontrada");
  consolidarSala(sala);
  const semPotencia = dados.potenciaWatts === null || dados.potenciaWatts === undefined || dados.potenciaWatts === "";
  if (semPotencia) {
    db.prepare("DELETE FROM energia_configuracoes WHERE sala = ?").run(sala);
    return null;
  }
  const potenciaWatts = Number(dados.potenciaWatts);
  const tipo = String(dados.tipo || "");
  if (!Number.isInteger(potenciaWatts) || potenciaWatts < POTENCIA_MIN || potenciaWatts > POTENCIA_MAX) {
    throw new Error(`potenciaWatts deve ser um inteiro entre ${POTENCIA_MIN} e ${POTENCIA_MAX}`);
  }
  if (!TIPOS.has(tipo)) throw new Error("tipo deve ser inverter ou fixo");
  db.prepare(`
    INSERT INTO energia_configuracoes (sala, potenciaWatts, tipo, atualizadoEm)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(sala) DO UPDATE SET potenciaWatts = excluded.potenciaWatts, tipo = excluded.tipo, atualizadoEm = datetime('now')
  `).run(sala, potenciaWatts, tipo);
  return { potenciaWatts, tipo };
}

function agregarDesde(dataInicio) {
  const linhas = db.prepare(`
    SELECT sala,
      SUM(segundosObservados) segundosObservados,
      SUM(segundosLigado) segundosLigado,
      SUM(segundosCargaInverter) segundosCargaInverter,
      SUM(segundosTelemetriaLigado) segundosTelemetriaLigado,
      SUM(temperaturaAlvoPonderada) temperaturaAlvoPonderada,
      SUM(temperaturaAmbientePonderada) temperaturaAmbientePonderada,
      SUM(segundosTemperaturaAmbiente) segundosTemperaturaAmbiente
    FROM energia_resumos_diarios WHERE data >= ? GROUP BY sala
  `).all(dataInicio);
  return new Map(linhas.map((linha) => [linha.sala, linha]));
}

function arredondar(valor, casas = 2) {
  if (!Number.isFinite(valor)) return null;
  const fator = 10 ** casas;
  return Math.round(valor * fator) / fator;
}

function estimativaPeriodo(linha, config, segundosPeriodo) {
  const observados = Number(linha?.segundosObservados || 0);
  const ligado = Number(linha?.segundosLigado || 0);
  const telemetria = Number(linha?.segundosTelemetriaLigado || 0);
  const cargaSegundos = config?.tipo === "fixo" ? ligado : Number(linha?.segundosCargaInverter || 0);
  const kwh = config ? (config.potenciaWatts / 1000) * (cargaSegundos / 3600) : null;
  return {
    kwhEstimado: arredondar(kwh, 3),
    horasLigado: arredondar(ligado / 3600, 2),
    potenciaMediaEstimadaWatts: config && ligado > 0 ? arredondar(config.potenciaWatts * cargaSegundos / ligado, 0) : config ? 0 : null,
    temperaturaAlvoMedia: ligado > 0 ? arredondar(Number(linha?.temperaturaAlvoPonderada || 0) / ligado, 1) : null,
    temperaturaAmbienteMedia: Number(linha?.segundosTemperaturaAmbiente || 0) > 0 ? arredondar(Number(linha.temperaturaAmbientePonderada || 0) / Number(linha.segundosTemperaturaAmbiente), 1) : null,
    coberturaObservacaoPercentual: arredondar(Math.min(100, observados / Math.max(1, segundosPeriodo) * 100), 1),
    coberturaTelemetriaPercentual: ligado > 0 ? arredondar(Math.min(100, telemetria / ligado * 100), 1) : null,
  };
}

function nivelConfianca(config, periodo) {
  if (!config) return "nao_aplicavel";
  if (periodo.coberturaObservacaoPercentual < 50) return "baixa";
  if (config.tipo === "fixo") return periodo.coberturaObservacaoPercentual >= 80 ? "alta" : "media";
  if ((periodo.coberturaTelemetriaPercentual || 0) >= 80 && periodo.coberturaObservacaoPercentual >= 80) return "alta";
  if ((periodo.coberturaTelemetriaPercentual || 0) >= 30) return "media";
  return "baixa";
}

function listar() {
  const agoraMs = Date.now();
  consolidarTodas(new Date(agoraMs));
  const hoje = dataLocal(agoraMs);
  const inicioHojeMs = inicioDataLocal(hoje);
  const inicio7 = dataLocal(inicioHojeMs - 6 * 86400000);
  const inicio30 = dataLocal(inicioHojeMs - 29 * 86400000);
  const hojeMap = agregarDesde(hoje);
  const seteMap = agregarDesde(inicio7);
  const trintaMap = agregarDesde(inicio30);
  const segundosHoje = Math.max(1, (agoraMs - inicioHojeMs) / 1000);
  const salas = db.prepare(`
    SELECT s.sala, s.nome, s.bloco, s.andar, s.ligado, s.temperatura, s.temperaturaAlvo, s.ultimoHeartbeat,
      c.potenciaWatts, c.tipo
    FROM salas s LEFT JOIN energia_configuracoes c ON c.sala = s.sala
    ORDER BY s.bloco, s.andar, s.sala
  `).all();
  return salas.map((sala) => {
    const config = sala.potenciaWatts ? { potenciaWatts: Number(sala.potenciaWatts), tipo: sala.tipo } : null;
    const telemetriaMs = epochSql(sala.ultimoHeartbeat);
    const telemetriaAtual = telemetriaMs !== null && agoraMs - telemetriaMs <= TELEMETRIA_VALIDA_MS;
    const temperaturaAmbiente = telemetriaAtual && Number.isFinite(Number(sala.temperatura)) ? Number(sala.temperatura) : null;
    const cargaAtual = !sala.ligado ? 0 : config?.tipo === "fixo" ? 1 : fatorInverter(temperaturaAmbiente, Number(sala.temperaturaAlvo));
    const hojePeriodo = estimativaPeriodo(hojeMap.get(sala.sala), config, segundosHoje);
    const setePeriodo = estimativaPeriodo(seteMap.get(sala.sala), config, 7 * 86400);
    const trintaPeriodo = estimativaPeriodo(trintaMap.get(sala.sala), config, 30 * 86400);
    return {
      sala: sala.sala,
      nome: sala.nome,
      bloco: sala.bloco,
      andar: sala.andar,
      configuracao: config,
      ligado: !!sala.ligado,
      cargaAtualPercentual: config ? arredondar(cargaAtual * 100, 0) : null,
      potenciaAtualEstimadaWatts: config ? arredondar(config.potenciaWatts * cargaAtual, 0) : null,
      temperaturaAlvo: Number(sala.temperaturaAlvo),
      temperaturaAmbiente,
      hoje: hojePeriodo,
      seteDias: setePeriodo,
      trintaDias: trintaPeriodo,
      confianca: nivelConfianca(config, trintaPeriodo),
      parcial: !!config && (trintaPeriodo.coberturaObservacaoPercentual < 80 || (config.tipo === "inverter" && (trintaPeriodo.coberturaTelemetriaPercentual || 0) < 80)),
    };
  });
}

function modelo() {
  return {
    rotulo: "Estimativa, nao e medicao para faturamento",
    formula: "kWh estimado = potencia eletrica nominal (kW) x horas ligadas x fator de carga estimado",
    fatorFixo: 1,
    fatorInverterSemTelemetria: FATOR_INVERTER_SEM_TELEMETRIA,
    fatorInverter: "limite(0,35 + max(0, temperatura ambiente - temperatura alvo) x 0,12; 0,35; 1,00)",
    validadeTelemetriaMinutos: TELEMETRIA_VALIDA_MS / 60000,
    potenciaNaoRepresenta: "capacidade termica em BTU/h",
  };
}

module.exports = {
  configurar,
  listar,
  modelo,
  consolidarSala,
  sincronizarSala,
  consolidarTodas,
  fatorInverter,
  estimativaPeriodo,
  POTENCIA_MIN,
  POTENCIA_MAX,
  FATOR_INVERTER_SEM_TELEMETRIA,
};

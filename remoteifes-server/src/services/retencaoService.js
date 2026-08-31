const db = require("../config/database");
const logger = require("../utils/logger");
const { dataAtualBrasiliaISO } = require("../utils/tempo");

function normalizarDiasRetencao(valor, padrao) {
  if (valor === undefined || valor === null || valor === "") return padrao;
  if (!/^\d+$/.test(String(valor).trim())) return padrao;
  const dias = Number(valor);
  return Number.isSafeInteger(dias) && dias >= 1 && dias <= 36500 ? dias : padrao;
}

const DIAS_LOGS = normalizarDiasRetencao(process.env.RETENCAO_DIAS_LOGS, 180);
const DIAS_SESSOES = normalizarDiasRetencao(process.env.RETENCAO_DIAS_SESSOES, 90);
const DIAS_EXECUCOES = normalizarDiasRetencao(process.env.RETENCAO_DIAS_EXECUCOES, 90);
const DIAS_DETECCOES = normalizarDiasRetencao(process.env.RETENCAO_DIAS_DETECCOES, 30);
const DIAS_NOTIFICACOES = normalizarDiasRetencao(process.env.RETENCAO_DIAS_NOTIFICACOES, 365);
const DIAS_RELATOS_RESOLVIDOS = normalizarDiasRetencao(process.env.RETENCAO_DIAS_RELATOS_RESOLVIDOS, 0);
const DIAS_AGENDAMENTOS = normalizarDiasRetencao(process.env.RETENCAO_DIAS_AGENDAMENTOS, 90);

const LIMITES_LINHAS = {
  auditoria_eventos: 50000,
  esp_indisponibilidades: 20000,
  comandos_log: 100000,
  esp_eventos: 50000,
  esp_acessos: 50000,
  notificacoes: 20000,
  sessoes: 50000,
  agendamentos_execucoes: 50000,
  energia_resumos_diarios: 50000,
};
let cacheEstatisticas = null;
let cacheEstatisticasEm = 0;

function diasAuditoria() {
  const valor = require("./configuracoesService").obter().retencaoAuditoriaDias;
  return Number.isInteger(valor) && valor >= 1 && valor <= 365 ? valor : 7;
}

function alvosTemporais() {
  const diasHistorico = diasAuditoria();
  const alvos = [
    { nome: "auditoria_eventos", sql: "DELETE FROM auditoria_eventos WHERE criadoEm < datetime('now', ?)", dias: diasHistorico },
    { nome: "esp_indisponibilidades", sql: "DELETE FROM esp_indisponibilidades WHERE offlineEm < datetime('now', ?)", dias: diasHistorico },
    { nome: "energia_resumos_diarios", sql: "DELETE FROM energia_resumos_diarios WHERE data < date(?, ?)", dias: 45, dataLocal: true },
    { nome: "comandos_log", sql: "DELETE FROM comandos_log WHERE criadoEm < datetime('now', ?)", dias: DIAS_LOGS },
    { nome: "esp_eventos", sql: "DELETE FROM esp_eventos WHERE criadoEm < datetime('now', ?)", dias: DIAS_LOGS },
    { nome: "esp_acessos", sql: "DELETE FROM esp_acessos WHERE criadoEm < datetime('now', ?)", dias: DIAS_LOGS },
    { nome: "notificacoes", sql: "DELETE FROM notificacoes WHERE lida = 1 AND criadoEm < datetime('now', ?)", dias: DIAS_LOGS },
    { nome: "notificacoes_antigas", sql: "DELETE FROM notificacoes WHERE criadoEm < datetime('now', ?)", dias: DIAS_NOTIFICACOES },
    { nome: "agendamentos_execucoes", sql: "DELETE FROM agendamentos_execucoes WHERE executadoEm < datetime('now', ?)", dias: DIAS_EXECUCOES },
    { nome: "agendamentos_execucoes_orfas", sql: "DELETE FROM agendamentos_execucoes WHERE agendamentoId IN (SELECT id FROM agendamentos WHERE data < date('now', ?))", dias: DIAS_AGENDAMENTOS },
    { nome: "agendamentos_passados", sql: "DELETE FROM agendamentos WHERE data < date('now', ?)", dias: DIAS_AGENDAMENTOS },
    { nome: "sessoes", sql: "DELETE FROM sessoes WHERE logout IS NOT NULL AND logout < datetime('now', ?)", dias: DIAS_SESSOES },
    { nome: "esp_detectados", sql: "DELETE FROM esp_detectados WHERE ultimaDeteccao < datetime('now', ?) AND mac NOT IN (SELECT mac FROM salas WHERE mac IS NOT NULL)", dias: DIAS_DETECCOES },
  ];
  if (DIAS_RELATOS_RESOLVIDOS > 0) {
    alvos.push({ nome: "relatos_resolvidos", sql: "DELETE FROM relatos WHERE status = 'resolvido' AND atualizadoEm < datetime('now', ?)", dias: DIAS_RELATOS_RESOLVIDOS });
  }
  return alvos;
}

function aplicarLimite(tabela, limite) {
  if (tabela === "sessoes") {
    return db.prepare(`DELETE FROM sessoes WHERE id IN (
      SELECT id FROM sessoes WHERE logout IS NOT NULL ORDER BY COALESCE(logout, login) DESC LIMIT -1 OFFSET ?
    )`).run(limite).changes;
  }
  const coluna = tabela === "esp_indisponibilidades" ? "offlineEm" : tabela === "agendamentos_execucoes" ? "executadoEm" : tabela === "energia_resumos_diarios" ? "data" : "criadoEm";
  if (tabela === "energia_resumos_diarios") {
    return db.prepare(`DELETE FROM energia_resumos_diarios WHERE rowid IN (
      SELECT rowid FROM energia_resumos_diarios ORDER BY data DESC, sala DESC LIMIT -1 OFFSET ?
    )`).run(limite).changes;
  }
  return db.prepare(`DELETE FROM ${tabela} WHERE id IN (
    SELECT id FROM ${tabela} ORDER BY ${coluna} DESC, id DESC LIMIT -1 OFFSET ?
  )`).run(limite).changes;
}

function manutencaoLeve(algoRemovido) {
  try {
    db.exec(algoRemovido ? "PRAGMA wal_checkpoint(TRUNCATE)" : "PRAGMA wal_checkpoint(PASSIVE)");
    db.exec("PRAGMA optimize");
    const modo = Number(db.prepare("PRAGMA auto_vacuum").get().auto_vacuum);
    if (algoRemovido && modo === 2) db.exec("PRAGMA incremental_vacuum(200)");
  } catch (erro) {
    logger.warn("retencao-manutencao-falhou", { mensagem: erro.message });
  }
}

function executarLimpezaRetencao() {
  const resumo = {};
  let algoRemovido = false;
  for (const alvo of alvosTemporais()) {
    try {
      const argumentos = alvo.dataLocal ? [dataAtualBrasiliaISO(), `-${alvo.dias} days`] : [`-${alvo.dias} days`];
      const removidos = Number(db.prepare(alvo.sql).run(...argumentos).changes);
      if (removidos > 0) { resumo[alvo.nome] = removidos; algoRemovido = true; }
    } catch (erro) {
      logger.warn("retencao-falhou", { tabela: alvo.nome, mensagem: erro.message });
    }
  }
  for (const [tabela, limite] of Object.entries(LIMITES_LINHAS)) {
    try {
      const removidos = Number(aplicarLimite(tabela, limite));
      if (removidos > 0) { resumo[`${tabela}_excedente`] = removidos; algoRemovido = true; }
    } catch (erro) {
      logger.warn("retencao-limite-falhou", { tabela, mensagem: erro.message });
    }
  }
  if (algoRemovido) logger.info("retencao-concluida", resumo);
  if (algoRemovido) cacheEstatisticas = null;
  manutencaoLeve(algoRemovido);
  return resumo;
}

function estatisticasTabelas() {
  if (cacheEstatisticas && Date.now() - cacheEstatisticasEm < 60000) return cacheEstatisticas;
  const resultado = {};
  for (const [tabela, limite] of Object.entries(LIMITES_LINHAS)) {
    const total = Number(db.prepare(`SELECT COUNT(*) n FROM ${tabela}`).get().n);
    resultado[tabela] = { total, limite, usoPercentual: Math.round((total / limite) * 1000) / 10 };
  }
  cacheEstatisticas = resultado;
  cacheEstatisticasEm = Date.now();
  return cacheEstatisticas;
}

module.exports = { executarLimpezaRetencao, normalizarDiasRetencao, estatisticasTabelas, LIMITES_LINHAS, diasAuditoria };

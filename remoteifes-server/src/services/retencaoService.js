const db = require("../config/database");
const logger = require("../utils/logger");

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

const ALVOS = [
  { nome: "comandos_log", sql: `DELETE FROM comandos_log WHERE criadoEm < datetime('now', ?)`, dias: DIAS_LOGS },
  { nome: "esp_eventos", sql: `DELETE FROM esp_eventos WHERE criadoEm < datetime('now', ?)`, dias: DIAS_LOGS },
  { nome: "esp_acessos", sql: `DELETE FROM esp_acessos WHERE criadoEm < datetime('now', ?)`, dias: DIAS_LOGS },
  { nome: "notificacoes", sql: `DELETE FROM notificacoes WHERE lida = 1 AND criadoEm < datetime('now', ?)`, dias: DIAS_LOGS },
  { nome: "agendamentos_execucoes", sql: `DELETE FROM agendamentos_execucoes WHERE executadoEm < datetime('now', ?)`, dias: DIAS_EXECUCOES },
  { nome: "sessoes", sql: `DELETE FROM sessoes WHERE logout IS NOT NULL AND logout < datetime('now', ?)`, dias: DIAS_SESSOES },
  {
    nome: "esp_detectados",
    sql: `DELETE FROM esp_detectados WHERE ultimaDeteccao < datetime('now', ?)
          AND mac NOT IN (SELECT mac FROM salas WHERE mac IS NOT NULL)`,
    dias: DIAS_DETECCOES,
  },
];

function executarLimpezaRetencao() {
  const resumo = {};
  let algoRemovido = false;
  for (const alvo of ALVOS) {
    try {
      const resultado = db.prepare(alvo.sql).run(`-${alvo.dias} days`);
      if (resultado.changes > 0) {
        resumo[alvo.nome] = Number(resultado.changes);
        algoRemovido = true;
      }
    } catch (erro) {
      logger.warn("retencao-falhou", { tabela: alvo.nome, mensagem: erro.message });
    }
  }
  if (algoRemovido) {
    logger.info("retencao-concluida", resumo);
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (erro) {
      logger.warn("retencao-checkpoint-falhou", { mensagem: erro.message });
    }
  }
  return resumo;
}

module.exports = { executarLimpezaRetencao, normalizarDiasRetencao };

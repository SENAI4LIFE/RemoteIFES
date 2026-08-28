const { aplicarComando, aplicarInicioAgendamento, verificarTimeouts, agendamentoOcorreHoje } = require("../services/salasService");
const {
  listarAtivosParaAgendador,
  registrarExecucao,
  jaExecutadoHoje,
} = require("../services/agendamentosService");
const { encerrarSessoesAbandonadas } = require("../services/tokenService");
const { executarLimpezaRetencao } = require("../services/retencaoService");
const { criarBackup, normalizarInteiro } = require("../services/backupService");
const { horaAtualBrasilia, dataAtualBrasiliaISO } = require("../utils/tempo");
const logger = require("../utils/logger");

const VERIFICACAO_MS = 60 * 1000;
const VERIFICACAO_TIMEOUT_MS = 30 * 1000;
const VERIFICACAO_SESSOES_MS = 15 * 60 * 1000;
const VERIFICACAO_RETENCAO_MS = 6 * 60 * 60 * 1000;

const BACKUP_AUTOMATICO = String(
  process.env.BACKUP_AUTOMATICO ?? (process.env.NODE_ENV === "production" ? "true" : "false")
).toLowerCase() === "true";
const BACKUP_INTERVALO_MS = normalizarInteiro(process.env.BACKUP_INTERVALO_HORAS, 24, 1, 8760) * 60 * 60 * 1000;

function verificarAgendamentos() {
  const hora = horaAtualBrasilia();
  const dataISO = dataAtualBrasiliaISO();

  for (const ag of listarAtivosParaAgendador()) {
    try {
      if (!agendamentoOcorreHoje(ag, dataISO)) continue;
      if (ag.modo === "reserva") continue;

      const inicioLigar = ag.modo === "ligar_intervalo" ? ag.ligarInicio : ag.horaInicio;
      const fimLigar = ag.modo === "ligar_intervalo" ? ag.ligarFim : ag.horaFim;

      if (estaNaJanelaDeLigar(hora, inicioLigar, fimLigar) && !jaExecutadoHoje(ag.id, "ligar", dataISO)) {
        aplicarInicioAgendamento(ag.sala, ag.temperatura);
        registrarExecucao(ag.id, "ligar", dataISO);
      }
      if (hora >= fimLigar && !jaExecutadoHoje(ag.id, "desligar", dataISO)) {
        aplicarComando(ag.sala, "desligar", undefined, { usuario: null, origem: "agendamento" });
        registrarExecucao(ag.id, "desligar", dataISO);
      }
    } catch (erro) {
      logger.error("agendamento-falhou", { agendamentoId: ag.id, sala: ag.sala, mensagem: erro.message });
    }
  }
}

function estaNaJanelaDeLigar(hora, inicio, fim) {
  return hora >= inicio && hora < fim;
}

const timers = [];

function executarProtegido(fn, rotulo) {
  try {
    fn();
  } catch (erro) {
    logger.error("scheduler-tarefa-falhou", { tarefa: rotulo, mensagem: erro && erro.message });
  }
}

function agendarPeriodico(fn, intervaloMs, rotulo) {
  const timer = setInterval(() => executarProtegido(fn, rotulo), intervaloMs);
  if (typeof timer.unref === "function") timer.unref();
  timers.push(timer);
}

function executarBackupAutomatico() {
  criarBackup();
}

function iniciarScheduler() {
  pararScheduler();
  agendarPeriodico(verificarAgendamentos, VERIFICACAO_MS, "agendamentos");
  agendarPeriodico(verificarTimeouts, VERIFICACAO_TIMEOUT_MS, "timeouts-esp32");
  agendarPeriodico(encerrarSessoesAbandonadas, VERIFICACAO_SESSOES_MS, "sessoes-abandonadas");
  agendarPeriodico(executarLimpezaRetencao, VERIFICACAO_RETENCAO_MS, "retencao");
  executarProtegido(encerrarSessoesAbandonadas, "sessoes-abandonadas-inicial");
  const timerRetencaoInicial = setTimeout(() => {
    executarProtegido(executarLimpezaRetencao, "retencao-inicial");
  }, 10000);
  if (typeof timerRetencaoInicial.unref === "function") timerRetencaoInicial.unref();
  timers.push(timerRetencaoInicial);
  if (BACKUP_AUTOMATICO) {
    agendarPeriodico(executarBackupAutomatico, BACKUP_INTERVALO_MS, "backup");
    const timerBackupInicial = setTimeout(() => {
      executarProtegido(executarBackupAutomatico, "backup-inicial");
    }, 20000);
    if (typeof timerBackupInicial.unref === "function") timerBackupInicial.unref();
    timers.push(timerBackupInicial);
  }
  const infoBackup = BACKUP_AUTOMATICO
    ? `, backup automático a cada ${BACKUP_INTERVALO_MS / (60 * 60 * 1000)}h`
    : "";
  console.log(`Agendador iniciado (agendamentos a cada minuto, checagem de ESPs offline a cada 30s, sessões abandonadas a cada 15min, retenção do banco a cada 6h${infoBackup}).`);
}

function pararScheduler() {
  while (timers.length) {
    const t = timers.pop();
    clearInterval(t);
    clearTimeout(t);
  }
}

module.exports = { iniciarScheduler, pararScheduler, estaNaJanelaDeLigar };

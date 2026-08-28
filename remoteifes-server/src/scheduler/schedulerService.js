const { aplicarComando, aplicarInicioAgendamento, verificarTimeouts, agendamentoOcorreHoje } = require("../services/salasService");
const {
  listarAtivosParaAgendador,
  registrarExecucao,
  jaExecutadoHoje,
} = require("../services/agendamentosService");
const { encerrarSessoesAbandonadas } = require("../services/tokenService");
const { executarLimpezaRetencao } = require("../services/retencaoService");
const { horaAtualBrasilia, dataAtualBrasiliaISO } = require("../utils/tempo");
const logger = require("../utils/logger");

const VERIFICACAO_MS = 60 * 1000;
const VERIFICACAO_TIMEOUT_MS = 30 * 1000;
const VERIFICACAO_SESSOES_MS = 15 * 60 * 1000;
const VERIFICACAO_RETENCAO_MS = 6 * 60 * 60 * 1000;

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

function iniciarScheduler() {
  // Torna a inicialização idempotente em reloads/testes e evita tarefas duplicadas.
  pararScheduler();
  agendarPeriodico(verificarAgendamentos, VERIFICACAO_MS, "agendamentos");
  agendarPeriodico(verificarTimeouts, VERIFICACAO_TIMEOUT_MS, "timeouts-esp32");
  agendarPeriodico(encerrarSessoesAbandonadas, VERIFICACAO_SESSOES_MS, "sessoes-abandonadas");
  agendarPeriodico(executarLimpezaRetencao, VERIFICACAO_RETENCAO_MS, "retencao");
  executarProtegido(encerrarSessoesAbandonadas, "sessoes-abandonadas-inicial");
  // Primeira limpeza logo após o boot, sem competir com a subida do servidor.
  const timerRetencaoInicial = setTimeout(() => {
    executarProtegido(executarLimpezaRetencao, "retencao-inicial");
  }, 10000);
  if (typeof timerRetencaoInicial.unref === "function") timerRetencaoInicial.unref();
  timers.push(timerRetencaoInicial);
  console.log("Agendador iniciado (agendamentos a cada minuto, checagem de ESPs offline a cada 30s, sessões abandonadas a cada 15min, retenção do banco a cada 6h).");
}

function pararScheduler() {
  while (timers.length) {
    const t = timers.pop();
    clearInterval(t);
    clearTimeout(t);
  }
}

module.exports = { iniciarScheduler, pararScheduler, estaNaJanelaDeLigar };

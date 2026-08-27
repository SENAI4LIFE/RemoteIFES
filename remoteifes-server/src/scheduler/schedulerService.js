const { aplicarComando, aplicarInicioAgendamento, verificarTimeouts, agendamentoOcorreHoje } = require("../services/salasService");
const {
  listarAtivosParaAgendador,
  registrarExecucao,
  jaExecutadoHoje,
} = require("../services/agendamentosService");
const { encerrarSessoesAbandonadas } = require("../services/tokenService");
const { horaAtualBrasilia, dataAtualBrasiliaISO } = require("../utils/tempo");
const logger = require("../utils/logger");

const VERIFICACAO_MS = 60 * 1000;
const VERIFICACAO_TIMEOUT_MS = 30 * 1000;
const VERIFICACAO_SESSOES_MS = 15 * 60 * 1000;

function verificarAgendamentos() {
  const hora = horaAtualBrasilia();
  const dataISO = dataAtualBrasiliaISO();

  for (const ag of listarAtivosParaAgendador()) {
    try {
      if (!agendamentoOcorreHoje(ag, dataISO)) continue;
      if (ag.modo === "reserva") continue;

      const inicioLigar = ag.modo === "ligar_intervalo" ? ag.ligarInicio : ag.horaInicio;
      const fimLigar = ag.modo === "ligar_intervalo" ? ag.ligarFim : ag.horaFim;

      if (hora >= inicioLigar && hora <= fimLigar && !jaExecutadoHoje(ag.id, "ligar", dataISO)) {
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

function iniciarScheduler() {
  setInterval(verificarAgendamentos, VERIFICACAO_MS);
  setInterval(verificarTimeouts, VERIFICACAO_TIMEOUT_MS);
  setInterval(encerrarSessoesAbandonadas, VERIFICACAO_SESSOES_MS);
  encerrarSessoesAbandonadas();
  console.log("Agendador iniciado (agendamentos a cada minuto, checagem de ESPs offline a cada 30s, sessões abandonadas a cada 15min).");
}

module.exports = { iniciarScheduler };

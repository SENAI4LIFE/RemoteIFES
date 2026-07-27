const { aplicarComando, verificarTimeouts, agendamentoOcorreHoje } = require("../services/salasService");
const {
  listarAtivosParaAgendador,
  registrarExecucao,
} = require("../services/agendamentosService");
const { encerrarSessoesAbandonadas } = require("../services/tokenService");
const { horaAtualBrasilia, diaAtualBrasilia, dataAtualBrasiliaISO } = require("../utils/tempo");

const VERIFICACAO_MS = 60 * 1000;
const VERIFICACAO_TIMEOUT_MS = 30 * 1000;
const VERIFICACAO_SESSOES_MS = 15 * 60 * 1000;

function verificarAgendamentos() {
  const hora = horaAtualBrasilia();
  const dia = diaAtualBrasilia();
  const dataISO = dataAtualBrasiliaISO();

  for (const ag of listarAtivosParaAgendador()) {
    if (!agendamentoOcorreHoje(ag, dia, dataISO)) continue;

    if (ag.modo === "reserva") continue;

    const inicioLigar = ag.modo === "ligar_intervalo" ? ag.ligarInicio : ag.horaInicio;
    const fimLigar = ag.modo === "ligar_intervalo" ? ag.ligarFim : ag.horaFim;

    if (inicioLigar === hora) {
      aplicarComando(ag.sala, "ligar", undefined, { usuario: null, origem: "agendamento" });
      aplicarComando(ag.sala, "temperatura", ag.temperatura, { usuario: null, origem: "agendamento" });
      registrarExecucao(ag.id, "ligar");
    }
    if (fimLigar === hora) {
      aplicarComando(ag.sala, "desligar", undefined, { usuario: null, origem: "agendamento" });
      registrarExecucao(ag.id, "desligar");
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

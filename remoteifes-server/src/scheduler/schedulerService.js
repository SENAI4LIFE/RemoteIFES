const { aplicarComando, verificarTimeouts } = require("../services/salasService");
const {
  listarAtivosParaAgendador,
  registrarExecucao,
} = require("../services/agendamentosService");

const VERIFICACAO_MS = 60 * 1000;
const VERIFICACAO_TIMEOUT_MS = 30 * 1000;

function horaAtual() {
  return new Date().toTimeString().slice(0, 5);
}

function diaAtual() {
  return new Date().getDay();
}

function verificarAgendamentos() {
  const hora = horaAtual();
  const dia = diaAtual();

  for (const ag of listarAtivosParaAgendador()) {
    const dias = JSON.parse(ag.diasSemana);
    if (!dias.includes(dia)) continue;

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
  console.log("Agendador iniciado (agendamentos a cada minuto, checagem de ESPs offline a cada 30s).");
}

module.exports = { iniciarScheduler };

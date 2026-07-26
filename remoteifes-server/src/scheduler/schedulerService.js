const { aplicarComando } = require("../services/salasService");
const {
  listarAtivosParaAgendador,
  registrarExecucao,
} = require("../services/agendamentosService");

const VERIFICACAO_MS = 60 * 1000;

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

    if (ag.horaInicio === hora) {
      aplicarComando(ag.sala, "ligar", undefined, { usuario: null, origem: "agendamento" });
      aplicarComando(ag.sala, "temperatura", ag.temperatura, { usuario: null, origem: "agendamento" });
      registrarExecucao(ag.id, "ligar");
    }
    if (ag.horaFim === hora) {
      aplicarComando(ag.sala, "desligar", undefined, { usuario: null, origem: "agendamento" });
      registrarExecucao(ag.id, "desligar");
    }
  }
}

function iniciarScheduler() {
  setInterval(verificarAgendamentos, VERIFICACAO_MS);
  console.log("Agendador iniciado (verifica agendamentos a cada minuto).");
}

module.exports = { iniciarScheduler };

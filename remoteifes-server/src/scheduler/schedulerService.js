const { aplicarComando, aplicarInicioAgendamento, verificarTimeouts, agendamentoOcorreHoje, intencaoAlteradaDesde } = require("../services/salasService");
const {
  listarAtivosParaAgendador,
  listarDesligamentosPendentesDeOntem,
  registrarExecucao,
  jaExecutadoHoje,
} = require("../services/agendamentosService");
const { encerrarSessoesAbandonadas } = require("../services/tokenService");
const { executarLimpezaRetencao } = require("../services/retencaoService");
const { criarBackup, normalizarInteiro } = require("../services/backupService");
const otaService = require("../services/otaService");
const otaRolloutService = require("../services/otaRolloutService");
const monitoramentoService = require("../services/monitoramentoService");
const { horaAtualBrasilia, dataAtualBrasiliaISO, brasiliaParaUtcSqlite } = require("../utils/tempo");
const logger = require("../utils/logger");

const VERIFICACAO_MS = 60 * 1000;
const VERIFICACAO_TIMEOUT_MS = 30 * 1000;
const VERIFICACAO_SESSOES_MS = 15 * 60 * 1000;
const VERIFICACAO_RETENCAO_MS = 6 * 60 * 60 * 1000;
const VERIFICACAO_MONITORAMENTO_MS = 5 * 60 * 1000;
const AMOSTRA_MONITORAMENTO_MS = monitoramentoService.AMOSTRAGEM_SEGUNDOS * 1000;

const BACKUP_AUTOMATICO = String(
  process.env.BACKUP_AUTOMATICO ?? (process.env.NODE_ENV === "production" ? "true" : "false")
).toLowerCase() === "true";
const BACKUP_INTERVALO_MS = normalizarInteiro(process.env.BACKUP_INTERVALO_HORAS, 24, 1, 8760) * 60 * 60 * 1000;

// aoIniciar: primeira passagem, feita antes de qualquer placa reconectar — o estado desejado é só
// persistido (a reconexão o entrega), para que um OFF agendado pendente vença a restauração.
function verificarAgendamentos({ aoIniciar = false } = {}) {
  const hora = horaAtualBrasilia();
  const dataISO = dataAtualBrasiliaISO();
  const enviarAoDispositivo = !aoIniciar;

  // Um desligamento agendado que ficou pendente na virada do dia é aplicado uma única vez, a menos
  // que uma intenção mais nova (comando manual, outro agendamento, OFF local) tenha surgido depois
  // da hora em que ele era devido; sem isso o ar-condicionado ficaria ligado até alguém notar.
  for (const ag of listarDesligamentosPendentesDeOntem(dataISO)) {
    try {
      const fimLigar = ag.modo === "ligar_intervalo" ? ag.ligarFim : ag.horaFim;
      if (intencaoAlteradaDesde(ag.sala, brasiliaParaUtcSqlite(ag.data, fimLigar))) continue;
      aplicarComando(ag.sala, "desligar", undefined, {
        usuario: null,
        origem: "agendamento",
        registrarNaTransacao: () => registrarExecucao(ag.id, "desligar", ag.data),
        enviarAoDispositivo,
      });
      logger.warn("agendamento-desligamento-recuperado", { agendamentoId: ag.id, sala: ag.sala, data: ag.data, devidoAs: fimLigar });
    } catch (erro) {
      logger.error("agendamento-falhou", { agendamentoId: ag.id, sala: ag.sala, mensagem: erro.message });
      monitoramentoService.registrar("schedulerFalha", { tarefa: "agendamento", agendamentoId: ag.id });
    }
  }

  for (const ag of listarAtivosParaAgendador()) {
    try {
      if (!agendamentoOcorreHoje(ag, dataISO)) continue;
      if (ag.modo === "reserva") continue;

      const inicioLigar = ag.modo === "ligar_intervalo" ? ag.ligarInicio : ag.horaInicio;
      const fimLigar = ag.modo === "ligar_intervalo" ? ag.ligarFim : ag.horaFim;

      // O registro da execução entra na mesma transação da mudança de estado: ou os dois persistem
      // ou nenhum, para que uma falha (ou queda do servidor) entre eles não repita o comando no tick seguinte.
      if (estaNaJanelaDeLigar(hora, inicioLigar, fimLigar) && !jaExecutadoHoje(ag.id, "ligar", dataISO)) {
        aplicarInicioAgendamento(ag.sala, ag.temperatura, { registrarNaTransacao: () => registrarExecucao(ag.id, "ligar", dataISO), enviarAoDispositivo });
      }
      if (hora >= fimLigar && !jaExecutadoHoje(ag.id, "desligar", dataISO)) {
        aplicarComando(ag.sala, "desligar", undefined, {
          usuario: null,
          origem: "agendamento",
          registrarNaTransacao: () => registrarExecucao(ag.id, "desligar", dataISO),
          enviarAoDispositivo,
        });
      }
    } catch (erro) {
      logger.error("agendamento-falhou", { agendamentoId: ag.id, sala: ag.sala, mensagem: erro.message });
      monitoramentoService.registrar("schedulerFalha", { tarefa: "agendamento", agendamentoId: ag.id });
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
    monitoramentoService.registrar("schedulerFalha", { tarefa: rotulo });
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
  agendarPeriodico(otaService.verificarTimeouts, VERIFICACAO_TIMEOUT_MS, "timeouts-ota");
  agendarPeriodico(otaRolloutService.tick, VERIFICACAO_TIMEOUT_MS, "rollout-ota");
  agendarPeriodico(monitoramentoService.avaliar, VERIFICACAO_MONITORAMENTO_MS, "monitoramento");
  agendarPeriodico(monitoramentoService.amostrar, AMOSTRA_MONITORAMENTO_MS, "monitoramento-amostra");
  agendarPeriodico(encerrarSessoesAbandonadas, VERIFICACAO_SESSOES_MS, "sessoes-abandonadas");
  agendarPeriodico(executarLimpezaRetencao, VERIFICACAO_RETENCAO_MS, "retencao");
  executarProtegido(() => verificarAgendamentos({ aoIniciar: true }), "agendamentos-inicial");
  executarProtegido(encerrarSessoesAbandonadas, "sessoes-abandonadas-inicial");
  const timerRetencaoInicial = setTimeout(() => {
    executarProtegido(executarLimpezaRetencao, "retencao-inicial");
  }, 10000);
  if (typeof timerRetencaoInicial.unref === "function") timerRetencaoInicial.unref();
  timers.push(timerRetencaoInicial);
  const timerAmostraInicial = setTimeout(() => {
    executarProtegido(monitoramentoService.amostrar, "monitoramento-amostra-inicial");
  }, 15000);
  if (typeof timerAmostraInicial.unref === "function") timerAmostraInicial.unref();
  timers.push(timerAmostraInicial);
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
  console.log(`Agendador iniciado (agendamentos a cada minuto, checagem de ESPs offline a cada 30s, sessões abandonadas a cada 15min, monitoramento a cada 5min com amostra de histórico a cada ${AMOSTRA_MONITORAMENTO_MS / 1000}s, retenção do banco a cada 6h${infoBackup}).`);
}

function pararScheduler() {
  while (timers.length) {
    const t = timers.pop();
    clearInterval(t);
    clearTimeout(t);
  }
}

module.exports = { iniciarScheduler, pararScheduler, estaNaJanelaDeLigar };

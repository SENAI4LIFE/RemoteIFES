const db = require("../config/database");
const configuracoesService = require("./configuracoesService");
const salasService = require("./salasService");
const agendamentosService = require("./agendamentosService");
const auditoriaService = require("./auditoriaService");
const monitoramentoService = require("./monitoramentoService");
const logger = require("../utils/logger");
const { dataAtualBrasiliaISO, brasiliaParaUtcSqlite, utcSqlite, deslocarDataISO } = require("../utils/tempo");

// Daily air conditioner shutdown: one durable OFF intent per day at the configured local time, not
// a curfew. Each (date, time, room) occurrence is recorded in the same transaction as the room's
// desired-state change, so a crash never marks unfinished work as done and never repeats it.
//
// Per room, the due occurrence resolves to one outcome:
//   desligado            ON at the cutoff: desired state becomes OFF (version advances)
//   ja_desligado         already OFF: nothing changes
//   intencao_mais_nova   a manual/scheduled/system command after the cutoff instant wins
//   agendamento_ativo    a schedule that turned the room on holds it across the cutoff; the
//                        schedule's own OFF ends it
// A manual ON after the occurrence was processed stays in effect until the next day's cutoff.

const RESULTADOS = ["desligado", "ja_desligado", "intencao_mais_nova", "agendamento_ativo"];

function configuracao() {
  return configuracoesService.normalizarDesligamentoDiario(configuracoesService.obter().desligamentoDiario);
}

/**
 * Most recent occurrence due at `agora`: today's cutoff if it has passed, otherwise yesterday's.
 * An occurrence due before the configuration took effect is not eligible, so enabling the
 * shutdown or changing its time or scope never applies retroactively.
 */
function ocorrenciaDevida(cfg, agora = new Date()) {
  if (!cfg.ativo) return null;
  const hoje = dataAtualBrasiliaISO(agora);
  const agoraSql = utcSqlite(agora);
  let data = hoje;
  let instante = brasiliaParaUtcSqlite(hoje, cfg.hora);
  if (agoraSql < instante) {
    data = deslocarDataISO(hoje, -1);
    instante = brasiliaParaUtcSqlite(data, cfg.hora);
  }
  if (cfg.vigenteDesde && instante < cfg.vigenteDesde) return null;
  return { data, hora: cfg.hora, instante };
}

function proximaOcorrencia(cfg, agora = new Date()) {
  if (!cfg.ativo) return null;
  const agoraSql = utcSqlite(agora);
  let data = dataAtualBrasiliaISO(agora);
  for (let i = 0; i < 3; i++) {
    const instante = brasiliaParaUtcSqlite(data, cfg.hora);
    if (instante > agoraSql && (!cfg.vigenteDesde || instante >= cfg.vigenteDesde)) return { data, hora: cfg.hora, instante };
    data = deslocarDataISO(data, 1);
  }
  return null;
}

function salasNoEscopo(cfg) {
  const todas = db.prepare("SELECT sala, ligado FROM salas ORDER BY sala").all();
  if (cfg.escopo === "todas") return todas;
  const selecionadas = new Set(cfg.salas);
  return todas.filter((s) => selecionadas.has(s.sala));
}

// Rooms held ON by a schedule whose turn-on window contains the cutoff and that actually turned the
// room on that day (and has not turned it off yet).
function salasMantidasPorAgendamento(data, hora) {
  const mantidas = new Set();
  for (const ag of agendamentosService.listarAtivosParaAgendador(data)) {
    if (ag.modo === "reserva") continue;
    const inicio = ag.modo === "ligar_intervalo" ? ag.ligarInicio : ag.horaInicio;
    const fim = ag.modo === "ligar_intervalo" ? ag.ligarFim : ag.horaFim;
    if (!(hora >= inicio && hora < fim)) continue;
    if (!agendamentosService.jaExecutadoHoje(ag.id, "ligar", data)) continue;
    if (agendamentosService.jaExecutadoHoje(ag.id, "desligar", data)) continue;
    mantidas.add(ag.sala);
  }
  return mantidas;
}

function auditar(ocorrencia, resumo) {
  const partes = [];
  if (resumo.desligado.length) partes.push(`${resumo.desligado.length} desligada(s)`);
  if (resumo.ja_desligado.length) partes.push(`${resumo.ja_desligado.length} ja desligada(s)`);
  if (resumo.intencao_mais_nova.length) partes.push(`${resumo.intencao_mais_nova.length} mantida(s) por comando posterior`);
  if (resumo.agendamento_ativo.length) partes.push(`${resumo.agendamento_ativo.length} mantida(s) por agendamento em curso`);
  if (resumo.falhas.length) partes.push(`${resumo.falhas.length} com falha`);
  try {
    auditoriaService.registrar({
      tipo: "desligamento_diario_executado",
      ator: null,
      alvoTipo: "desligamento_diario",
      alvoId: `${ocorrencia.data} ${ocorrencia.hora}`,
      alvoRotulo: `Desligamento diario ${ocorrencia.data} ${ocorrencia.hora}`,
      descricao: `Desligamento diario das ${ocorrencia.hora} de ${ocorrencia.data}: ${partes.join(", ") || "nenhuma sala"}`,
    });
  } catch (erro) {
    logger.warn("auditoria-registro-falhou", { tipo: "desligamento_diario_executado", mensagem: erro.message });
  }
}

/**
 * Processes the due occurrence for every room in scope that has not been processed yet.
 * Idempotent: repeated ticks and restarts only handle rooms without a record for the occurrence.
 *
 * @param {object} opcoes
 * @param {Date} [opcoes.agora]
 * @param {boolean} [opcoes.enviarAoDispositivo] false on the startup pass: reconnection delivers
 *   the persisted desired state.
 * @returns {object|null} per-outcome room lists, or null when nothing was due
 */
function verificar({ agora = new Date(), enviarAoDispositivo = true } = {}) {
  const cfg = configuracao();
  const ocorrencia = ocorrenciaDevida(cfg, agora);
  if (!ocorrencia) return null;

  const feitas = new Set(
    db.prepare("SELECT sala FROM desligamento_diario_execucoes WHERE data = ? AND hora = ?")
      .all(ocorrencia.data, ocorrencia.hora)
      .map((r) => r.sala)
  );
  const pendentes = salasNoEscopo(cfg).filter((s) => !feitas.has(s.sala));
  if (!pendentes.length) return null;

  const mantidasPorAgendamento = salasMantidasPorAgendamento(ocorrencia.data, ocorrencia.hora);
  const inserir = db.prepare("INSERT INTO desligamento_diario_execucoes (data, hora, sala, resultado) VALUES (?, ?, ?, ?)");
  const resumo = { ...Object.fromEntries(RESULTADOS.map((r) => [r, []])), falhas: [] };

  for (const sala of pendentes) {
    try {
      let resultado;
      if (salasService.intencaoAlteradaDesde(sala.sala, ocorrencia.instante)) resultado = "intencao_mais_nova";
      else if (mantidasPorAgendamento.has(sala.sala)) resultado = "agendamento_ativo";
      else if (!sala.ligado) resultado = "ja_desligado";
      else resultado = "desligado";

      if (resultado === "desligado") {
        salasService.aplicarComando(sala.sala, "desligar", undefined, {
          usuario: null,
          origem: "desligamento_diario",
          registrarNaTransacao: () => inserir.run(ocorrencia.data, ocorrencia.hora, sala.sala, resultado),
          enviarAoDispositivo,
        });
      } else {
        inserir.run(ocorrencia.data, ocorrencia.hora, sala.sala, resultado);
      }
      resumo[resultado].push(sala.sala);
    } catch (erro) {
      resumo.falhas.push(sala.sala);
      logger.error("desligamento-diario-falhou", { sala: sala.sala, data: ocorrencia.data, hora: ocorrencia.hora, mensagem: erro.message });
      monitoramentoService.registrar("schedulerFalha", { tarefa: "desligamento-diario", sala: sala.sala });
    }
  }

  const processadas = RESULTADOS.reduce((n, r) => n + resumo[r].length, 0);
  if (processadas > 0 || resumo.falhas.length > 0) {
    auditar(ocorrencia, resumo);
    logger.info("desligamento-diario-executado", {
      data: ocorrencia.data,
      hora: ocorrencia.hora,
      ...Object.fromEntries(Object.entries(resumo).map(([k, v]) => [k, v.length])),
    });
  }
  return { ocorrencia, ...resumo };
}

function ultimaExecucao() {
  const ultima = db.prepare(`
    SELECT data, hora, MAX(executadoEm) AS executadoEm
    FROM desligamento_diario_execucoes
    GROUP BY data, hora
    ORDER BY data DESC, MAX(executadoEm) DESC
    LIMIT 1
  `).get();
  if (!ultima) return null;
  const contagens = Object.fromEntries(RESULTADOS.map((r) => [r, 0]));
  for (const { resultado, total } of db.prepare(`
    SELECT resultado, COUNT(*) AS total FROM desligamento_diario_execucoes WHERE data = ? AND hora = ? GROUP BY resultado
  `).all(ultima.data, ultima.hora)) {
    contagens[resultado] = total;
  }
  return { data: ultima.data, hora: ultima.hora, executadoEm: ultima.executadoEm, contagens };
}

function situacao(agora = new Date()) {
  const cfg = configuracao();
  return {
    configuracao: cfg,
    proxima: proximaOcorrencia(cfg, agora),
    ultima: ultimaExecucao(),
  };
}

module.exports = { verificar, situacao, ocorrenciaDevida, proximaOcorrencia, RESULTADOS };

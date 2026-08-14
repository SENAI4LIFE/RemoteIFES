const db = require("../config/database");
const { buscar: buscarSala } = require("./salasService");
const { dataAtualBrasiliaISO } = require("../utils/tempo");

const MODOS_VALIDOS = ["reserva", "ligar_completo", "ligar_intervalo"];
const DATA_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function paraSaida(a) {
  return {
    id: a.id,
    sala: a.sala,
    usuarioNome: a.usuarioNome,
    usuarioLogin: a.usuarioLogin,
    data: a.data,
    horaInicio: a.horaInicio,
    horaFim: a.horaFim,
    temperatura: a.temperatura,
    modo: a.modo,
    ligarInicio: a.ligarInicio,
    ligarFim: a.ligarFim,
    ativo: !!a.ativo,
  };
}

function listar({ sala, usuarioId } = {}) {
  let query = `
    SELECT a.*, u.nome AS usuarioNome, u.usuario AS usuarioLogin
    FROM agendamentos a
    JOIN usuarios u ON u.id = a.usuarioId
    WHERE 1=1
  `;
  const params = [];
  if (sala) {
    query += " AND a.sala = ?";
    params.push(sala);
  }
  if (usuarioId) {
    query += " AND a.usuarioId = ?";
    params.push(usuarioId);
  }
  query += " ORDER BY a.data, a.horaInicio";

  return db.prepare(query).all(...params).map(paraSaida);
}

function salasComAgendamentoAtivo() {
  const { bloqueioAtivo } = require("./salasService");
  const salas = db.prepare("SELECT sala FROM salas").all();
  const resultado = {};
  for (const { sala } of salas) {
    const bloqueio = bloqueioAtivo(sala);
    if (bloqueio) resultado[sala] = bloqueio;
  }
  return resultado;
}

function validarConflito(sala, novoAg, ignorarId = null) {
  const existentes = db.prepare(`
    SELECT * FROM agendamentos WHERE sala = ? AND ativo = 1 AND data = ? ${ignorarId ? "AND id != ?" : ""}
  `).all(...(ignorarId ? [sala, novoAg.data, ignorarId] : [sala, novoAg.data]));

  for (const ag of existentes) {
    const sobrepoe = novoAg.horaInicio < ag.horaFim && novoAg.horaFim > ag.horaInicio;
    if (sobrepoe) {
      throw new Error(`conflito com outro agendamento já existente nesta sala em ${ag.data} (${ag.horaInicio}–${ag.horaFim})`);
    }
  }
}

function criar({ sala, usuarioId, data, horaInicio, horaFim, temperatura, modo, ligarInicio, ligarFim }) {
  const salaRow = buscarSala(sala);
  if (!salaRow) throw new Error("sala não encontrada");

  if (!data || !DATA_REGEX.test(data)) {
    throw new Error("informe uma data válida (AAAA-MM-DD) para o agendamento");
  }
  if (data < dataAtualBrasiliaISO()) {
    throw new Error("a data do agendamento não pode ser no passado");
  }

  if (!horaInicio || !horaFim || horaInicio >= horaFim) {
    throw new Error("horário inválido: início deve ser antes do fim");
  }

  const configuracoesService = require("./configuracoesService");
  const { minima, maxima } = configuracoesService.limitesTemperatura();
  const temp = Number(temperatura);
  if (Number.isNaN(temp) || temp < minima || temp > maxima) {
    throw new Error(`temperatura deve estar entre ${minima} e ${maxima}`);
  }

  const modoFinal = modo && MODOS_VALIDOS.includes(modo) ? modo : "ligar_completo";
  let ligarInicioFinal = null;
  let ligarFimFinal = null;

  if (modoFinal === "ligar_intervalo") {
    if (!ligarInicio || !ligarFim || ligarInicio >= ligarFim) {
      throw new Error("intervalo para ligar o ar-condicionado inválido");
    }
    if (ligarInicio < horaInicio || ligarFim > horaFim) {
      throw new Error("o intervalo para ligar deve estar dentro do período reservado");
    }
    ligarInicioFinal = ligarInicio;
    ligarFimFinal = ligarFim;
  }

  validarConflito(sala, { data, horaInicio, horaFim });

  const info = db.prepare(`
    INSERT INTO agendamentos (sala, usuarioId, data, horaInicio, horaFim, temperatura, modo, ligarInicio, ligarFim, ativo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(sala, usuarioId, data, horaInicio, horaFim, temp, modoFinal, ligarInicioFinal, ligarFimFinal);

  return db.prepare("SELECT * FROM agendamentos WHERE id = ?").get(info.lastInsertRowid);
}

function buscarPorId(id) {
  return db.prepare("SELECT * FROM agendamentos WHERE id = ?").get(id);
}

function alternar(id, ativo, requisitante) {
  const ag = buscarPorId(id);
  if (!ag) throw new Error("agendamento não encontrado");
  if (ag.usuarioId !== requisitante.id && !requisitante.isAdmin) {
    throw new Error("apenas o autor ou um administrador pode alterar este agendamento");
  }
  db.prepare("UPDATE agendamentos SET ativo = ? WHERE id = ?").run(ativo ? 1 : 0, id);
  return buscarPorId(id);
}

function remover(id, requisitante) {
  const ag = buscarPorId(id);
  if (!ag) throw new Error("agendamento não encontrado");
  if (ag.usuarioId !== requisitante.id && !requisitante.isAdmin) {
    throw new Error("apenas o autor ou um administrador pode remover este agendamento");
  }
  db.prepare("DELETE FROM agendamentos_execucoes WHERE agendamentoId = ?").run(id);
  db.prepare("DELETE FROM agendamentos WHERE id = ?").run(id);
}

function registrarExecucao(agendamentoId, tipo) {
  db.prepare(`
    INSERT INTO agendamentos_execucoes (agendamentoId, tipo) VALUES (?, ?)
  `).run(agendamentoId, tipo);
}

function jaExecutadoHoje(agendamentoId, tipo, dataISO) {
  const linha = db.prepare(`
    SELECT 1 FROM agendamentos_execucoes
    WHERE agendamentoId = ? AND tipo = ? AND date(executadoEm) = ?
    LIMIT 1
  `).get(agendamentoId, tipo, dataISO);
  return !!linha;
}

function listarAtivosParaAgendador() {
  return db.prepare(`
    SELECT a.*, u.usuario AS usuarioLogin
    FROM agendamentos a
    JOIN usuarios u ON u.id = a.usuarioId
    WHERE a.ativo = 1
  `).all();
}

module.exports = {
  listar,
  salasComAgendamentoAtivo,
  criar,
  buscarPorId,
  alternar,
  remover,
  registrarExecucao,
  jaExecutadoHoje,
  listarAtivosParaAgendador,
};

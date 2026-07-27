const db = require("../config/database");
const { buscar: buscarSala } = require("./salasService");

const MODOS_VALIDOS = ["reserva", "ligar_completo", "ligar_intervalo"];

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
  query += " ORDER BY a.horaInicio";

  return db.prepare(query).all(...params).map((a) => ({
    id: a.id,
    sala: a.sala,
    usuarioNome: a.usuarioNome,
    usuarioLogin: a.usuarioLogin,
    diasSemana: JSON.parse(a.diasSemana),
    horaInicio: a.horaInicio,
    horaFim: a.horaFim,
    temperatura: a.temperatura,
    modo: a.modo,
    ligarInicio: a.ligarInicio,
    ligarFim: a.ligarFim,
    ativo: !!a.ativo,
  }));
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

function validarConflito(sala, diasSemana, horaInicio, horaFim, ignorarId = null) {
  const existentes = db.prepare(`
    SELECT * FROM agendamentos WHERE sala = ? AND ativo = 1 ${ignorarId ? "AND id != ?" : ""}
  `).all(...(ignorarId ? [sala, ignorarId] : [sala]));

  for (const ag of existentes) {
    const diasExistentes = JSON.parse(ag.diasSemana);
    const temDiaEmComum = diasExistentes.some((d) => diasSemana.includes(d));
    if (!temDiaEmComum) continue;

    const sobrepoe = horaInicio < ag.horaFim && horaFim > ag.horaInicio;
    if (sobrepoe) {
      throw new Error(`conflito com outro agendamento já existente nesta sala (${ag.horaInicio}–${ag.horaFim})`);
    }
  }
}

function criar({ sala, usuarioId, diasSemana, horaInicio, horaFim, temperatura, modo, ligarInicio, ligarFim }) {
  const salaRow = buscarSala(sala);
  if (!salaRow) throw new Error("sala não encontrada");

  if (!Array.isArray(diasSemana) || diasSemana.length === 0) {
    throw new Error("selecione ao menos um dia da semana");
  }
  if (!horaInicio || !horaFim || horaInicio >= horaFim) {
    throw new Error("horário inválido: início deve ser antes do fim");
  }
  const temp = Number(temperatura);
  if (Number.isNaN(temp) || temp < 16 || temp > 30) {
    throw new Error("temperatura deve estar entre 16 e 30");
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

  validarConflito(sala, diasSemana, horaInicio, horaFim);

  const info = db.prepare(`
    INSERT INTO agendamentos (sala, usuarioId, diasSemana, horaInicio, horaFim, temperatura, modo, ligarInicio, ligarFim, ativo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(sala, usuarioId, JSON.stringify(diasSemana), horaInicio, horaFim, temp, modoFinal, ligarInicioFinal, ligarFimFinal);

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
  listarAtivosParaAgendador,
};

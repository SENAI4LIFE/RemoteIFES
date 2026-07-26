const db = require("../config/database");

const COMANDOS_VALIDOS = ["ligar", "desligar", "temperatura"];

function listar({ bloco, andar } = {}) {
  let query = "SELECT * FROM salas WHERE 1=1";
  const params = [];
  if (bloco) {
    query += " AND bloco = ?";
    params.push(bloco);
  }
  if (andar) {
    query += " AND andar = ?";
    params.push(Number(andar));
  }
  query += " ORDER BY sala";
  return db.prepare(query).all(...params);
}

function buscar(sala) {
  return db.prepare("SELECT * FROM salas WHERE sala = ?").get(sala);
}

// Retorna o agendamento que está "trancando" a sala agora (se houver).
function bloqueioAtivo(sala) {
  const agora = new Date();
  const dia = agora.getDay();
  const hora = agora.toTimeString().slice(0, 5); // "HH:MM"

  const agendamentos = db.prepare(`
    SELECT a.*, u.nome AS usuarioNome, u.usuario AS usuarioLogin
    FROM agendamentos a
    JOIN usuarios u ON u.id = a.usuarioId
    WHERE a.sala = ? AND a.ativo = 1
  `).all(sala);

  for (const ag of agendamentos) {
    const dias = JSON.parse(ag.diasSemana);
    if (!dias.includes(dia)) continue;
    // horaInicio <= agora <= horaFim (dentro do mesmo dia)
    if (hora >= ag.horaInicio && hora <= ag.horaFim) {
      return {
        agendamentoId: ag.id,
        usuarioId: ag.usuarioId,
        usuarioNome: ag.usuarioNome,
        usuarioLogin: ag.usuarioLogin,
        horaInicio: ag.horaInicio,
        horaFim: ag.horaFim,
      };
    }
  }
  return null;
}

function statusCompleto(sala, requisitante) {
  const salaRow = buscar(sala);
  if (!salaRow) return null;

  const bloqueio = bloqueioAtivo(sala);
  const travadaParaMim = !!bloqueio
    && bloqueio.usuarioId !== requisitante.id
    && !requisitante.isAdmin;

  return {
    sala: salaRow.sala,
    nome: salaRow.nome,
    online: !!salaRow.online,
    ligado: !!salaRow.ligado,
    temperatura: salaRow.temperatura,
    temperaturaAlvo: salaRow.temperaturaAlvo,
    bloqueio: bloqueio
      ? {
          usuarioNome: bloqueio.usuarioNome,
          horaInicio: bloqueio.horaInicio,
          horaFim: bloqueio.horaFim,
          souEu: bloqueio.usuarioId === requisitante.id,
        }
      : null,
    travadaParaMim,
  };
}

function registrarLog({ usuario, sala, cmd, valor, origem }) {
  db.prepare(`
    INSERT INTO comandos_log (usuario, sala, cmd, valor, origem)
    VALUES (?, ?, ?, ?, ?)
  `).run(usuario || null, sala, cmd, valor === undefined ? null : String(valor), origem);
}

function aplicarComando(sala, cmd, valor, { usuario, origem }) {
  if (!COMANDOS_VALIDOS.includes(cmd)) {
    throw new Error("comando inválido");
  }

  const salaRow = buscar(sala);
  if (!salaRow) throw new Error("sala não encontrada");

  // Verifica bloqueio de agendamento para usuários não-admin.
  if (origem === "manual" && usuario && !usuario.isAdmin) {
    const bloqueio = bloqueioAtivo(sala);
    if (bloqueio && bloqueio.usuarioId !== usuario.id) {
      throw new Error(`sala reservada por agendamento de ${bloqueio.usuarioNome} até ${bloqueio.horaFim}`);
    }
  }

  if (cmd === "ligar") {
    // TODO: quando o firmware do ESP32 estiver pronto, enviar o comando real
    // para salaRow.ipEsp32 aqui e só marcar online/ligado após confirmação.
    db.prepare(`
      UPDATE salas SET ligado = 1, online = 1, atualizadoEm = datetime('now') WHERE sala = ?
    `).run(sala);
  } else if (cmd === "desligar") {
    db.prepare(`
      UPDATE salas SET ligado = 0, atualizadoEm = datetime('now') WHERE sala = ?
    `).run(sala);
  } else if (cmd === "temperatura") {
    const temp = Number(valor);
    if (Number.isNaN(temp) || temp < 16 || temp > 30) {
      throw new Error("temperatura deve estar entre 16 e 30");
    }
    db.prepare(`
      UPDATE salas SET temperaturaAlvo = ?, atualizadoEm = datetime('now') WHERE sala = ?
    `).run(temp, sala);
  }

  registrarLog({
    usuario: usuario ? usuario.usuario : null,
    sala,
    cmd,
    valor,
    origem,
  });

  return buscar(sala);
}

function listarLogs(limite = 200) {
  return db.prepare(`
    SELECT * FROM comandos_log ORDER BY criadoEm DESC LIMIT ?
  `).all(limite);
}

module.exports = {
  listar,
  buscar,
  statusCompleto,
  bloqueioAtivo,
  aplicarComando,
  listarLogs,
};

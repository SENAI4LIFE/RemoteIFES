const db = require("../config/database");
const { horaAtualBrasilia, dataAtualBrasiliaISO } = require("../utils/tempo");
const configuracoesService = require("./configuracoesService");

const COMANDOS_VALIDOS = ["ligar", "desligar", "temperatura"];
const TIMEOUT_OFFLINE_MS = 90 * 1000;

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

function registrarEventoEsp(sala, status) {
  db.prepare(`INSERT INTO esp_eventos (sala, status) VALUES (?, ?)`).run(sala, status);
}

function registrarDeteccaoEsp(mac, ip, sala = null) {
  if (!mac) return;
  const macLimpo = String(mac).trim().toUpperCase();
  if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(macLimpo)) return;

  const existente = db.prepare(`SELECT mac FROM esp_detectados WHERE mac = ?`).get(macLimpo);
  if (existente) {
    db.prepare(`
      UPDATE esp_detectados SET ip = COALESCE(?, ip), sala = ?, ultimaDeteccao = datetime('now')
      WHERE mac = ?
    `).run(ip || null, sala, macLimpo);
  } else {
    db.prepare(`
      INSERT INTO esp_detectados (mac, ip, sala) VALUES (?, ?, ?)
    `).run(macLimpo, ip || null, sala);
  }
}

function listarDetectados() {
  return db.prepare(`
    SELECT d.* FROM esp_detectados d
    LEFT JOIN salas s ON s.mac = d.mac
    WHERE s.mac IS NULL
    ORDER BY d.ultimaDeteccao DESC
  `).all();
}

function removerDetectado(mac) {
  const macLimpo = mac ? String(mac).trim().toUpperCase() : null;
  if (!macLimpo) throw new Error("MAC inválido");
  db.prepare(`DELETE FROM esp_detectados WHERE mac = ?`).run(macLimpo);
}

function heartbeatDispositivo(sala, estadoReportado, mac, ip) {
  registrarDeteccaoEsp(mac, ip, sala);
  const salaRow = buscar(sala);
  if (!salaRow) {
    return { pendente: true };
  }
  return marcarOnline(sala, estadoReportado, mac, ip);
}

function marcarOnline(sala, estadoReportado = {}, mac = null, ip = null) {
  const salaRow = buscar(sala);
  if (!salaRow) throw new Error("sala não encontrada");

  if (salaRow.mac && mac && salaRow.mac.toLowerCase() !== String(mac).toLowerCase()) {
    throw new Error("MAC do dispositivo não corresponde ao ESP32 cadastrado para esta sala");
  }

  if (!salaRow.online) registrarEventoEsp(sala, "online");

  const temLigado = Object.prototype.hasOwnProperty.call(estadoReportado, "ligado");
  const temTemperatura = Object.prototype.hasOwnProperty.call(estadoReportado, "temperatura");

  db.prepare(`
    UPDATE salas SET
      online = 1,
      ultimoHeartbeat = datetime('now'),
      atualizadoEm = datetime('now'),
      ligado = COALESCE(?, ligado),
      temperatura = COALESCE(?, temperatura),
      ipEsp32 = COALESCE(?, ipEsp32)
    WHERE sala = ?
  `).run(
    temLigado ? (estadoReportado.ligado ? 1 : 0) : null,
    temTemperatura ? Number(estadoReportado.temperatura) : null,
    ip || null,
    sala
  );

  return buscar(sala);
}

function cadastrarMac(sala, mac) {
  const salaRow = buscar(sala);
  if (!salaRow) throw new Error("sala não encontrada");

  const macLimpo = mac ? String(mac).trim().toUpperCase() : null;
  if (macLimpo && !/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(macLimpo)) {
    throw new Error("MAC inválido (use o formato AA:BB:CC:DD:EE:FF)");
  }

  if (macLimpo) {
    const emUso = db.prepare(`SELECT sala FROM salas WHERE mac = ? AND sala != ?`).get(macLimpo, sala);
    if (emUso) throw new Error(`este MAC já está cadastrado para a sala ${emUso.sala}`);
  }

  db.prepare(`UPDATE salas SET mac = ?, atualizadoEm = datetime('now') WHERE sala = ?`).run(macLimpo, sala);
  return buscar(sala);
}

function definirAcessoRestrito(sala, restrito) {
  const salaRow = buscar(sala);
  if (!salaRow) throw new Error("sala não encontrada");
  db.prepare(`UPDATE salas SET acessoRestrito = ?, atualizadoEm = datetime('now') WHERE sala = ?`).run(
    restrito ? 1 : 0,
    sala
  );
  return buscar(sala);
}

function listarUsuariosComAcesso(sala) {
  return db.prepare(`
    SELECT u.id, u.usuario, u.nome
    FROM sala_acessos sa
    JOIN usuarios u ON u.id = sa.usuarioId
    WHERE sa.sala = ?
    ORDER BY u.nome
  `).all(sala);
}

function concederAcesso(sala, usuarioId) {
  const salaRow = buscar(sala);
  if (!salaRow) throw new Error("sala não encontrada");
  db.prepare(`INSERT OR IGNORE INTO sala_acessos (sala, usuarioId) VALUES (?, ?)`).run(sala, usuarioId);
  return listarUsuariosComAcesso(sala);
}

function revogarAcesso(sala, usuarioId) {
  db.prepare(`DELETE FROM sala_acessos WHERE sala = ? AND usuarioId = ?`).run(sala, usuarioId);
  return listarUsuariosComAcesso(sala);
}

function usuarioTemAcessoSala(usuarioId, sala) {
  const registro = db.prepare(`SELECT id FROM sala_acessos WHERE sala = ? AND usuarioId = ?`).get(sala, usuarioId);
  return !!registro;
}

function usuarioPodeControlarSala(usuario, sala) {
  if (!usuario) return false;
  if (usuario.isAdmin) return true;
  if (!usuario.podeControlar) return false;

  const salaRow = buscar(sala);
  if (!salaRow) return false;
  if (!salaRow.acessoRestrito) return true;

  return usuarioTemAcessoSala(usuario.id, sala);
}

function definirPreset(sala, presetId) {
  const salaRow = buscar(sala);
  if (!salaRow) throw new Error("sala não encontrada");

  db.prepare(`UPDATE salas SET presetId = ?, atualizadoEm = datetime('now') WHERE sala = ?`).run(
    presetId === null || presetId === undefined ? null : Number(presetId),
    sala
  );
  return buscar(sala);
}

function verificarTimeouts() {
  const limite = new Date(Date.now() - TIMEOUT_OFFLINE_MS).toISOString().slice(0, 19).replace("T", " ");
  const salasParaDesligar = db.prepare(`
    SELECT sala FROM salas WHERE online = 1 AND (ultimoHeartbeat IS NULL OR ultimoHeartbeat < ?)
  `).all(limite);

  for (const { sala } of salasParaDesligar) {
    db.prepare(`UPDATE salas SET online = 0, atualizadoEm = datetime('now') WHERE sala = ?`).run(sala);
    registrarEventoEsp(sala, "offline");
  }
}

function listarEventosEsp({ sala, data } = {}) {
  let query = "SELECT * FROM esp_eventos WHERE 1=1";
  const params = [];
  if (sala) {
    query += " AND sala = ?";
    params.push(sala);
  }
  if (data) {
    query += " AND date(criadoEm) = ?";
    params.push(data);
  }
  query += " ORDER BY criadoEm DESC LIMIT 500";
  return db.prepare(query).all(...params);
}

function agendamentoOcorreHoje(ag, dataISO) {
  return ag.data === dataISO;
}

function bloqueioAtivo(sala) {
  const hora = horaAtualBrasilia();
  const dataISO = dataAtualBrasiliaISO();

  const agendamentos = db.prepare(`
    SELECT a.*, u.nome AS usuarioNome, u.usuario AS usuarioLogin
    FROM agendamentos a
    JOIN usuarios u ON u.id = a.usuarioId
    WHERE a.sala = ? AND a.ativo = 1
  `).all(sala);

  for (const ag of agendamentos) {
    if (!agendamentoOcorreHoje(ag, dataISO)) continue;
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
    temperaturaMinima: configuracoesService.limitesTemperatura().minima,
    temperaturaMaxima: configuracoesService.limitesTemperatura().maxima,
    acessoRestrito: !!salaRow.acessoRestrito,
    podeControlarEsta: usuarioPodeControlarSala(requisitante, sala),
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

  if (origem === "manual" && usuario && !usuario.isAdmin) {
    if (!usuarioPodeControlarSala(usuario, sala)) {
      throw new Error("você não tem permissão para controlar esta sala");
    }

    const bloqueio = bloqueioAtivo(sala);
    if (bloqueio && bloqueio.usuarioId !== usuario.id) {
      throw new Error(`sala reservada por agendamento de ${bloqueio.usuarioNome} até ${bloqueio.horaFim}`);
    }
  }

  if (cmd === "ligar") {
    db.prepare(`UPDATE salas SET ligado = 1, atualizadoEm = datetime('now') WHERE sala = ?`).run(sala);
  } else if (cmd === "desligar") {
    db.prepare(`UPDATE salas SET ligado = 0, atualizadoEm = datetime('now') WHERE sala = ?`).run(sala);
  } else if (cmd === "temperatura") {
    const temp = Number(valor);
    const { minima, maxima } = configuracoesService.limitesTemperatura();
    if (Number.isNaN(temp) || temp < minima || temp > maxima) {
      throw new Error(`temperatura deve estar entre ${minima} e ${maxima}`);
    }
    db.prepare(`UPDATE salas SET temperaturaAlvo = ?, atualizadoEm = datetime('now') WHERE sala = ?`).run(temp, sala);
  }

  registrarLog({
    usuario: usuario ? usuario.usuario : null,
    sala,
    cmd,
    valor,
    origem,
  });

  const salaAtualizada = buscar(sala);

  return {
    ...salaAtualizada,
    avisoDispositivoOffline: !salaAtualizada.online,
  };
}

function listarLogs({ data, limite = 300 } = {}) {
  let query = "SELECT * FROM comandos_log WHERE 1=1";
  const params = [];
  if (data) {
    query += " AND date(criadoEm) = ?";
    params.push(data);
  }
  query += " ORDER BY criadoEm DESC LIMIT ?";
  params.push(limite);
  return db.prepare(query).all(...params);
}

function apagarLogs({ data } = {}) {
  if (data) {
    db.prepare("DELETE FROM comandos_log WHERE date(criadoEm) = ?").run(data);
  } else {
    db.prepare("DELETE FROM comandos_log").run();
  }
}

function registrarComandoDispositivo(sala, cmd, valor) {
  const salaRow = buscar(sala);
  if (!salaRow) throw new Error("sala não encontrada");
  if (typeof cmd !== "string" || !cmd) throw new Error("cmd é obrigatório");

  registrarLog({
    usuario: null,
    sala,
    cmd,
    valor,
    origem: "esp32_local",
  });
}

function registrarAcessoEsp(sala, { ip, userAgent } = {}) {
  const salaRow = buscar(sala);
  if (!salaRow) throw new Error("sala não encontrada");

  db.prepare(`
    INSERT INTO esp_acessos (sala, ip, userAgent)
    VALUES (?, ?, ?)
  `).run(sala, ip || null, userAgent || null);
}

function listarAcessosEsp({ sala, data, limite = 300 } = {}) {
  let query = "SELECT * FROM esp_acessos WHERE 1=1";
  const params = [];
  if (sala) {
    query += " AND sala = ?";
    params.push(sala);
  }
  if (data) {
    query += " AND date(criadoEm) = ?";
    params.push(data);
  }
  query += " ORDER BY criadoEm DESC LIMIT ?";
  params.push(limite);
  return db.prepare(query).all(...params);
}

function apagarAcessosEsp({ data } = {}) {
  if (data) {
    db.prepare("DELETE FROM esp_acessos WHERE date(criadoEm) = ?").run(data);
  } else {
    db.prepare("DELETE FROM esp_acessos").run();
  }
}

module.exports = {
  listar,
  buscar,
  statusCompleto,
  bloqueioAtivo,
  agendamentoOcorreHoje,
  aplicarComando,
  listarLogs,
  apagarLogs,
  marcarOnline,
  verificarTimeouts,
  listarEventosEsp,
  registrarComandoDispositivo,
  registrarAcessoEsp,
  listarAcessosEsp,
  apagarAcessosEsp,
  cadastrarMac,
  definirPreset,
  definirAcessoRestrito,
  listarUsuariosComAcesso,
  concederAcesso,
  revogarAcesso,
  usuarioTemAcessoSala,
  usuarioPodeControlarSala,
  registrarDeteccaoEsp,
  listarDetectados,
  removerDetectado,
  heartbeatDispositivo,
};

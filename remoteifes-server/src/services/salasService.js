const EventEmitter = require("events");
const db = require("../config/database");
const { horaAtualBrasilia, dataAtualBrasiliaISO } = require("../utils/tempo");
const configuracoesService = require("./configuracoesService");
const notificacoesService = require("./notificacoesService");
const presetsService = require("./presetsService");
const logger = require("../utils/logger");

const eventos = new EventEmitter();

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

function presetDaSala(salaRow) {
  return salaRow.presetId ? presetsService.buscarPorId(salaRow.presetId) : presetsService.presetPadrao();
}

function funcoesEstadoDaSala(salaRow) {
  try {
    return salaRow.funcoesEstado ? JSON.parse(salaRow.funcoesEstado) : {};
  } catch (err) {
    return {};
  }
}

function funcaoDaSalaPorChave(salaRow, chave) {
  const preset = presetDaSala(salaRow);
  if (!preset) return null;
  return preset.funcoes.find((f) => f.chave === chave) || null;
}

function validarValorFuncao(funcao, valor) {
  if (funcao.tipo === "booleano") {
    if (typeof valor !== "boolean") throw new Error(`valor de "${funcao.rotulo}" deve ser verdadeiro ou falso`);
    return valor;
  }
  if (funcao.tipo === "selecao") {
    const opcoes = Array.isArray(funcao.opcoes) ? funcao.opcoes : null;
    if (opcoes && opcoes.length > 0) {
      if (!opcoes.includes(valor)) throw new Error(`valor inválido para "${funcao.rotulo}"`);
      return valor;
    }
    if (typeof valor !== "boolean") throw new Error(`valor de "${funcao.rotulo}" deve ser verdadeiro ou falso`);
    return valor;
  }
  const numero = Number(valor);
  if (Number.isNaN(numero)) throw new Error(`valor de "${funcao.rotulo}" deve ser numérico`);
  const opcoes = funcao.opcoes && typeof funcao.opcoes === "object" ? funcao.opcoes : {};
  if (Number.isFinite(opcoes.min) && numero < opcoes.min) throw new Error(`valor de "${funcao.rotulo}" deve ser maior ou igual a ${opcoes.min}`);
  if (Number.isFinite(opcoes.max) && numero > opcoes.max) throw new Error(`valor de "${funcao.rotulo}" deve ser menor ou igual a ${opcoes.max}`);
  return numero;
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

function macCorrespondeASala(salaRow, mac) {
  if (!salaRow.mac || !mac) return true;
  return salaRow.mac.toLowerCase() === String(mac).toLowerCase();
}

function marcarOnline(sala, estadoReportado = {}, mac = null, ip = null) {
  const salaRow = buscar(sala);
  if (!salaRow) throw new Error("sala não encontrada");

  if (!macCorrespondeASala(salaRow, mac)) {
    logger.warn("heartbeat-mac-invalido", { sala, macRecebido: mac, macEsperado: salaRow.mac, ip });
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

  eventos.emit("mudanca");
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
  logger.info("sala-mac-cadastrado", { sala, mac: macLimpo });
  return buscar(sala);
}

function definirAcessoRestrito(sala, restrito) {
  const salaRow = buscar(sala);
  if (!salaRow) throw new Error("sala não encontrada");
  db.prepare(`UPDATE salas SET acessoRestrito = ?, atualizadoEm = datetime('now') WHERE sala = ?`).run(
    restrito ? 1 : 0,
    sala
  );
  logger.info("sala-acesso-restrito-alterado", { sala, restrito: !!restrito });
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

function listarDonos(sala) {
  return db.prepare(`
    SELECT u.id, u.usuario, u.nome
    FROM sala_donos sd
    JOIN usuarios u ON u.id = sd.usuarioId
    WHERE sd.sala = ?
    ORDER BY u.nome
  `).all(sala);
}

function concederDono(sala, usuarioId) {
  const salaRow = buscar(sala);
  if (!salaRow) throw new Error("sala não encontrada");
  db.prepare(`INSERT OR IGNORE INTO sala_donos (sala, usuarioId) VALUES (?, ?)`).run(sala, usuarioId);
  return listarDonos(sala);
}

function revogarDono(sala, usuarioId) {
  db.prepare(`DELETE FROM sala_donos WHERE sala = ? AND usuarioId = ?`).run(sala, usuarioId);
  return listarDonos(sala);
}

function usuarioEhDonoDaSala(usuarioId, sala) {
  if (!usuarioId || !sala) return false;
  const registro = db.prepare(`SELECT id FROM sala_donos WHERE sala = ? AND usuarioId = ?`).get(sala, usuarioId);
  return !!registro;
}

function usuarioEhDonoDeAlgumaSala(usuarioId) {
  if (!usuarioId) return false;
  const registro = db.prepare(`SELECT 1 FROM sala_donos WHERE usuarioId = ? LIMIT 1`).get(usuarioId);
  return !!registro;
}

function listarSalasDeDono(usuarioId) {
  const linhas = db.prepare(`
    SELECT s.sala, s.nome, s.bloco, s.andar, s.acessoRestrito
    FROM sala_donos sd
    JOIN salas s ON s.sala = sd.sala
    WHERE sd.usuarioId = ?
    ORDER BY s.nome
  `).all(usuarioId);
  return linhas.map((s) => ({ ...s, acessoRestrito: !!s.acessoRestrito }));
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
    SELECT sala, nome FROM salas WHERE online = 1 AND (ultimoHeartbeat IS NULL OR ultimoHeartbeat < ?)
  `).all(limite);

  for (const { sala, nome } of salasParaDesligar) {
    db.prepare(`UPDATE salas SET online = 0, atualizadoEm = datetime('now') WHERE sala = ?`).run(sala);
    registrarEventoEsp(sala, "offline");
    notificacoesService.criarEspOffline(sala, nome);
    logger.warn("esp32-offline", { sala });
  }

  if (salasParaDesligar.length > 0) eventos.emit("mudanca");
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

  const preset = presetDaSala(salaRow);

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
    presetId: preset ? preset.id : null,
    funcoes: preset ? preset.funcoes.filter((f) => f.chave !== "temperatura") : [],
    funcoesEstado: funcoesEstadoDaSala(salaRow),
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
  const salaRow = buscar(sala);
  if (!salaRow) throw new Error("sala não encontrada");

  const comandoBase = COMANDOS_VALIDOS.includes(cmd);
  const funcaoExtra = comandoBase ? null : funcaoDaSalaPorChave(salaRow, cmd);
  if (!comandoBase && !funcaoExtra) {
    throw new Error("comando inválido");
  }

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
  } else if (funcaoExtra) {
    const valorValidado = validarValorFuncao(funcaoExtra, valor);
    const estadoAtual = funcoesEstadoDaSala(salaRow);
    estadoAtual[cmd] = valorValidado;
    db.prepare(`UPDATE salas SET funcoesEstado = ?, atualizadoEm = datetime('now') WHERE sala = ?`).run(JSON.stringify(estadoAtual), sala);
  }

  registrarLog({
    usuario: usuario ? usuario.usuario : null,
    sala,
    cmd,
    valor,
    origem,
  });

  eventos.emit("mudanca");
  const salaAtualizada = buscar(sala);

  return {
    ...salaAtualizada,
    avisoDispositivoOffline: !salaAtualizada.online,
  };
}

function listarLogs({ data, sala, andar, limite = 300 } = {}) {
  let query = "SELECT comandos_log.* FROM comandos_log LEFT JOIN salas ON salas.sala = comandos_log.sala WHERE 1=1";
  const params = [];
  if (data) {
    query += " AND date(comandos_log.criadoEm) = ?";
    params.push(data);
  }
  if (sala) {
    query += " AND comandos_log.sala = ?";
    params.push(sala);
  }
  if (andar) {
    query += " AND salas.andar = ?";
    params.push(Number(andar));
  }
  query += " ORDER BY comandos_log.criadoEm DESC LIMIT ?";
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
  eventos,
  listar,
  buscar,
  statusCompleto,
  bloqueioAtivo,
  agendamentoOcorreHoje,
  aplicarComando,
  listarLogs,
  apagarLogs,
  marcarOnline,
  macCorrespondeASala,
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
  listarDonos,
  concederDono,
  revogarDono,
  usuarioEhDonoDaSala,
  usuarioEhDonoDeAlgumaSala,
  listarSalasDeDono,
  registrarDeteccaoEsp,
  listarDetectados,
  removerDetectado,
  heartbeatDispositivo,
};

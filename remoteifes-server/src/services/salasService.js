const EventEmitter = require("events");
const db = require("../config/database");
const { horaAtualBrasilia, dataAtualBrasiliaISO } = require("../utils/tempo");
const configuracoesService = require("./configuracoesService");
const notificacoesService = require("./notificacoesService");
const logger = require("../utils/logger");

const eventos = new EventEmitter();

const COMANDOS_VALIDOS = ["ligar", "desligar", "temperatura", "turbo"];
const TIMEOUT_OFFLINE_MS = 90 * 1000;
const DETECTADOS_MAX = 100;

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

function normalizarMac(mac) {
  const macLimpo = mac ? String(mac).trim().toUpperCase() : "";
  return /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(macLimpo) ? macLimpo : null;
}

function registrarEventoEsp(sala, status) {
  db.prepare(`INSERT INTO esp_eventos (sala, status) VALUES (?, ?)`).run(sala, status);
}

function registrarDeteccaoEsp(mac, ip, sala = null) {
  const macLimpo = normalizarMac(mac);
  if (!macLimpo) return;

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

function identificarDispositivo(mac, ip) {
  const macLimpo = normalizarMac(mac);
  if (!macLimpo) throw new Error("MAC inválido (use o formato AA:BB:CC:DD:EE:FF)");
  const salaRow = db.prepare(`SELECT * FROM salas WHERE mac = ?`).get(macLimpo);
  registrarDeteccaoEsp(macLimpo, ip, salaRow ? salaRow.sala : null);
  return salaRow || null;
}

// Só os mais recentes: uma placa ainda sem sala se reapresenta a cada 15 s, então ela está sempre
// entre os primeiros, e a lista não cresce com identidades espúrias acumuladas na retenção.
function listarDetectados() {
  return db.prepare(`
    SELECT d.* FROM esp_detectados d
    LEFT JOIN salas s ON s.mac = d.mac
    WHERE s.mac IS NULL
    ORDER BY d.ultimaDeteccao DESC
    LIMIT ?
  `).all(DETECTADOS_MAX);
}

function removerDetectado(mac) {
  const macLimpo = mac ? String(mac).trim().toUpperCase() : null;
  if (!macLimpo) throw new Error("MAC inválido");
  db.prepare(`DELETE FROM esp_detectados WHERE mac = ?`).run(macLimpo);
}

function heartbeatDispositivo(sala, estadoReportado, mac, ip, opcoes = {}) {
  const salaRow = buscar(sala);
  if (!salaRow) throw new Error("sala não encontrada");
  if (!opcoes.viaCredencial && !macCorrespondeASala(salaRow, mac)) {
    throw new Error("MAC do dispositivo não corresponde ao ESP32 cadastrado para esta sala");
  }
  registrarDeteccaoEsp(mac, ip, sala);
  return marcarOnline(sala, estadoReportado, mac, ip, opcoes);
}

function macCorrespondeASala(salaRow, mac) {
  const macLimpo = normalizarMac(mac);
  return !!salaRow?.mac && !!macLimpo && salaRow.mac.toUpperCase() === macLimpo;
}

function marcarOnline(sala, estadoReportado = {}, mac = null, ip = null, opcoes = {}) {
  const salaRow = buscar(sala);
  if (!salaRow) throw new Error("sala não encontrada");

  if (!opcoes.viaCredencial && !macCorrespondeASala(salaRow, mac)) {
    logger.warn("heartbeat-mac-invalido", { sala, macRecebido: mac, macEsperado: salaRow.mac, ip });
    throw new Error("MAC do dispositivo não corresponde ao ESP32 cadastrado para esta sala");
  }

  if (!salaRow.online) registrarEventoEsp(sala, "online");
  try {
    require("./auditoriaService").registrarOnline(sala, new Date().toISOString());
  } catch (erro) {
    logger.warn("esp32-indisponibilidade-fechamento-falhou", { sala, mensagem: erro.message });
  }

  // "ligado" reportado pela placa é o eco do último comando que ela processou, nunca a intenção:
  // um relato atrasado não pode desfazer um comando já persistido (a trava do OFF local é adotada
  // explicitamente em adotarDesligamentoLocal, só a partir de relatos comprovadamente atuais).
  const temTemperatura = Object.prototype.hasOwnProperty.call(estadoReportado, "temperatura");

  db.prepare(`
    UPDATE salas SET
      online = 1,
      ultimoHeartbeat = datetime('now'),
      atualizadoEm = datetime('now'),
      temperatura = COALESCE(?, temperatura),
      ipEsp32 = COALESCE(?, ipEsp32)
    WHERE sala = ?
  `).run(
    temTemperatura ? Number(estadoReportado.temperatura) : null,
    ip || null,
    sala
  );

  const atualizada = buscar(sala);
  if (!salaRow.online !== !atualizada.online) eventos.emit("mudanca");
  else if (salaRow.temperatura !== atualizada.temperatura) eventos.emit("mudanca-sala", { sala });
  return atualizada;
}

function cadastrarMac(sala, mac) {
  const salaRow = buscar(sala);
  if (!salaRow) throw new Error("sala não encontrada");

  const macLimpo = mac ? normalizarMac(mac) : null;
  if (mac && !macLimpo) {
    throw new Error("MAC inválido (use o formato AA:BB:CC:DD:EE:FF)");
  }

  if (macLimpo) {
    const emUso = db.prepare(`SELECT sala FROM salas WHERE mac = ? AND sala != ?`).get(macLimpo, sala);
    if (emUso) throw new Error(`este MAC já está cadastrado para a sala ${emUso.sala}`);
  }

  db.prepare(`UPDATE salas SET mac = ?, atualizadoEm = datetime('now') WHERE sala = ?`).run(macLimpo, sala);
  const deviceHub = require("./deviceHub");
  deviceHub.desconectarSala(sala);
  logger.info("sala-mac-cadastrado", { sala, mac: macLimpo });
  const atualizada = buscar(sala);
  eventos.emit("cadastro-dispositivo", { sala });
  eventos.emit("mudanca");
  return atualizada;
}

function linhaAdministrativa(salaRow) {
  return {
    sala: salaRow.sala,
    nome: salaRow.nome,
    bloco: salaRow.bloco,
    andar: salaRow.andar,
    online: !!salaRow.online,
    ligado: !!salaRow.ligado,
    ipEsp32: salaRow.ipEsp32,
    mac: salaRow.mac,
    temperaturaMinima: salaRow.temperaturaMinima,
    temperaturaMaxima: salaRow.temperaturaMaxima,
    acessoRestrito: !!salaRow.acessoRestrito,
  };
}

function listarAdministrativo() {
  return listar().map(linhaAdministrativa);
}

function buscarAdministrativo(sala) {
  const salaRow = buscar(sala);
  return salaRow ? linhaAdministrativa(salaRow) : null;
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

function exigirUsuario(usuarioId) {
  if (!db.prepare(`SELECT 1 FROM usuarios WHERE id = ?`).get(usuarioId)) throw new Error("usuário não encontrado");
}

function concederAcesso(sala, usuarioId) {
  const salaRow = buscar(sala);
  if (!salaRow) throw new Error("sala não encontrada");
  exigirUsuario(usuarioId);
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

function salasComAcessoDoUsuario(usuarioId) {
  return new Set(db.prepare(`SELECT sala FROM sala_acessos WHERE usuarioId = ?`).all(usuarioId).map((r) => r.sala));
}

function contextoBroadcast() {
  const cfg = configuracoesService.obter();
  const salas = listar({});
  const porSala = new Map(salas.map((s) => [s.sala, s]));
  const agendadas = require("./agendamentosService").salasComAgendamentoAtivo();
  const acessos = new Map();
  return {
    cfg,
    salas,
    agendadas,
    sala: (codigo) => porSala.get(codigo) || null,
    bloqueio: (codigo) => agendadas[codigo] || null,
    acessosDe(usuarioId) {
      if (!acessos.has(usuarioId)) acessos.set(usuarioId, salasComAcessoDoUsuario(usuarioId));
      return acessos.get(usuarioId);
    },
    precarregarAcessos(usuarioIds) {
      const pendentes = [...new Set(usuarioIds.filter((id) => Number.isInteger(id) && !acessos.has(id)))];
      if (!pendentes.length) return;
      for (const id of pendentes) acessos.set(id, new Set());
      const linhas = db.prepare(`SELECT usuarioId, sala FROM sala_acessos WHERE usuarioId IN (${pendentes.map(() => "?").join(", ")})`).all(...pendentes);
      for (const linha of linhas) acessos.get(linha.usuarioId).add(linha.sala);
    },
  };
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
  exigirUsuario(usuarioId);
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

function usuarioPodeControlarSala(usuario, sala, contexto = null) {
  if (!usuario) return false;
  if (usuario.isAdmin) return true;
  if (!usuario.podeControlar) return false;

  const salaRow = contexto ? contexto.sala(sala) : buscar(sala);
  if (!salaRow) return false;
  if (!salaRow.acessoRestrito) return true;

  return contexto ? contexto.acessosDe(usuario.id).has(sala) : usuarioTemAcessoSala(usuario.id, sala);
}

function definirLimitesTemperatura(sala, { minima, maxima }) {
  const salaRow = buscar(sala);
  if (!salaRow) throw new Error("sala não encontrada");

  const { minima: minimaGlobal, maxima: maximaGlobal } = configuracoesService.limitesTemperatura();
  const minimaFinal = minima === null || minima === undefined || minima === "" ? null : Number(minima);
  const maximaFinal = maxima === null || maxima === undefined || maxima === "" ? null : Number(maxima);

  if (minimaFinal !== null && (!Number.isFinite(minimaFinal) || minimaFinal < 16 || minimaFinal > 30)) {
    throw new Error("temperatura mínima inválida (use um valor entre 16 e 30)");
  }
  if (maximaFinal !== null && (!Number.isFinite(maximaFinal) || maximaFinal < 16 || maximaFinal > 30)) {
    throw new Error("temperatura máxima inválida (use um valor entre 16 e 30)");
  }

  const efetivaMin = minimaFinal !== null ? minimaFinal : minimaGlobal;
  const efetivaMax = maximaFinal !== null ? maximaFinal : maximaGlobal;
  if (efetivaMin >= efetivaMax) {
    throw new Error("a temperatura mínima efetiva desta sala deve ser menor que a máxima");
  }

  const alvoAjustado = Math.max(efetivaMin, Math.min(efetivaMax, salaRow.temperaturaAlvo));
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      UPDATE salas
      SET temperaturaMinima = ?, temperaturaMaxima = ?, temperaturaAlvo = ?, estadoVersao = estadoVersao + 1, atualizadoEm = datetime('now')
      WHERE sala = ?
    `).run(minimaFinal, maximaFinal, alvoAjustado, sala);
    db.prepare(`
      UPDATE agendamentos SET temperatura = MAX(?, MIN(?, temperatura)) WHERE sala = ?
    `).run(efetivaMin, efetivaMax, sala);
    db.exec("COMMIT");
  } catch (erro) {
    try {
      db.exec("ROLLBACK");
    } catch (rollbackErro) {}
    throw erro;
  }
  eventos.emit("mudanca");
  const atualizada = buscar(sala);
  enviarEstadoIRParaDispositivo(atualizada);
  return atualizada;
}

function marcarOffline(sala, nome = null, motivo = "desconexao") {
  const linha = db.prepare(`SELECT sala, nome, online FROM salas WHERE sala = ?`).get(sala);
  if (!linha || !linha.online) return false;

  db.prepare(`UPDATE salas SET online = 0, atualizadoEm = datetime('now') WHERE sala = ?`).run(sala);
  try {
    require("./auditoriaService").registrarOffline(sala, new Date().toISOString());
  } catch (erro) {
    logger.warn("esp32-indisponibilidade-registro-falhou", { sala, mensagem: erro.message });
  }
  registrarEventoEsp(sala, "offline");
  notificacoesService.criarEspOffline(sala, nome || linha.nome);
  logger.warn("esp32-offline", { sala, motivo });
  return true;
}

function verificarTimeouts() {
  const limite = new Date(Date.now() - TIMEOUT_OFFLINE_MS).toISOString().slice(0, 19).replace("T", " ");
  const salasParaDesligar = db.prepare(`
    SELECT sala, nome FROM salas WHERE online = 1 AND (ultimoHeartbeat IS NULL OR ultimoHeartbeat < ?)
  `).all(limite);

  let mudou = false;
  for (const { sala, nome } of salasParaDesligar) {
    if (marcarOffline(sala, nome, "heartbeat-vencido")) mudou = true;
  }

  if (mudou) eventos.emit("mudanca");
}

function listarEventosEsp({ sala, data } = {}) {
  let query = "SELECT * FROM esp_eventos WHERE 1=1";
  const params = [];
  if (sala) {
    query += " AND sala = ?";
    params.push(sala);
  }
  if (data) {
    query += " AND date(criadoEm, '-3 hours') = ?";
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
    if (hora >= ag.horaInicio && hora < ag.horaFim) {
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

function statusCompleto(sala, requisitante, contexto = null) {
  const salaRow = contexto ? contexto.sala(sala) : buscar(sala);
  if (!salaRow) return null;

  const bloqueio = contexto ? contexto.bloqueio(sala) : bloqueioAtivo(sala);
  const travadaParaMim = !!bloqueio
    && bloqueio.usuarioId !== requisitante.id
    && !requisitante.isAdmin;

  const cfg = contexto ? contexto.cfg : configuracoesService.obter();
  const limites = configuracoesService.limitesEfetivosDaSala(salaRow, cfg);

  return {
    sala: salaRow.sala,
    nome: salaRow.nome,
    online: !!salaRow.online,
    ligado: !!salaRow.ligado,
    temperatura: salaRow.temperatura,
    temperaturaAlvo: salaRow.temperaturaAlvo,
    temperaturaMinima: limites.minima,
    temperaturaMaxima: limites.maxima,
    turboAtivo: !!salaRow.turboAtivo,
    autoLigar: configuracoesService.autoLigarAtivo(cfg),
    acessoRestrito: !!salaRow.acessoRestrito,
    podeControlarEsta: usuarioPodeControlarSala(requisitante, sala, contexto),
    canalComandos: require("./deviceHub").canalDeComandos(salaRow.sala),
    dispositivoConfirmou: require("./deviceHub").estadoConfirmado(salaRow),
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

function comandoEstadoIR(salaAtualizada) {
  if (!Number.isInteger(salaAtualizada?.irProtocolo)) return null;
  const swing = configuracoesService.turboFuncaoExtra() === "swing" && !!salaAtualizada.turboAtivo;
  return {
    tipo: "send_known_state",
    versao: salaAtualizada.estadoVersao,
    protocol: salaAtualizada.irProtocolo,
    temp: salaAtualizada.temperaturaAlvo,
    power: !!salaAtualizada.ligado,
    turbo: !!salaAtualizada.turboAtivo,
    fan: "",
    swing,
  };
}

// Reenvia o estado desejado vigente a todas as placas; a versão já foi avançada na transação que
// alterou a intenção (ver configuracoesService.validarEAtualizar).
function reenviarEstadoIRParaTodas() {
  const deviceHub = require("./deviceHub");
  for (const salaRow of listar()) {
    const comando = comandoEstadoIR(salaRow);
    if (comando) deviceHub.enviarComando(salaRow.sala, comando);
  }
}

function enviarEstadoIRParaDispositivo(salaAtualizada) {
  const comando = comandoEstadoIR(salaAtualizada);
  if (!comando) return false;
  const deviceHub = require("./deviceHub");
  const entregue = deviceHub.enviarComando(salaAtualizada.sala, comando);
  if (!entregue) {
    require("./monitoramentoService").registrar("comandoNaoEntregue", {
      sala: salaAtualizada.sala,
      motivo: deviceHub.dispositivoConectado(salaAtualizada.sala) ? "envio-falhou" : "dispositivo-desconectado",
    });
  }
  return entregue;
}

function comandoFailsafeIR(salaAtualizada) {
  const registroId = Number(salaAtualizada?.irProtocoloRegistroId);
  if (!Number.isInteger(registroId) || registroId <= 0) return { tipo: "failsafe_raw_clear" };
  const protocolo = require("./protocolosIrService").buscar(registroId);
  if (!protocolo?.failsafe?.raw?.length) return { tipo: "failsafe_raw_clear", protocolRecordId: registroId };
  return {
    tipo: "failsafe_raw_set",
    protocolRecordId: registroId,
    raw: protocolo.failsafe.raw,
    carrierHz: protocolo.failsafe.carrierHz,
  };
}

function enviarFailsafeIRParaDispositivo(salaAtualizada) {
  if (!salaAtualizada) return false;
  return require("./deviceHub").enviarComando(salaAtualizada.sala, comandoFailsafeIR(salaAtualizada));
}

function sincronizarFailsafeIRPorProtocolo(protocoloRegistroId) {
  const id = Number(protocoloRegistroId);
  if (!Number.isInteger(id) || id <= 0) return 0;
  let enviados = 0;
  for (const salaRow of db.prepare("SELECT * FROM salas WHERE irProtocoloRegistroId = ?").all(id)) {
    if (enviarFailsafeIRParaDispositivo(salaRow)) enviados += 1;
  }
  return enviados;
}

function aplicarComando(sala, cmd, valor, { usuario, origem, registrarNaTransacao = null, enviarAoDispositivo = true }) {
  const salaRow = buscar(sala);
  if (!salaRow) throw new Error("sala não encontrada");

  if (!COMANDOS_VALIDOS.includes(cmd)) {
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

  const cfg = configuracoesService.obter();
  const autoLigar = configuracoesService.autoLigarAtivo(cfg);
  let ligouAutomaticamente = false;
  let temp = null;

  if (cmd === "temperatura") {
    temp = Number(valor);
    const { minima, maxima } = configuracoesService.limitesEfetivosDaSala(salaRow, cfg);
    if (!Number.isFinite(temp) || temp < minima || temp > maxima) {
      throw new Error(`temperatura deve estar entre ${minima} e ${maxima}`);
    }
  } else if (cmd === "turbo" && typeof valor !== "boolean") {
    throw new Error("turbo deve ser verdadeiro ou falso");
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    if (cmd === "ligar") {
      db.prepare(`UPDATE salas SET ligado = 1, estadoVersao = estadoVersao + 1, atualizadoEm = datetime('now') WHERE sala = ?`).run(sala);
    } else if (cmd === "desligar") {
      db.prepare(`UPDATE salas SET ligado = 0, turboAtivo = 0, estadoVersao = estadoVersao + 1, atualizadoEm = datetime('now') WHERE sala = ?`).run(sala);
    } else if (cmd === "temperatura") {
      ligouAutomaticamente = autoLigar && !salaRow.ligado;
      db.prepare(`UPDATE salas SET ligado = CASE WHEN ? THEN 1 ELSE ligado END, temperaturaAlvo = ?, estadoVersao = estadoVersao + 1, atualizadoEm = datetime('now') WHERE sala = ?`)
        .run(autoLigar ? 1 : 0, temp, sala);
    } else if (cmd === "turbo") {
      ligouAutomaticamente = autoLigar && valor && !salaRow.ligado;
      db.prepare(`UPDATE salas SET ligado = CASE WHEN ? THEN 1 ELSE ligado END, turboAtivo = ?, estadoVersao = estadoVersao + 1, atualizadoEm = datetime('now') WHERE sala = ?`)
        .run(autoLigar && valor ? 1 : 0, valor ? 1 : 0, sala);
    }

    if (ligouAutomaticamente) {
      registrarLog({ usuario: usuario ? usuario.usuario : null, sala, cmd: "ligar", valor: "automatico", origem });
    }
    registrarLog({
      usuario: usuario ? usuario.usuario : null,
      sala,
      cmd,
      valor,
      origem,
    });
    if (registrarNaTransacao) registrarNaTransacao();
    db.exec("COMMIT");
  } catch (erro) {
    try {
      db.exec("ROLLBACK");
    } catch (rollbackErro) {}
    throw erro;
  }

  const salaAtualizada = buscar(sala);
  const enviadoAoDispositivo = enviarAoDispositivo ? enviarEstadoIRParaDispositivo(salaAtualizada) : false;
  eventos.emit("mudanca");

  return {
    ...salaAtualizada,
    enviadoAoDispositivo,
    canalComandos: require("./deviceHub").canalDeComandos(sala),
    avisoDispositivoOffline: !salaAtualizada.online,
  };
}

function listarLogs({ data, sala, andar, limite = 300 } = {}) {
  let query = "SELECT comandos_log.* FROM comandos_log LEFT JOIN salas ON salas.sala = comandos_log.sala WHERE 1=1";
  const params = [];
  if (data) {
    query += " AND date(comandos_log.criadoEm, '-3 hours') = ?";
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
    db.prepare("DELETE FROM comandos_log WHERE date(criadoEm, '-3 hours') = ?").run(data);
  } else {
    db.prepare("DELETE FROM comandos_log").run();
  }
}

// O OFF local travado na placa passa a ser a intenção do servidor. A versão do estado não avança:
// a placa já está no estado adotado, e só um comando explícito (que avança a versão) limpa a trava.
function adotarDesligamentoLocal(sala, { naReconexao = true } = {}) {
  const salaRow = buscar(sala);
  if (!salaRow) throw new Error("sala não encontrada");
  if (!salaRow.ligado && !salaRow.turboAtivo) return salaRow;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`UPDATE salas SET ligado = 0, turboAtivo = 0, atualizadoEm = datetime('now') WHERE sala = ?`).run(sala);
    registrarLog({
      usuario: null,
      sala,
      cmd: "failsafe_off_local",
      valor: naReconexao ? "mantido_na_reconexao" : "adotado_em_operacao",
      origem: "esp32_local",
    });
    db.exec("COMMIT");
  } catch (erro) {
    try {
      db.exec("ROLLBACK");
    } catch (rollbackErro) {}
    throw erro;
  }
  eventos.emit("mudanca");
  return buscar(sala);
}

function registrarVersaoFirmware(sala, fw) {
  if (typeof fw !== "string" || !fw || fw.length > 32) return;
  db.prepare(`UPDATE salas SET fwVersao = ?, atualizadoEm = datetime('now') WHERE sala = ? AND (fwVersao IS NULL OR fwVersao != ?)`).run(fw, sala, fw);
}

function registrarComandoDispositivo(sala, cmd, valor) {
  const salaRow = buscar(sala);
  if (!salaRow) throw new Error("sala não encontrada");
  if (typeof cmd !== "string" || !cmd) throw new Error("cmd é obrigatório");
  if (cmd.length > 100) throw new Error("cmd excede o tamanho máximo");

  let valorNormalizado = null;
  if (valor !== undefined && valor !== null) {
    valorNormalizado = String(valor).slice(0, 200);
  }

  registrarLog({
    usuario: null,
    sala,
    cmd,
    valor: valorNormalizado,
    origem: "esp32_local",
  });
}

function definirProtocoloIR(sala, protocolo, protocoloRegistroId = null) {
  const salaRow = buscar(sala);
  if (!salaRow) throw new Error("sala não encontrada");

  const protocoloFinal = protocolo === null || protocolo === undefined ? null : Number(protocolo);
  if (protocoloFinal !== null && (!Number.isInteger(protocoloFinal) || protocoloFinal < 0)) {
    throw new Error("protocolo de infravermelho inválido");
  }
  if (protocoloFinal !== null && !require("./protocolosIrService").protocoloNativoSuportado(protocoloFinal)) {
    throw new Error(`protocolo de infravermelho ${protocoloFinal} não é suportado pelo firmware ESP32`);
  }
  const registroFinal = protocoloRegistroId === null || protocoloRegistroId === undefined ? null : Number(protocoloRegistroId);
  if (registroFinal !== null && (!Number.isInteger(registroFinal) || registroFinal <= 0)) {
    throw new Error("registro de protocolo infravermelho inválido");
  }

  db.prepare(`UPDATE salas SET irProtocolo = ?, irProtocoloRegistroId = ?, estadoVersao = estadoVersao + 1, atualizadoEm = datetime('now') WHERE sala = ?`)
    .run(protocoloFinal, registroFinal, sala);
  const atualizada = buscar(sala);
  enviarEstadoIRParaDispositivo(atualizada);
  enviarFailsafeIRParaDispositivo(atualizada);
  return atualizada;
}

function aplicarInicioAgendamento(sala, temperatura, { registrarNaTransacao = null, enviarAoDispositivo = true } = {}) {
  const salaRow = buscar(sala);
  if (!salaRow) throw new Error("sala não encontrada");
  const temp = Number(temperatura);
  const { minima, maxima } = configuracoesService.limitesEfetivosDaSala(salaRow);
  if (!Number.isFinite(temp) || temp < minima || temp > maxima) {
    throw new Error(`temperatura deve estar entre ${minima} e ${maxima}`);
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`UPDATE salas SET ligado = 1, temperaturaAlvo = ?, estadoVersao = estadoVersao + 1, atualizadoEm = datetime('now') WHERE sala = ?`).run(temp, sala);
    registrarLog({ usuario: null, sala, cmd: "ligar", valor: undefined, origem: "agendamento" });
    registrarLog({ usuario: null, sala, cmd: "temperatura", valor: temp, origem: "agendamento" });
    if (registrarNaTransacao) registrarNaTransacao();
    db.exec("COMMIT");
  } catch (erro) {
    db.exec("ROLLBACK");
    throw erro;
  }

  const atualizada = buscar(sala);
  eventos.emit("mudanca");
  if (enviarAoDispositivo) enviarEstadoIRParaDispositivo(atualizada);
  return atualizada;
}

// Houve alguma mudança de intenção na sala (comando manual ou de agendamento, OFF local adotado)
// depois do instante dado (UTC no formato do datetime('now') do SQLite)?
function intencaoAlteradaDesde(sala, instanteUtcSqlite) {
  return !!db.prepare(`
    SELECT 1 FROM comandos_log
    WHERE sala = ? AND criadoEm > ? AND (origem IN ('manual', 'agendamento') OR cmd = 'failsafe_off_local')
    LIMIT 1
  `).get(sala, instanteUtcSqlite);
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
    query += " AND date(criadoEm, '-3 hours') = ?";
    params.push(data);
  }
  query += " ORDER BY criadoEm DESC LIMIT ?";
  params.push(limite);
  return db.prepare(query).all(...params);
}

function apagarAcessosEsp({ data } = {}) {
  if (data) {
    db.prepare("DELETE FROM esp_acessos WHERE date(criadoEm, '-3 hours') = ?").run(data);
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
  aplicarInicioAgendamento,
  intencaoAlteradaDesde,
  listarLogs,
  apagarLogs,
  marcarOnline,
  macCorrespondeASala,
  verificarTimeouts,
  listarEventosEsp,
  registrarComandoDispositivo,
  registrarVersaoFirmware,
  adotarDesligamentoLocal,
  registrarAcessoEsp,
  listarAcessosEsp,
  apagarAcessosEsp,
  cadastrarMac,
  listarAdministrativo,
  buscarAdministrativo,
  identificarDispositivo,
  comandoEstadoIR,
  reenviarEstadoIRParaTodas,
  comandoFailsafeIR,
  enviarFailsafeIRParaDispositivo,
  sincronizarFailsafeIRPorProtocolo,
  definirLimitesTemperatura,
  definirProtocoloIR,
  definirAcessoRestrito,
  listarUsuariosComAcesso,
  concederAcesso,
  revogarAcesso,
  usuarioTemAcessoSala,
  usuarioPodeControlarSala,
  salasComAcessoDoUsuario,
  contextoBroadcast,
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
  marcarOffline,
};

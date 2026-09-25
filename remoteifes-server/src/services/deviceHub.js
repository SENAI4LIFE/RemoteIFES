const EventEmitter = require("events");
const salasService = require("./salasService");
const logger = require("../utils/logger");
const monitoramentoService = require("./monitoramentoService");

const PING_MS = 15 * 1000;
const MAX_CAPTURAS_ARMAZENADAS = 20;
const MAX_PAYLOAD_BYTES = 256 * 1024;
const ESPERA_INFO_INICIAL_MS = 3000;
const MAX_MENSAGENS_JANELA = 120;
const JANELA_MENSAGENS_MS = 10 * 1000;
const MODOS_VALIDOS = new Set(["operation", "config_idle", "config_clone"]);

const conexoes = new Map();
const capturasPorSala = new Map();
const eventos = new EventEmitter();
let wss = null;
let intervaloPing = null;
let proximoIdCaptura = 1;

// --- Transport boundary -------------------------------------------------------------------------
//
// A connection entry is the logical device: room, identity, desired-state confirmation, telemetry,
// firmware and command status. How frames reach it is its channel: a direct WebSocket (the default)
// or a mesh session relayed by a gateway board (meshService). Everything in this module talks to the
// channel; only the direct channel knows about a socket.

function canalDireto(ws) {
  return {
    transporte: "direto",
    ws,
    aberto: () => ws.readyState === ws.OPEN,
    enviar: (payload) => {
      ws.send(JSON.stringify(payload));
      return true;
    },
    fechar: (codigo, motivo) => ws.close(codigo, motivo),
  };
}

function canalAberto(entrada) {
  return !!entrada && entrada.canal.aberto();
}

function protocolosIr() {
  return require("./protocolosIrService");
}

function papelDaEntrada(sala, entrada, salaRow = null) {
  return entrada ? protocolosIr().papelDaConexao(sala, entrada, salaRow) : protocolosIr().papelDaSala(sala, salaRow);
}

function autenticar(req) {
  const credenciaisService = require("./esp32CredenciaisService");
  const mac = req.headers["x-device-mac"];
  const deviceId = req.headers["x-device-id"];
  const segredo = req.headers["x-device-secret"];
  const salaHeader = req.headers["x-device-sala"];

  let sala = null;
  let viaCredencial = false;
  if (typeof deviceId === "string" && typeof segredo === "string") {
    const resultado = credenciaisService.verificar(deviceId, segredo);
    if (!resultado) {
      logger.warn("device-ws-credencial-invalida", { deviceId });
      monitoramentoService.registrar("credencialFalha", { deviceId });
      return null;
    }
    sala = resultado.sala;
    viaCredencial = true;
    req.credencialGrace = resultado.grace ? resultado.expiraEm : null;
  } else if (typeof salaHeader === "string" && salaHeader) {
    sala = salaHeader;
  }
  if (!sala) return null;

  const salaRow = salasService.buscar(sala);
  if (!salaRow) return null;

  if (!viaCredencial) {
    if (credenciaisService.exigidoPara(salaRow)) {
      logger.warn("device-ws-credencial-exigida", { sala });
      return null;
    }
    if (typeof mac !== "string" || !salasService.macCorrespondeASala(salaRow, mac)) return null;
  } else if (salaRow.mac && !salasService.macCorrespondeASala(salaRow, mac)) {
    logger.info("device-ws-credencial-mac-divergente", { sala, macRecebido: mac || null, macCadastrado: salaRow.mac });
  }

  return {
    sala,
    mac: (typeof mac === "string" && mac) || salaRow.mac || null,
    viaCredencial,
    deviceId: viaCredencial ? deviceId : null,
  };
}

function estadoPublico(sala) {
  const entrada = conexoes.get(sala);
  const ota = require("./otaService").estadoDaSala(sala);
  const role = papelDaEntrada(sala, entrada);
  if (!entrada) return { conectado: false, role, ota };
  return {
    conectado: true,
    transporte: entrada.canal.transporte,
    mesh: entrada.mesh ? { gateway: entrada.mesh.gateway, saltos: entrada.mesh.saltos, rssi: entrada.mesh.rssi } : null,
    mac: entrada.mac,
    ip: entrada.ip,
    conectadoEm: entrada.conectadoEm,
    ultimaAtividadeEm: entrada.ultimaAtividadeEm,
    wifiRssi: entrada.wifiRssi,
    modo: entrada.modo,
    fwVersao: entrada.fwVersao,
    role,
    ultimaTelemetria: entrada.ultimaTelemetria,
    ultimoComando: entrada.ultimoComando,
    failsafe: entrada.failsafe,
    estadoConfirmado: estadoConfirmado(salasService.buscar(sala), entrada),
    versaoEstadoReportada: entrada.versaoEstadoReportada,
    capturasRecentes: capturasRecentes(sala),
    ota,
  };
}

// A command socket is open for the room (in-memory state only: "online" through an HTTP heartbeat
// is not enough to deliver a command).
function canalDeComandos(sala) {
  const entrada = conexoes.get(sala);
  return canalAberto(entrada);
}

// true/false: the connected board has (or has not) reported the current desired state; null: no
// board or no IR.
function estadoConfirmado(salaRow, entrada = conexoes.get(salaRow?.sala)) {
  if (!salaRow || !entrada || !Number.isInteger(salaRow.irProtocolo)) return null;
  return entrada.versaoConfirmada === salaRow.estadoVersao;
}

function capturasRecentes(sala) {
  return capturasPorSala.get(sala) || [];
}

function capturaRecente(sala, id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  return capturasRecentes(sala).find((c) => c.id === n) || null;
}

function limparCapturas(sala) {
  if (sala === undefined) capturasPorSala.clear();
  else capturasPorSala.delete(sala);
}

function sincronizarPapel(sala) {
  const entrada = conexoes.get(sala);
  if (!entrada) return false;
  return enviarComando(sala, { tipo: "device_role", role: papelDaEntrada(sala, entrada) });
}

function listarEstados() {
  const estados = {};
  conexoes.forEach((_, sala) => {
    estados[sala] = estadoPublico(sala);
  });
  return estados;
}

function vinculoValido(salaRow, entrada) {
  if (!salaRow) return false;
  const credenciaisService = require("./esp32CredenciaisService");
  if (entrada.viaCredencial) {
    return credenciaisService.deviceIdAtivoPara(salaRow.sala, entrada.deviceId);
  }
  if (credenciaisService.exigidoPara(salaRow)) return false;
  return salasService.macCorrespondeASala(salaRow, entrada.mac);
}

function enviarAtualizacaoCredencial(sala, payload) {
  const entrada = conexoes.get(sala);
  if (!canalAberto(entrada) || !salasService.buscar(sala)) return false;
  entrada.canal.enviar(payload);
  const timer = setTimeout(() => {
    if (conexoes.get(sala) === entrada && !vinculoValido(salasService.buscar(sala), entrada)) {
      entrada.canal.fechar(4001, "credencial do dispositivo alterada");
    }
  }, 1000);
  timer.unref();
  return true;
}

function enviarComando(sala, payload) {
  const entrada = conexoes.get(sala);
  if (!canalAberto(entrada)) return false;
  const salaRow = salasService.buscar(sala);
  if (!vinculoValido(salaRow, entrada)) {
    entrada.canal.fechar(4001, "vínculo do dispositivo alterado");
    return false;
  }
  try {
    if (entrada.canal.enviar(payload) === false) return false;
  } catch (erro) {
    logger.warn("device-ws-envio-falhou", { sala, tipo: payload && payload.tipo, mensagem: erro.message });
    return false;
  }
  if (payload && payload.tipo === "send_known_state" && Number.isInteger(payload.versao)) entrada.versaoEnviada = payload.versao;
  return true;
}

// An administrative IR test (send_raw, send_known_state without version) changes the appliance
// state without going through intent: a version the board echoes afterwards no longer proves it is
// in the desired state until newer intent is sent. Firmware <= 4.3.0 keeps echoing the last
// received version after a test, so the invalidation lives on the server.
function enviarTesteIR(sala, payload) {
  if (!enviarComando(sala, payload)) return false;
  const entrada = conexoes.get(sala);
  const salaRow = salasService.buscar(sala);
  if (entrada && salaRow) {
    entrada.versaoConfirmada = null;
    entrada.versaoInvalidadaAte = salaRow.estadoVersao;
    salasService.eventos.emit("mudanca-sala", { sala });
  }
  return true;
}

function difundirPoliticaAp(exigirCredencial) {
  const payload = { tipo: "config_ap", exigirCredencial: !!exigirCredencial };
  let enviados = 0;
  conexoes.forEach((_, sala) => {
    if (enviarComando(sala, payload)) enviados += 1;
  });
  logger.info("device-politica-ap-difundida", { exigirCredencial: !!exigirCredencial, enviados });
  return enviados;
}

function dispositivoConectado(sala) {
  const entrada = conexoes.get(sala);
  if (!canalAberto(entrada)) return false;
  return vinculoValido(salasService.buscar(sala), entrada);
}

function desconectarSala(sala) {
  const entrada = conexoes.get(sala);
  if (!entrada) return false;
  entrada.canal.fechar(4001, "vínculo do dispositivo alterado");
  return true;
}

function numeroNaFaixa(valor, min, max) {
  return typeof valor === "number" && Number.isFinite(valor) && valor >= min && valor <= max;
}

function registrarVersaoFirmware(sala, entrada, fw) {
  if (typeof fw !== "string" || !fw || fw.length > 32 || fw === entrada.fwVersao) return;
  entrada.fwVersao = fw;
  try {
    salasService.registrarVersaoFirmware(sala, fw);
  } catch (err) {
    logger.warn("device-ws-fw-registrar-falhou", { sala, mensagem: err.message });
  }
  try {
    require("./otaService").aoReconectarDispositivo(sala, fw, entrada.capacidades);
  } catch (err) {
    logger.warn("device-ws-ota-reconectar-falhou", { sala, mensagem: err.message });
  }
}

function registrarCapacidades(entrada, msg) {
  if (msg.otaValidacao === true) entrada.capacidades = { ...entrada.capacidades, validacaoOta: true };
}

function atualizarFailsafeReportado(entrada, msg) {
  if (typeof msg?.failsafeConfigurado !== "boolean") return false;
  const pulsos = Number(msg.failsafePulsos);
  const carrierHz = Number(msg.failsafeCarrierHz);
  const protocolRecordId = Number(msg.failsafeProtocolRecordId);
  const configurado = msg.failsafeConfigurado;
  entrada.failsafe = {
    configurado,
    pulsos: configurado && Number.isInteger(pulsos) && pulsos > 0 && pulsos <= 1024 ? pulsos : 0,
    carrierHz: configurado && Number.isInteger(carrierHz) && carrierHz >= 20000 && carrierHz <= 60000 ? carrierHz : null,
    protocolRecordId: configurado && Number.isInteger(protocolRecordId) && protocolRecordId > 0 ? protocolRecordId : null,
    latched: msg.failsafeLatched === true,
    atualizadoEm: new Date().toISOString(),
  };
  return true;
}

// Firmware without version echo (<= 4.2.0): the last reported IR command matches the current
// intent.
function relatoCondizComIntencao(salaRow, ultimoComando) {
  if (!ultimoComando || typeof ultimoComando !== "object" || ultimoComando.tipo !== "known_state") return false;
  return ultimoComando.protocol === salaRow.irProtocolo
    && !!ultimoComando.power === !!salaRow.ligado
    && Number(ultimoComando.temp) === Number(salaRow.temperaturaAlvo)
    && !!ultimoComando.turbo === !!salaRow.turboAtivo;
}

// Reconciles a board report (info, telemetry or failsafe_status) with the persisted intent. A
// report only affects intent when it provably reflects the current version: through the echoed
// version (firmware >= 4.3.0) or, without echo, when this connection has already confirmed the
// current version (message order on the socket guarantees the report is later). The local OFF latch
// reported in the connection's info is always adopted, as before, unless an explicit command
// already left on this connection before it (see sincronizarEstadoInicial). Returns true when
// confirmation changed.
function reconciliarRelato(sala, entrada, msg, { inicial = false } = {}) {
  let salaRow = salasService.buscar(sala);
  if (!salaRow) return false;
  const versaoAtual = salaRow.estadoVersao;
  const versaoReportada = Number.isInteger(msg.versao) && msg.versao >= 0 ? msg.versao : null;
  entrada.versaoEstadoReportada = versaoReportada;
  const reflete = versaoReportada !== null
    ? versaoReportada === versaoAtual
    : entrada.versaoConfirmada === versaoAtual || relatoCondizComIntencao(salaRow, msg.ultimoComando);
  const ecoInvalidado = versaoReportada !== null && entrada.versaoInvalidadaAte !== null && versaoAtual <= entrada.versaoInvalidadaAte;
  const latched = msg.failsafeLatched === true;
  if (latched && (inicial || reflete) && (salaRow.ligado || salaRow.turboAtivo)) {
    try {
      salaRow = salasService.adotarDesligamentoLocal(sala, { naReconexao: inicial });
      logger.info("device-ws-failsafe-latch", { sala, naReconexao: inicial });
    } catch (erro) {
      logger.warn("device-ws-failsafe-latch-adotar-falhou", { sala, mensagem: erro.message });
    }
  }
  const confirmado = (reflete && !ecoInvalidado) || (latched && !salaRow.ligado && !salaRow.turboAtivo);
  const antes = entrada.versaoConfirmada === versaoAtual;
  if (confirmado) entrada.versaoConfirmada = versaoAtual;
  else if (versaoReportada !== null && entrada.versaoConfirmada === versaoAtual) entrada.versaoConfirmada = null;
  return antes !== confirmado;
}

function sincronizarEstadoInicial(sala, entrada, info) {
  if (entrada.sincronizacaoInicial) {
    clearTimeout(entrada.sincronizacaoInicial);
    entrada.sincronizacaoInicial = null;
  }
  if (entrada.estadoInicialSincronizado || conexoes.get(sala) !== entrada || !canalAberto(entrada)) return;
  entrada.estadoInicialSincronizado = true;
  // An explicit command already left on this connection before the info (or the wait): the info
  // describes the board before that command, so it must not adopt a latch or erase the newer
  // intent, and restoration would be redundant because the current intent was already sent with its
  // version.
  if (entrada.versaoEnviada !== null) {
    if (info && reconciliarRelato(sala, entrada, info)) salasService.eventos.emit("mudanca-sala", { sala });
    return;
  }
  if (info) {
    reconciliarRelato(sala, entrada, info, { inicial: true });
    if (info.failsafeLatched === true) return;
  }
  // Automatic restoration is flagged so the firmware does not treat it as an explicit command (a
  // board latched in local OFF ignores it and answers with failsafe_status).
  const comandoInicial = salasService.comandoEstadoIR(salasService.buscar(sala));
  if (comandoInicial) {
    try {
      entrada.canal.enviar({ ...comandoInicial, restauracao: true });
    } catch (erro) {
      logger.warn("device-ws-sincronizacao-inicial-falhou", { sala, mensagem: erro.message });
    }
  }
}

function registrarTelemetria(sala, entrada, msg) {
  const agora = new Date().toISOString();
  const tempValida = numeroNaFaixa(msg.temp, -40, 85);
  const humValida = numeroNaFaixa(msg.hum, 0, 100);
  entrada.wifiRssi = numeroNaFaixa(msg.rssi, -120, 0) ? msg.rssi : entrada.wifiRssi;
  entrada.modo = MODOS_VALIDOS.has(msg.modo) ? msg.modo : entrada.modo;
  registrarVersaoFirmware(sala, entrada, msg.fw);
  atualizarFailsafeReportado(entrada, msg);
  entrada.ultimaTelemetria = {
    temp: tempValida ? msg.temp : null,
    hum: humValida ? msg.hum : null,
    rssi: numeroNaFaixa(msg.rssi, -120, 0) ? msg.rssi : null,
    modo: entrada.modo,
    ligado: !!msg.ligado,
    recebidoEm: agora,
  };
  if (msg.ultimoComando && typeof msg.ultimoComando === "object") {
    entrada.ultimoComando = { ...msg.ultimoComando, recebidoEm: agora };
  }

  try {
    const estadoReportado = {};
    if (tempValida) estadoReportado.temperatura = msg.temp;
    salasService.marcarOnline(sala, estadoReportado, entrada.mac, entrada.ip, { viaCredencial: entrada.viaCredencial });
  } catch (err) {
    logger.warn("device-ws-telemetria-marcar-online-falhou", { sala, mensagem: err.message });
    monitoramentoService.registrar("telemetriaFalha", { sala });
  }
  if (reconciliarRelato(sala, entrada, msg)) salasService.eventos.emit("mudanca-sala", { sala });

  eventos.emit("telemetria", { sala, estado: estadoPublico(sala) });
}

function registrarCaptura(sala, entrada, msg, salaRow) {
  if (papelDaEntrada(sala, entrada, salaRow) !== "cloner") {
    logger.warn("device-captura-rejeitada", { sala, mac: entrada.mac, motivo: "nao-e-o-clonador" });
    return;
  }
  if (entrada.modo !== "config_clone") {
    logger.warn("device-captura-rejeitada", { sala, mac: entrada.mac, modo: entrada.modo, motivo: "fora-do-modo-clone" });
    return;
  }
  let raw;
  try {
    raw = protocolosIr().validarRaw(msg.raw);
  } catch (erro) {
    logger.warn("device-captura-rejeitada", { sala, mac: entrada.mac, motivo: "raw-invalido", detalhe: erro.message });
    return;
  }
  const protocolId = Number.isInteger(msg.protocolId) && msg.protocolId >= 0 ? msg.protocolId : null;
  const captura = {
    id: proximoIdCaptura++,
    sala,
    isKnown: !!msg.isKnown && protocolosIr().protocoloNativoSuportado(protocolId),
    protocolId,
    protocol: typeof msg.protocol === "string" ? msg.protocol.slice(0, 80) : null,
    hex: typeof msg.hex === "string" ? msg.hex.slice(0, 4096) : null,
    raw,
    carrierHz: Number.isInteger(msg.carrierHz) && msg.carrierHz >= 20000 && msg.carrierHz <= 60000 ? msg.carrierHz : 38000,
    recebidoEm: new Date().toISOString(),
  };
  const historico = capturasPorSala.get(sala) || [];
  historico.unshift(captura);
  if (historico.length > MAX_CAPTURAS_ARMAZENADAS) historico.length = MAX_CAPTURAS_ARMAZENADAS;
  capturasPorSala.set(sala, historico);
  eventos.emit("captura", { sala, captura });
}

/**
 * Registers an authenticated device on its channel. Shared by the direct WebSocket and by a mesh
 * session: the logical device is the same, only the channel differs.
 */
function conectarDispositivo({ sala, mac, viaCredencial, deviceId, ip, credencialGrace = null, canal, mesh = null }) {
  const agora = new Date().toISOString();

  const antiga = conexoes.get(sala);
  if (antiga && canalAberto(antiga)) {
    antiga.canal.fechar(4002, "nova conexão do mesmo dispositivo");
  }

  const entrada = {
    canal,
    mac,
    viaCredencial: !!viaCredencial,
    deviceId,
    ip,
    mesh,
    conectadoEm: agora,
    ultimaAtividadeEm: agora,
    wifiRssi: null,
    modo: "operation",
    fwVersao: null,
    ultimaTelemetria: null,
    ultimoComando: null,
    failsafe: null,
    capacidades: {},
    credencialExpiraEm: credencialGrace || null,
    sincronizacaoInicial: null,
    estadoInicialSincronizado: false,
    versaoConfirmada: null,
    versaoEstadoReportada: null,
    versaoEnviada: null,
    versaoInvalidadaAte: null,
  };
  conexoes.set(sala, entrada);

  try {
    salasService.marcarOnline(sala, {}, mac, ip, { viaCredencial });
  } catch (err) {
    logger.warn("device-ws-conectar-marcar-online-falhou", { sala, mensagem: err.message });
  }
  logger.info("device-ws-conectado", { sala, mac, ip, transporte: canal.transporte });
  monitoramentoService.registrarConexaoDispositivo(sala);
  eventos.emit("conexao", { sala, conectado: true });
  const salaInicial = salasService.buscar(sala);
  try {
    entrada.canal.enviar({ tipo: "device_role", role: papelDaEntrada(sala, entrada, salaInicial) });
    entrada.canal.enviar(salasService.comandoFailsafeIR(salaInicial));
  } catch (erro) {
    logger.warn("device-ws-sincronizacao-inicial-falhou", { sala, mensagem: erro.message });
  }
  // setImmediate: after a long event-loop pause, an info already received on the socket is
  // processed (I/O phase) before this timeout-driven synchronization.
  entrada.sincronizacaoInicial = setTimeout(() => setImmediate(() => sincronizarEstadoInicial(sala, entrada, null)), ESPERA_INFO_INICIAL_MS);
  entrada.sincronizacaoInicial.unref();
  if (viaCredencial) {
    try {
      const credenciaisService = require("./esp32CredenciaisService");
      if (entrada.credencialExpiraEm) credenciaisService.reentregarAtual(sala);
      else credenciaisService.entregarPendente(sala);
    } catch (erro) {
      logger.warn("device-ws-credencial-pendente-falhou", { sala, mensagem: erro.message });
    }
  }
  try {
    entrada.canal.enviar(require("./configuracoesService").politicaApDispositivo());
  } catch (erro) {
    logger.warn("device-ws-politica-ap-falhou", { sala, mensagem: erro.message });
  }
  return entrada;
}

/**
 * Handles one message from a device, whatever channel carried it.
 */
function processarMensagem(sala, entrada, msg, salaAtual) {
  if (msg.tipo === "telemetria") {
    registrarTelemetria(sala, entrada, msg);
  } else if (msg.tipo === "info") {
    registrarCapacidades(entrada, msg);
    registrarVersaoFirmware(sala, entrada, msg.fw);
    atualizarFailsafeReportado(entrada, msg);
    if (!entrada.estadoInicialSincronizado) sincronizarEstadoInicial(sala, entrada, msg);
    else if (reconciliarRelato(sala, entrada, msg)) salasService.eventos.emit("mudanca-sala", { sala });
  } else if (msg.tipo === "ota_validado") {
    registrarCapacidades(entrada, { otaValidacao: true });
    if (require("./otaService").registrarValidacao(sala, msg)) {
      try {
        entrada.canal.enviar({ tipo: "ota_validacao_ok", tentativa: msg.tentativa });
      } catch (erro) {
        logger.warn("device-ws-ota-validacao-ack-falhou", { sala, mensagem: erro.message });
      }
    }
  } else if (msg.tipo === "failsafe_status") {
    if (atualizarFailsafeReportado(entrada, msg)) {
      if (reconciliarRelato(sala, entrada, msg)) salasService.eventos.emit("mudanca-sala", { sala });
      eventos.emit("telemetria", { sala, estado: estadoPublico(sala) });
    }
  } else if (msg.tipo === "ota_progresso") {
    require("./otaService").registrarProgresso(sala, msg);
  } else if (msg.tipo === "ota_resultado") {
    require("./otaService").registrarResultado(sala, msg);
  } else if (msg.tipo === "captura") {
    registrarCaptura(sala, entrada, msg, salaAtual);
  } else if (msg.tipo === "acesso") {
    salasService.registrarAcessoEsp(sala, {
      ip: typeof msg.ip === "string" ? msg.ip : entrada.ip,
      userAgent: typeof msg.userAgent === "string" ? msg.userAgent.slice(0, 500) : null,
    });
  } else if (msg.tipo === "comando") {
    if (typeof msg.cmd === "string" && msg.cmd.length <= 100) {
      const valor = (typeof msg.valor === "string" || typeof msg.valor === "number")
        ? msg.valor
        : undefined;
      salasService.registrarComandoDispositivo(sala, msg.cmd, valor);
    }
  } else if (msg.tipo === "modo_alterado") {
    entrada.modo = MODOS_VALIDOS.has(msg.modo) ? msg.modo : entrada.modo;
    eventos.emit("telemetria", { sala, estado: estadoPublico(sala) });
  }
}

function desconectarDispositivo(sala, entrada, code, motivo) {
  if (entrada.sincronizacaoInicial) {
    clearTimeout(entrada.sincronizacaoInicial);
    entrada.sincronizacaoInicial = null;
  }
  if (conexoes.get(sala) !== entrada) return;
  conexoes.delete(sala);
  logger.info("device-ws-desconectado", { sala, code, motivo: motivo?.toString(), transporte: entrada.canal.transporte });
  try {
    if (salasService.marcarOffline(sala, null, "websocket-fechado")) salasService.eventos.emit("mudanca");
  } catch (erro) {
    logger.warn("device-ws-marcar-offline-falhou", { sala, mensagem: erro.message });
  }
  try {
    require("./otaService").aoDesconectarDispositivo(sala);
  } catch (erro) {
    logger.warn("device-ws-ota-desconectar-falhou", { sala, mensagem: erro.message });
  }
  if (entrada.canal.transporte === "direto") {
    // A gateway that goes away takes its mesh sessions with it: gateway availability never proved
    // the boards behind it, and their absence is now certain.
    try {
      require("./meshService").aoDesconectarGateway(sala);
    } catch (erro) {
      logger.warn("mesh-gateway-desconectar-falhou", { sala, mensagem: erro.message });
    }
  }
  eventos.emit("conexao", { sala, conectado: false });
}

// A gateway's socket carries the traffic of the boards behind it, so its message budget grows with
// the authenticated nodes it serves, within a hard ceiling.
function limiteDeMensagens(sala) {
  let nos = 0;
  try {
    nos = require("./meshService").nosDoGateway(sala);
  } catch {}
  return Math.min(MAX_MENSAGENS_JANELA + nos * MAX_MENSAGENS_JANELA, MAX_MENSAGENS_JANELA * 20);
}

function iniciar(server) {
  const { WebSocketServer } = require("ws");
  wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });

  server.on("upgrade", (req, socket, head) => {
    let pathname;
    try {
      ({ pathname } = new URL(req.url, "http://localhost"));
    } catch (erro) {
      socket.destroy();
      return;
    }
    if (pathname !== "/ws/dispositivo") return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws, req) => {
    ws.on("error", (err) => {
      logger.warn("device-ws-erro", { mensagem: err && err.message });
      try {
        ws.terminate();
      } catch (erro) {}
    });

    const auth = autenticar(req);
    if (!auth) {
      ws.close(4001, "não autorizado");
      return;
    }

    const { sala } = auth;
    const entrada = conectarDispositivo({
      ...auth,
      ip: req.socket.remoteAddress,
      credencialGrace: req.credencialGrace || null,
      canal: canalDireto(ws),
    });
    ws.isAlive = true;
    ws.janelaMensagensInicio = Date.now();
    ws.mensagensNaJanela = 0;
    ws.on("pong", () => {
      ws.isAlive = true;
    });

    ws.on("message", (dados) => {
      if (conexoes.get(sala) !== entrada || ws.readyState !== ws.OPEN) return;
      const agoraMs = Date.now();
      if (agoraMs - ws.janelaMensagensInicio >= JANELA_MENSAGENS_MS) {
        ws.janelaMensagensInicio = agoraMs;
        ws.mensagensNaJanela = 0;
      }
      ws.mensagensNaJanela += 1;
      if (ws.mensagensNaJanela > limiteDeMensagens(sala)) {
        ws.close(4008, "limite de mensagens excedido");
        return;
      }
      const salaAtual = salasService.buscar(sala);
      if (!vinculoValido(salaAtual, entrada)) {
        ws.close(4001, "vínculo do dispositivo alterado");
        return;
      }
      entrada.ultimaAtividadeEm = new Date().toISOString();
      let msg;
      try {
        msg = JSON.parse(dados.toString());
      } catch (err) {
        return;
      }
      if (!msg || typeof msg.tipo !== "string") return;
      // Frames a gateway relays for the boards behind it. They never reach the room's own handling.
      if (msg.tipo === "mesh" || msg.tipo === "mesh_evento") {
        require("./meshService").doGateway(sala, entrada, msg);
        return;
      }
      processarMensagem(sala, entrada, msg, salaAtual);
    });

    ws.on("close", (code, motivo) => {
      desconectarDispositivo(sala, entrada, code, motivo);
    });
  });

  intervaloPing = setInterval(() => {
    conexoes.forEach((entrada, sala) => {
      if (encerrarSeCredencialExpirou(sala, entrada)) return;
      // Mesh sessions have their own liveness (meshService); only sockets are pinged here.
      if (entrada.canal.transporte !== "direto") return;
      const ws = entrada.canal.ws;
      if (!ws.isAlive) {
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, PING_MS);
  intervaloPing.unref();
}

function encerrarSeCredencialExpirou(sala, entrada) {
  if (!entrada.credencialExpiraEm) return false;
  const expiraMs = new Date(entrada.credencialExpiraEm).getTime();
  if (!Number.isFinite(expiraMs) || expiraMs > Date.now()) return false;
  logger.info("device-ws-credencial-anterior-expirou", { sala });
  try {
    entrada.canal.fechar(4001, "credencial anterior expirou; reconecte com a credencial atual");
  } catch (erro) {}
  return true;
}

function encerrarCredenciaisExpiradas() {
  let encerradas = 0;
  conexoes.forEach((entrada, sala) => {
    if (encerrarSeCredencialExpirou(sala, entrada)) encerradas += 1;
  });
  return encerradas;
}

function encerrar() {
  if (intervaloPing) {
    clearInterval(intervaloPing);
    intervaloPing = null;
  }
  conexoes.forEach((entrada) => {
    try {
      entrada.canal.fechar(1001, "servidor encerrando");
    } catch (erro) {}
  });
  conexoes.clear();
  try {
    require("./meshService").encerrar();
  } catch {}
  capturasPorSala.clear();
  if (wss) {
    try {
      wss.close();
    } catch (erro) {}
  }
}

module.exports = {
  iniciar,
  encerrar,
  conectarDispositivo,
  desconectarDispositivo,
  processarMensagem,
  vinculoValido,
  canalAberto,
  conexaoDaSala: (sala) => conexoes.get(sala) || null,
  listarConexoes: () => Array.from(conexoes.entries()),
  eventos,
  estadoPublico,
  estadoConfirmado,
  canalDeComandos,
  listarEstados,
  enviarComando,
  enviarTesteIR,
  sincronizarPapel,
  capturasRecentes,
  capturaRecente,
  limparCapturas,
  enviarAtualizacaoCredencial,
  encerrarCredenciaisExpiradas,
  difundirPoliticaAp,
  dispositivoConectado,
  desconectarSala,
};

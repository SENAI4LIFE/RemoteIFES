const EventEmitter = require("events");
const salasService = require("./salasService");
const logger = require("../utils/logger");
const monitoramentoService = require("./monitoramentoService");

const PING_MS = 15 * 1000;
const MAX_CAPTURAS_ARMAZENADAS = 20;
const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_MENSAGENS_JANELA = 120;
const JANELA_MENSAGENS_MS = 10 * 1000;
const MODOS_VALIDOS = new Set(["operation", "config_idle", "config_clone"]);

const conexoes = new Map();
const capturasPorSala = new Map();
const eventos = new EventEmitter();
let wss = null;
let intervaloPing = null;
let proximoIdCaptura = 1;

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
    capturasRecentes: capturasRecentes(sala),
    ota,
  };
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
  if (!entrada || entrada.ws.readyState !== entrada.ws.OPEN || !salasService.buscar(sala)) return false;
  entrada.ws.send(JSON.stringify(payload));
  const timer = setTimeout(() => {
    if (conexoes.get(sala) === entrada && !vinculoValido(salasService.buscar(sala), entrada)) {
      entrada.ws.close(4001, "credencial do dispositivo alterada");
    }
  }, 1000);
  timer.unref();
  return true;
}

function enviarComando(sala, payload) {
  const entrada = conexoes.get(sala);
  if (!entrada || entrada.ws.readyState !== entrada.ws.OPEN) return false;
  const salaRow = salasService.buscar(sala);
  if (!vinculoValido(salaRow, entrada)) {
    entrada.ws.close(4001, "vínculo do dispositivo alterado");
    return false;
  }
  entrada.ws.send(JSON.stringify(payload));
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
  if (!entrada || entrada.ws.readyState !== entrada.ws.OPEN) return false;
  return vinculoValido(salasService.buscar(sala), entrada);
}

function desconectarSala(sala) {
  const entrada = conexoes.get(sala);
  if (!entrada) return false;
  entrada.ws.close(4001, "vínculo do dispositivo alterado");
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
    require("./otaService").aoReconectarDispositivo(sala, fw);
  } catch (err) {
    logger.warn("device-ws-ota-reconectar-falhou", { sala, mensagem: err.message });
  }
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
    atualizadoEm: new Date().toISOString(),
  };
  return true;
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
    if (typeof msg.ligado === "boolean") estadoReportado.ligado = msg.ligado;
    salasService.marcarOnline(sala, estadoReportado, entrada.mac, entrada.ip, { viaCredencial: entrada.viaCredencial });
  } catch (err) {
    logger.warn("device-ws-telemetria-marcar-online-falhou", { sala, mensagem: err.message });
    monitoramentoService.registrar("telemetriaFalha", { sala });
  }

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
  const raw = Array.isArray(msg.raw)
    ? msg.raw.slice(0, 1024).filter((n) => Number.isInteger(n) && n >= 0 && n <= 65535)
    : [];
  if (!raw.length) {
    logger.warn("device-captura-rejeitada", { sala, mac: entrada.mac, motivo: "raw-invalido" });
    return;
  }
  const captura = {
    id: proximoIdCaptura++,
    sala,
    isKnown: !!msg.isKnown,
    protocolId: Number.isInteger(msg.protocolId) && msg.protocolId >= 0 ? msg.protocolId : null,
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

    const { sala, mac, viaCredencial, deviceId } = auth;
    const ip = req.socket.remoteAddress;
    const agora = new Date().toISOString();

    const antiga = conexoes.get(sala);
    if (antiga && antiga.ws.readyState === antiga.ws.OPEN) {
      antiga.ws.close(4002, "nova conexão do mesmo dispositivo");
    }

    const entrada = {
      ws,
      mac,
      viaCredencial: !!viaCredencial,
      deviceId,
      ip,
      conectadoEm: agora,
      ultimaAtividadeEm: agora,
      wifiRssi: null,
      modo: "operation",
      fwVersao: null,
      ultimaTelemetria: null,
      ultimoComando: null,
      failsafe: null,
    };
    conexoes.set(sala, entrada);
    ws.isAlive = true;
    ws.janelaMensagensInicio = Date.now();
    ws.mensagensNaJanela = 0;
    ws.on("pong", () => {
      ws.isAlive = true;
    });

    try {
      salasService.marcarOnline(sala, {}, mac, ip, { viaCredencial });
    } catch (err) {
      logger.warn("device-ws-conectar-marcar-online-falhou", { sala, mensagem: err.message });
    }
    logger.info("device-ws-conectado", { sala, mac, ip });
    monitoramentoService.registrarConexaoDispositivo(sala);
    eventos.emit("conexao", { sala, conectado: true });
    const salaInicial = salasService.buscar(sala);
    try {
      ws.send(JSON.stringify({ tipo: "device_role", role: papelDaEntrada(sala, entrada, salaInicial) }));
      ws.send(JSON.stringify(salasService.comandoFailsafeIR(salaInicial)));
    } catch (erro) {
      logger.warn("device-ws-sincronizacao-inicial-falhou", { sala, mensagem: erro.message });
    }
    const comandoInicial = salasService.comandoEstadoIR(salaInicial);
    if (comandoInicial) ws.send(JSON.stringify(comandoInicial));
    try {
      ws.send(JSON.stringify(require("./configuracoesService").politicaApDispositivo()));
    } catch (erro) {
      logger.warn("device-ws-politica-ap-falhou", { sala, mensagem: erro.message });
    }

    ws.on("message", (dados) => {
      if (conexoes.get(sala) !== entrada || ws.readyState !== ws.OPEN) return;
      const agoraMs = Date.now();
      if (agoraMs - ws.janelaMensagensInicio >= JANELA_MENSAGENS_MS) {
        ws.janelaMensagensInicio = agoraMs;
        ws.mensagensNaJanela = 0;
      }
      ws.mensagensNaJanela += 1;
      if (ws.mensagensNaJanela > MAX_MENSAGENS_JANELA) {
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

      if (msg.tipo === "telemetria") {
        registrarTelemetria(sala, entrada, msg);
      } else if (msg.tipo === "info") {
        registrarVersaoFirmware(sala, entrada, msg.fw);
        atualizarFailsafeReportado(entrada, msg);
      } else if (msg.tipo === "failsafe_status") {
        if (atualizarFailsafeReportado(entrada, msg)) eventos.emit("telemetria", { sala, estado: estadoPublico(sala) });
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
    });

    ws.on("close", (code, motivo) => {
      if (conexoes.get(sala) === entrada) {
        conexoes.delete(sala);
        logger.info("device-ws-desconectado", { sala, code, motivo: motivo?.toString() });
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
        eventos.emit("conexao", { sala, conectado: false });
      }
    });
  });

  intervaloPing = setInterval(() => {
    conexoes.forEach((entrada) => {
      if (!entrada.ws.isAlive) {
        entrada.ws.terminate();
        return;
      }
      entrada.ws.isAlive = false;
      entrada.ws.ping();
    });
  }, PING_MS);
  intervaloPing.unref();
}

function encerrar() {
  if (intervaloPing) {
    clearInterval(intervaloPing);
    intervaloPing = null;
  }
  conexoes.forEach((entrada) => {
    try {
      entrada.ws.close(1001, "servidor encerrando");
    } catch (erro) {}
  });
  conexoes.clear();
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
  eventos,
  estadoPublico,
  listarEstados,
  enviarComando,
  sincronizarPapel,
  capturasRecentes,
  capturaRecente,
  limparCapturas,
  enviarAtualizacaoCredencial,
  difundirPoliticaAp,
  dispositivoConectado,
  desconectarSala,
};

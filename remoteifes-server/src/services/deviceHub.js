const EventEmitter = require("events");
const salasService = require("./salasService");
const logger = require("../utils/logger");

const PING_MS = 15 * 1000;
const MAX_CAPTURAS_ARMAZENADAS = 20;

const conexoes = new Map();
const eventos = new EventEmitter();
let wss = null;

function autenticar(req) {
  const sala = req.headers["x-device-sala"];
  const mac = req.headers["x-device-mac"];
  if (!sala || typeof sala !== "string" || !mac || typeof mac !== "string") return null;

  const salaRow = salasService.buscar(sala);
  if (!salaRow || !salasService.macCorrespondeASala(salaRow, mac)) return null;

  return { sala, mac };
}

function estadoPublico(sala) {
  const entrada = conexoes.get(sala);
  if (!entrada) return { conectado: false };
  return {
    conectado: true,
    mac: entrada.mac,
    ip: entrada.ip,
    conectadoEm: entrada.conectadoEm,
    ultimaAtividadeEm: entrada.ultimaAtividadeEm,
    wifiRssi: entrada.wifiRssi,
    modo: entrada.modo,
    ultimaTelemetria: entrada.ultimaTelemetria,
    ultimoComando: entrada.ultimoComando,
    capturasRecentes: entrada.capturas,
  };
}

function listarEstados() {
  const estados = {};
  conexoes.forEach((_, sala) => {
    estados[sala] = estadoPublico(sala);
  });
  return estados;
}

function enviarComando(sala, payload) {
  const entrada = conexoes.get(sala);
  if (!entrada || entrada.ws.readyState !== entrada.ws.OPEN) return false;
  const salaRow = salasService.buscar(sala);
  if (!salaRow || !salasService.macCorrespondeASala(salaRow, entrada.mac)) {
    entrada.ws.close(4001, "vínculo MAC alterado");
    return false;
  }
  entrada.ws.send(JSON.stringify(payload));
  return true;
}

function dispositivoConectado(sala) {
  const entrada = conexoes.get(sala);
  if (!entrada || entrada.ws.readyState !== entrada.ws.OPEN) return false;
  const salaRow = salasService.buscar(sala);
  return !!(salaRow && salasService.macCorrespondeASala(salaRow, entrada.mac));
}

function desconectarSala(sala) {
  const entrada = conexoes.get(sala);
  if (!entrada) return false;
  entrada.ws.close(4001, "vínculo MAC alterado");
  return true;
}

function registrarTelemetria(sala, entrada, msg) {
  const agora = new Date().toISOString();
  entrada.wifiRssi = typeof msg.rssi === "number" ? msg.rssi : entrada.wifiRssi;
  entrada.modo = typeof msg.modo === "string" ? msg.modo : entrada.modo;
  entrada.ultimaTelemetria = {
    temp: typeof msg.temp === "number" ? msg.temp : null,
    hum: typeof msg.hum === "number" ? msg.hum : null,
    rssi: typeof msg.rssi === "number" ? msg.rssi : null,
    modo: entrada.modo,
    ligado: !!msg.ligado,
    recebidoEm: agora,
  };
  if (msg.ultimoComando && typeof msg.ultimoComando === "object") {
    entrada.ultimoComando = { ...msg.ultimoComando, recebidoEm: agora };
  }

  try {
    const estadoReportado = {};
    if (typeof msg.temp === "number" && Number.isFinite(msg.temp)) estadoReportado.temperatura = msg.temp;
    if (typeof msg.ligado === "boolean") estadoReportado.ligado = msg.ligado;
    salasService.marcarOnline(sala, estadoReportado, entrada.mac, entrada.ip);
  } catch (err) {
    logger.warn("device-ws-telemetria-marcar-online-falhou", { sala, mensagem: err.message });
  }

  eventos.emit("telemetria", { sala, estado: estadoPublico(sala) });
}

function registrarCaptura(sala, entrada, msg) {
  const captura = {
    isKnown: !!msg.isKnown,
    protocolId: typeof msg.protocolId === "number" ? msg.protocolId : null,
    protocol: typeof msg.protocol === "string" ? msg.protocol : null,
    hex: typeof msg.hex === "string" ? msg.hex : null,
    raw: Array.isArray(msg.raw) ? msg.raw.slice(0, 1024) : [],
    recebidoEm: new Date().toISOString(),
  };
  entrada.capturas.unshift(captura);
  if (entrada.capturas.length > MAX_CAPTURAS_ARMAZENADAS) entrada.capturas.length = MAX_CAPTURAS_ARMAZENADAS;
  eventos.emit("captura", { sala, captura });
}

function iniciar(server) {
  const { WebSocketServer } = require("ws");
  wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url, "http://localhost");
    if (pathname !== "/ws/dispositivo") return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws, req) => {
    const auth = autenticar(req);
    if (!auth) {
      ws.close(4001, "não autorizado");
      return;
    }

    const { sala, mac } = auth;
    const ip = req.socket.remoteAddress;
    const agora = new Date().toISOString();

    const antiga = conexoes.get(sala);
    if (antiga && antiga.ws.readyState === antiga.ws.OPEN) {
      antiga.ws.close(4002, "nova conexão do mesmo dispositivo");
    }

    const entrada = {
      ws,
      mac,
      ip,
      conectadoEm: agora,
      ultimaAtividadeEm: agora,
      wifiRssi: null,
      modo: "operation",
      ultimaTelemetria: null,
      ultimoComando: null,
      capturas: [],
    };
    conexoes.set(sala, entrada);
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });

    try {
      salasService.marcarOnline(sala, {}, mac, ip);
    } catch (err) {
      logger.warn("device-ws-conectar-marcar-online-falhou", { sala, mensagem: err.message });
    }
    logger.info("device-ws-conectado", { sala, mac, ip });
    eventos.emit("conexao", { sala, conectado: true });
    const comandoInicial = salasService.comandoEstadoIR(salasService.buscar(sala));
    if (comandoInicial) ws.send(JSON.stringify(comandoInicial));

    ws.on("message", (dados) => {
      const salaAtual = salasService.buscar(sala);
      if (!salaAtual || !salasService.macCorrespondeASala(salaAtual, entrada.mac)) {
        ws.close(4001, "vínculo MAC alterado");
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
      } else if (msg.tipo === "captura") {
        registrarCaptura(sala, entrada, msg);
      } else if (msg.tipo === "acesso") {
        salasService.registrarAcessoEsp(sala, {
          ip: typeof msg.ip === "string" ? msg.ip : entrada.ip,
          userAgent: typeof msg.userAgent === "string" ? msg.userAgent.slice(0, 500) : null,
        });
      } else if (msg.tipo === "comando") {
        if (typeof msg.cmd === "string" && msg.cmd.length <= 100) {
          salasService.registrarComandoDispositivo(sala, msg.cmd, msg.valor);
        }
      } else if (msg.tipo === "modo_alterado") {
        entrada.modo = typeof msg.modo === "string" ? msg.modo : entrada.modo;
        eventos.emit("telemetria", { sala, estado: estadoPublico(sala) });
      }
    });

    ws.on("close", (code, motivo) => {
      if (conexoes.get(sala) === entrada) {
        conexoes.delete(sala);
        logger.info("device-ws-desconectado", { sala, code, motivo: motivo?.toString() });
        eventos.emit("conexao", { sala, conectado: false });
      }
    });

    ws.on("error", (err) => {
      logger.warn("device-ws-erro", { sala, mensagem: err.message });
    });
  });

  const intervaloPing = setInterval(() => {
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

module.exports = {
  iniciar,
  eventos,
  estadoPublico,
  listarEstados,
  enviarComando,
  dispositivoConectado,
  desconectarSala,
};

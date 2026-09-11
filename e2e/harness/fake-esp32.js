const WebSocket = require("ws");

function iniciarFakeEsp32({ url, sala, mac, temperatura = 23.5, firmware = "4.0.0" }) {
  let ws = null;
  let telemetriaTimer = null;
  let parado = false;
  let ligado = false;
  let powerConhecido = false;
  let versao = firmware;
  let comportamentoOta = "ok";
  let role = "transmitter";
  let modo = "operation";
  let failsafe = null;
  let ultimoRaw = null;
  const recebidas = [];

  function camposFailsafe() {
    return {
      failsafeConfigurado: !!failsafe,
      failsafePulsos: failsafe ? failsafe.raw.length : 0,
      failsafeCarrierHz: failsafe ? failsafe.carrierHz : 0,
      failsafeProtocolRecordId: failsafe ? failsafe.protocolRecordId : -1,
    };
  }

  function enviar(obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(obj));
    return true;
  }

  function enviarTelemetria() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const quadro = {
      tipo: "telemetria",
      temp: temperatura,
      hum: 55,
      rssi: -58,
      modo,
      fw: versao,
      ...camposFailsafe(),
    };
    if (powerConhecido) quadro.ligado = ligado;
    ws.send(JSON.stringify(quadro));
  }

  function definirModo(novo) {
    modo = novo;
    enviar({ tipo: "modo_alterado", modo });
  }

  function conectar() {
    if (parado) return;
    ws = new WebSocket(`${url}/ws/dispositivo`, {
      headers: { "x-device-sala": sala, "x-device-mac": mac },
    });

    ws.on("open", () => {
      enviar({ tipo: "info", fw: versao, ...camposFailsafe() });
      enviarTelemetria();
      telemetriaTimer = setInterval(enviarTelemetria, 8000);
      if (telemetriaTimer.unref) telemetriaTimer.unref();
    });

    ws.on("message", (dados) => {
      let msg;
      try {
        msg = JSON.parse(dados.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg.tipo !== "string") return;
      recebidas.push(msg);
      if (recebidas.length > 50) recebidas.shift();
      if (msg.tipo === "send_known_state" && typeof msg.protocol === "number" && msg.protocol >= 0) {
        ligado = msg.power === true;
        powerConhecido = true;
        setTimeout(enviarTelemetria, 40);
      } else if (msg.tipo === "ota_oferta") {
        responderOta(msg);
      } else if (msg.tipo === "device_role") {
        role = msg.role === "cloner" ? "cloner" : "transmitter";
        if (role !== "cloner" && modo === "config_clone") definirModo("operation");
      } else if (msg.tipo === "enter_clone") {
        if (role === "cloner") definirModo("config_clone");
      } else if (msg.tipo === "enter_config") {
        definirModo("config_idle");
      } else if (msg.tipo === "set_mode") {
        if (msg.modo === "clone" && role === "cloner") definirModo("config_clone");
        else if (msg.modo === "idle") definirModo("config_idle");
      } else if (msg.tipo === "exit_operation") {
        definirModo("operation");
      } else if (msg.tipo === "send_raw") {
        ultimoRaw = { raw: msg.raw, carrierHz: msg.carrierHz, em: Date.now() };
      } else if (msg.tipo === "failsafe_raw_set") {
        failsafe = { raw: msg.raw, carrierHz: msg.carrierHz, protocolRecordId: msg.protocolRecordId };
        enviar({ tipo: "failsafe_status", ...camposFailsafe() });
      } else if (msg.tipo === "failsafe_raw_clear") {
        failsafe = null;
        enviar({ tipo: "failsafe_status", ...camposFailsafe() });
      }
    });

    ws.on("close", () => {
      if (telemetriaTimer) clearInterval(telemetriaTimer);
      telemetriaTimer = null;
      if (!parado) setTimeout(conectar, 500);
    });

    ws.on("error", () => {
      try {
        ws.close();
      } catch {}
    });
  }

  function responderOta(oferta) {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ tipo: "ota_progresso", recebido: Math.round(oferta.tamanho / 2), total: oferta.tamanho }));
    if (comportamentoOta === "erro") {
      ws.send(JSON.stringify({ tipo: "ota_resultado", resultado: "erro", erro: "sha256 divergente" }));
      return;
    }
    ws.send(JSON.stringify({ tipo: "ota_resultado", resultado: "ok" }));
    setTimeout(() => {
      if (comportamentoOta !== "rollback") versao = oferta.versao;
      try {
        ws.close();
      } catch {}
    }, 120);
  }

  conectar();

  return {
    definirComportamentoOta(modo) {
      comportamentoOta = modo;
    },
    definirFirmware(fw) {
      versao = fw;
      enviarTelemetria();
    },
    firmware: () => versao,
    estado() {
      return { role, modo, failsafe, ultimoRaw, conectado: !!ws && ws.readyState === WebSocket.OPEN, recebidas: recebidas.slice() };
    },
    capturar(captura) {
      return enviar({
        tipo: "captura",
        isKnown: captura.isKnown !== false,
        protocolId: Number.isInteger(captura.protocolId) ? captura.protocolId : 1,
        protocol: captura.protocol || "COOLIX",
        hex: captura.hex || "0xB2BF40",
        raw: captura.raw || [4400, 4400, 550, 1600, 550, 550, 550, 1600, 550, 550],
        carrierHz: captura.carrierHz || 38000,
      });
    },
    resetarProtocolos() {
      modo = "operation";
      failsafe = null;
      ultimoRaw = null;
      recebidas.length = 0;
      enviar({ tipo: "modo_alterado", modo });
      enviar({ tipo: "failsafe_status", ...camposFailsafe() });
    },
    resetar() {
      ligado = false;
      powerConhecido = false;
      enviarTelemetria();
    },
    parar() {
      parado = true;
      if (telemetriaTimer) clearInterval(telemetriaTimer);
      try {
        if (ws) ws.close();
      } catch {}
    },
  };
}

module.exports = { iniciarFakeEsp32 };

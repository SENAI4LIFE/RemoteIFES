const WebSocket = require("ws");

function iniciarFakeEsp32({ url, sala, mac, temperatura = 23.5 }) {
  let ws = null;
  let telemetriaTimer = null;
  let parado = false;
  let ligado = false;
  let powerConhecido = false;

  function enviarTelemetria() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const quadro = {
      tipo: "telemetria",
      temp: temperatura,
      hum: 55,
      rssi: -58,
      modo: "operation",
    };
    if (powerConhecido) quadro.ligado = ligado;
    ws.send(JSON.stringify(quadro));
  }

  function conectar() {
    if (parado) return;
    ws = new WebSocket(`${url}/ws/dispositivo`, {
      headers: { "x-device-sala": sala, "x-device-mac": mac },
    });

    ws.on("open", () => {
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
      if (msg && msg.tipo === "send_known_state" && typeof msg.protocol === "number" && msg.protocol >= 0) {
        ligado = msg.power === true;
        powerConhecido = true;
        setTimeout(enviarTelemetria, 40);
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

  conectar();

  return {
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

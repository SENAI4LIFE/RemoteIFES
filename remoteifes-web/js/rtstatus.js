const RTStatus = (() => {
  let ws = null;
  let salaObservada = null;
  let reconectarTimeoutId = null;
  let tentativas = 0;
  const ouvintesSalas = new Set();
  const ouvintesStatus = new Set();

  function wsUrl() {
    const base = (window.RemoteIFESConfig && window.RemoteIFESConfig.serverUrl) || "http://localhost:8080";
    const wsBase = base.replace(/^http/, "ws");
    return `${wsBase}/ws?token=${encodeURIComponent(Api.obterToken() || "")}`;
  }

  function enviarObservar(sala) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ tipo: "observar", sala }));
    }
  }

  function conectar() {
    if (!Api.temTokenSalvo()) return;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    ws = new WebSocket(wsUrl());

    ws.addEventListener("open", () => {
      tentativas = 0;
      if (salaObservada) enviarObservar(salaObservada);
    });

    ws.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (err) {
        return;
      }
      if (msg.tipo === "salas") {
        ouvintesSalas.forEach((cb) => cb(msg.salas));
      } else if (msg.tipo === "status") {
        ouvintesStatus.forEach((cb) => cb(msg.status));
      }
    });

    ws.addEventListener("close", () => {
      ws = null;
      if (!Api.temTokenSalvo()) return;
      tentativas += 1;
      const espera = Math.min(15000, 1000 * tentativas);
      reconectarTimeoutId = setTimeout(conectar, espera);
    });

    ws.addEventListener("error", () => {
      if (ws) ws.close();
    });
  }

  function desconectar() {
    if (reconectarTimeoutId) {
      clearTimeout(reconectarTimeoutId);
      reconectarTimeoutId = null;
    }
    salaObservada = null;
    tentativas = 0;
    if (ws) {
      ws.close();
      ws = null;
    }
  }

  function observarSala(sala) {
    salaObservada = sala;
    enviarObservar(sala);
  }

  function pararObservarSala() {
    salaObservada = null;
    enviarObservar(null);
  }

  function aoSalas(cb) {
    ouvintesSalas.add(cb);
    return () => ouvintesSalas.delete(cb);
  }

  function aoStatusSala(cb) {
    ouvintesStatus.add(cb);
    return () => ouvintesStatus.delete(cb);
  }

  return { conectar, desconectar, observarSala, pararObservarSala, aoSalas, aoStatusSala };
})();

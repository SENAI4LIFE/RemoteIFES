const ServerStatus = (() => {
  let ws = null;
  let reconectarTimeoutId = null;
  let tentativas = 0;
  let confirmado = false;
  const ouvintesPronto = new Set();

  const tela = document.getElementById("screen-server-status");
  const titulo = document.getElementById("serverStatusTitulo");
  const desc = document.getElementById("serverStatusDesc");
  const retryBtn = document.getElementById("serverStatusRetryBtn");

  function wsUrl() {
    const base = (window.RemoteIFESConfig && window.RemoteIFESConfig.serverUrl) || "http://localhost:8080";
    const wsBase = base.replace(/^http/, "ws");
    return `${wsBase}/ws`;
  }

  function aplicarEstadoConectando() {
    tela.classList.remove("hidden");
    titulo.textContent = "Sem conexão com o servidor";
    desc.textContent = tentativas > 1
      ? `Tentando reconectar… (tentativa ${tentativas})`
      : "Tentando reconectar…";
  }

  function aplicarEstadoManutencao() {
    tela.classList.remove("hidden");
    titulo.textContent = "Sistema em manutenção";
    desc.textContent = "O RemoteIFES está passando por uma manutenção programada. Tente novamente em alguns instantes.";
  }

  function esconderTela() {
    tela.classList.add("hidden");
  }

  function notificarPronto() {
    if (confirmado) return;
    confirmado = true;
    ouvintesPronto.forEach((cb) => cb());
  }

  function processarMensagem(msg) {
    if (!msg || msg.tipo !== "servidor") return;
    if (msg.manutencao) {
      aplicarEstadoManutencao();
      return;
    }
    if (msg.online === false) {
      aplicarEstadoConectando();
      return;
    }
    esconderTela();
    notificarPronto();
  }

  function conectar() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    aplicarEstadoConectando();

    try {
      ws = new WebSocket(wsUrl());
    } catch (err) {
      agendarReconexao();
      return;
    }

    ws.addEventListener("open", () => {
      tentativas = 0;
    });

    ws.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (err) {
        return;
      }
      processarMensagem(msg);
    });

    ws.addEventListener("close", () => {
      ws = null;
      agendarReconexao();
    });

    ws.addEventListener("error", () => {
      if (ws) ws.close();
    });
  }

  function agendarReconexao() {
    if (reconectarTimeoutId) clearTimeout(reconectarTimeoutId);
    tentativas += 1;
    aplicarEstadoConectando();
    const espera = Math.min(15000, 1000 * tentativas);
    reconectarTimeoutId = setTimeout(conectar, espera);
  }

  function tentarNovamente() {
    if (retryBtn.disabled) return;
    retryBtn.disabled = true;
    retryBtn.textContent = "Tentando…";
    if (reconectarTimeoutId) clearTimeout(reconectarTimeoutId);
    tentativas = 0;
    conectar();
    setTimeout(() => {
      retryBtn.disabled = false;
      retryBtn.textContent = "Tentar novamente agora";
    }, 1200);
  }

  retryBtn.addEventListener("click", tentarNovamente);

  function aoFicarPronto(cb) {
    ouvintesPronto.add(cb);
    if (confirmado) cb();
    return () => ouvintesPronto.delete(cb);
  }

  return { conectar, aoFicarPronto, tentarNovamente };
})();

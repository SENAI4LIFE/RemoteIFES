const Esp32Admin = (() => {
  const listEl = document.getElementById("esp32DeviceList");
  const emptyEl = document.getElementById("esp32DeviceListEmpty");

  let dispositivos = [];
  let salaObservada = null;
  let pararOuvirMensagens = null;
  let pararOuvirConexao = null;
  let intervaloAtualizacao = null;
  let carregando = false;

  const MODO_ROTULOS = {
    operation: "operação",
    config_idle: "modo config",
    config_clone: "modo clonagem",
  };

  function modoRotulo(modo) {
    return MODO_ROTULOS[modo] || modo || "—";
  }

  function formatarNumero(valor, casas, sufixo) {
    if (valor === null || valor === undefined) return "—";
    const numero = Number(valor);
    if (Number.isNaN(numero)) return "—";
    return `${numero.toFixed(casas)}${sufixo}`;
  }

  function renderUltimoComando(uc) {
    if (!uc) return "nenhum ainda";
    if (uc.tipo === "raw") return "sinal bruto (raw) reenviado";
    if (uc.tipo === "known_state") {
      const partes = [`${formatarNumero(uc.temp, 0, "°C")}`, uc.power ? "ligado" : "desligado"];
      if (uc.turbo) partes.push("turbo");
      if (uc.fan) partes.push(`fan ${uc.fan}`);
      return partes.join(" · ");
    }
    return uc.tipo;
  }

  function renderCapturas(ul, capturas) {
    ul.innerHTML = "";
    (capturas || []).forEach((c) => {
      const li = document.createElement("li");
      li.className = "esp32-capture-item";
      li.innerHTML = `
        <div class="esp32-capture-info">
          <div>${c.isKnown ? "protocolo conhecido" : "sinal genérico"}: <strong>${escapeHtml(c.protocol || "?")}</strong></div>
          <div class="esp32-capture-hex">${escapeHtml(c.hex || "")} · ${(c.raw || []).length} pulsos</div>
        </div>
        <div class="esp32-capture-actions">
          <button type="button" class="link-btn testar-captura-btn">testar</button>
          ${c.isKnown && Number.isInteger(c.protocolId) ? `<button type="button" class="link-btn usar-protocolo-btn">usar protocolo</button>` : ""}
        </div>
      `;
      li.querySelector(".testar-captura-btn").addEventListener("click", async () => {
        const sala = ul.closest(".esp32-device-card").dataset.sala;
        const resp = await Api.testarRawEsp32(sala, c.raw, 38000);
        if (!resp.ok) Toast.erro(resp.erro || "não foi possível testar o sinal");
        else Toast.aviso("sinal reenviado para teste");
      });
      const usarProtocoloBtn = li.querySelector(".usar-protocolo-btn");
      if (usarProtocoloBtn) usarProtocoloBtn.addEventListener("click", async () => {
        const sala = ul.closest(".esp32-device-card").dataset.sala;
        const resp = await Api.definirProtocoloIrEsp32(sala, c.protocolId);
        if (!resp.ok) {
          Toast.erro(resp.erro || "não foi possível salvar o protocolo");
          return;
        }
        const item = dispositivos.find((d) => d.sala === sala);
        if (item) item.irProtocolo = c.protocolId;
        Toast.aviso("protocolo do ar-condicionado salvo");
        render();
      });
      ul.appendChild(li);
    });
  }

  function renderDispositivo(d) {
    const dispositivo = d.dispositivo || {};
    const conectado = !!dispositivo.conectado;
    const telemetria = dispositivo.ultimaTelemetria || {};
    const modo = dispositivo.modo || "operation";
    const emConfig = conectado && modo !== "operation";

    const li = document.createElement("li");
    li.className = "card esp32-device-card";
    li.dataset.sala = d.sala;

    li.innerHTML = `
      <div class="esp32-device-head">
        <div>
          <div class="room-name">${escapeHtml(d.nome)} <span class="room-sub">(${escapeHtml(d.sala)})</span></div>
          <div class="esp32-badge-row">
            <span class="esp32-conn-badge ${d.online ? "on" : "off"}">Wi-Fi ${d.online ? "conectado" : "desconectado"}</span>
            <span class="esp32-conn-badge ${conectado ? "on" : "off"}">Servidor ${conectado ? "conectado" : "desconectado"}</span>
            ${conectado ? `<span class="esp32-conn-badge modo">${modoRotulo(modo)}</span>` : ""}
          </div>
        </div>
      </div>

      <div class="esp32-metric-grid">
        <div class="esp32-metric"><div class="esp32-metric-label">Temperatura</div><div class="esp32-metric-value">${formatarNumero(telemetria.temp, 1, "°C")}</div></div>
        <div class="esp32-metric"><div class="esp32-metric-label">Umidade</div><div class="esp32-metric-value">${formatarNumero(telemetria.hum, 0, "%")}</div></div>
        <div class="esp32-metric"><div class="esp32-metric-label">Sinal Wi-Fi</div><div class="esp32-metric-value">${dispositivo.wifiRssi != null ? `${dispositivo.wifiRssi} dBm` : "—"}</div></div>
        <div class="esp32-metric"><div class="esp32-metric-label">Protocolo IR</div><div class="esp32-metric-value">${Number.isInteger(d.irProtocolo) ? d.irProtocolo : "não definido"}</div></div>
        <div class="esp32-metric"><div class="esp32-metric-label">Último comando IR</div><div class="esp32-metric-value">${escapeHtml(renderUltimoComando(dispositivo.ultimoComando))}</div></div>
      </div>

      ${!emConfig ? `
        <div class="esp32-config-form">
          <button type="button" class="btn btn-on entrar-config-btn" ${conectado ? "" : "disabled"}>Entrar em modo de configuração</button>
        </div>
      ` : `
        <div class="esp32-actions">
          <button type="button" class="btn btn-off modo-clone-btn" ${modo === "config_clone" ? "disabled" : ""}>Ativar modo clonagem</button>
          <button type="button" class="btn btn-off modo-idle-btn" ${modo === "config_idle" ? "disabled" : ""}>Voltar ao modo config</button>
          <button type="button" class="btn btn-off iniciar-captura-btn" ${modo === "config_clone" ? "" : "disabled"}>Iniciar captura IR</button>
          <button type="button" class="btn btn-off parar-captura-btn">Parar captura IR</button>
          <button type="button" class="btn btn-off sair-config-btn">Sair do modo de configuração</button>
        </div>
        <p class="hint">Sinais capturados aparecem abaixo em tempo real. Use "testar" para reenviar um sinal capturado e confirmar que ele controla o aparelho.</p>
        <ul class="esp32-capture-list"></ul>
      `}

      <div class="esp32-actions">
        <button type="button" class="link-btn danger reset-wifi-btn" ${conectado ? "" : "disabled"}>Resetar Wi-Fi do dispositivo</button>
      </div>
    `;

    const entrarBtn = li.querySelector(".entrar-config-btn");
    if (entrarBtn) {
      entrarBtn.addEventListener("click", async () => {
        entrarBtn.disabled = true;
        const resp = await Api.entrarConfigEsp32(d.sala);
        entrarBtn.disabled = false;
        if (!resp.ok) Toast.erro(resp.erro || "não foi possível entrar em modo de configuração");
      });
    }

    const modoCloneBtn = li.querySelector(".modo-clone-btn");
    if (modoCloneBtn) modoCloneBtn.addEventListener("click", async () => {
      const resp = await Api.definirModoEsp32(d.sala, "clone");
      if (!resp.ok) Toast.erro(resp.erro || "não foi possível mudar o modo");
    });

    const modoIdleBtn = li.querySelector(".modo-idle-btn");
    if (modoIdleBtn) modoIdleBtn.addEventListener("click", async () => {
      const resp = await Api.definirModoEsp32(d.sala, "idle");
      if (!resp.ok) Toast.erro(resp.erro || "não foi possível mudar o modo");
    });

    const iniciarCapturaBtn = li.querySelector(".iniciar-captura-btn");
    if (iniciarCapturaBtn) iniciarCapturaBtn.addEventListener("click", async () => {
      const resp = await Api.iniciarCapturaEsp32(d.sala);
      if (!resp.ok) Toast.erro(resp.erro || "não foi possível iniciar a captura");
    });

    const pararCapturaBtn = li.querySelector(".parar-captura-btn");
    if (pararCapturaBtn) pararCapturaBtn.addEventListener("click", async () => {
      const resp = await Api.pararCapturaEsp32(d.sala);
      if (!resp.ok) Toast.erro(resp.erro || "não foi possível parar a captura");
    });

    const sairConfigBtn = li.querySelector(".sair-config-btn");
    if (sairConfigBtn) sairConfigBtn.addEventListener("click", async () => {
      const resp = await Api.sairOperacaoEsp32(d.sala);
      if (!resp.ok) Toast.erro(resp.erro || "não foi possível sair do modo de configuração");
    });

    const resetWifiBtn = li.querySelector(".reset-wifi-btn");
    resetWifiBtn.addEventListener("click", async () => {
      const ok = await Dialog.confirmar({
        titulo: "Resetar Wi-Fi do dispositivo",
        mensagem: `Resetar o Wi-Fi do ESP32 da sala ${d.sala}? O dispositivo vai apagar suas credenciais salvas e reiniciar em modo de configuração (ponto de acesso).`,
        confirmarTexto: "Resetar Wi-Fi",
        perigo: true,
      });
      if (!ok) return;
      const resp = await Api.resetarWifiEsp32(d.sala);
      if (!resp.ok) Toast.erro(resp.erro || "não foi possível resetar o Wi-Fi do dispositivo");
      else Toast.aviso("comando de reset enviado ao dispositivo");
    });

    const capturaList = li.querySelector(".esp32-capture-list");
    if (capturaList) renderCapturas(capturaList, dispositivo.capturasRecentes);

    return li;
  }

  function render() {
    listEl.innerHTML = "";
    if (dispositivos.length === 0) {
      emptyEl.classList.remove("hidden");
      return;
    }
    emptyEl.classList.add("hidden");
    dispositivos.forEach((d) => listEl.appendChild(renderDispositivo(d)));
  }

  function aplicarEstadoDispositivo(sala, estado) {
    const item = dispositivos.find((d) => d.sala === sala);
    if (!item) return;
    item.dispositivo = estado;
    render();
  }

  function aplicarCapturaDispositivo(sala, captura) {
    const item = dispositivos.find((d) => d.sala === sala);
    if (!item) return;
    if (!item.dispositivo) item.dispositivo = {};
    if (!Array.isArray(item.dispositivo.capturasRecentes)) item.dispositivo.capturasRecentes = [];
    item.dispositivo.capturasRecentes.unshift(captura);
    item.dispositivo.capturasRecentes.length = Math.min(item.dispositivo.capturasRecentes.length, 20);
    render();
  }

  function aoMensagemWs(msg) {
    if (msg.tipo === "dispositivo_status") {
      aplicarEstadoDispositivo(msg.sala, msg.estado);
    } else if (msg.tipo === "dispositivo_captura") {
      aplicarCapturaDispositivo(msg.sala, msg.captura);
    } else if (msg.tipo === "dispositivo_erro") {
      Toast.erro(msg.mensagem || "erro reportado pelo dispositivo");
    }
  }

  function observarTodasAsSalas() {
    const salas = dispositivos.filter((d) => d.mac).map((d) => d.sala);
    ServerStatus.enviar({ tipo: "observar_dispositivos", salas });
  }

  async function carregar() {
    if (carregando) return;
    carregando = true;
    try {
      dispositivos = await Api.listarDispositivosEsp32();
      if (!Array.isArray(dispositivos)) dispositivos = [];
      render();
      observarTodasAsSalas();
    } finally {
      carregando = false;
    }
  }

  async function aoAbrir() {
    if (!state.isSuperAdmin) return;
    if (!pararOuvirMensagens) pararOuvirMensagens = ServerStatus.aoMensagem(aoMensagemWs);
    if (!pararOuvirConexao) pararOuvirConexao = ServerStatus.aoConectar(observarTodasAsSalas);
    await carregar();
    if (!intervaloAtualizacao) intervaloAtualizacao = setInterval(carregar, 20000);
  }

  function aoFechar() {
    ServerStatus.enviar({ tipo: "observar_dispositivos", salas: [] });
    if (intervaloAtualizacao) {
      clearInterval(intervaloAtualizacao);
      intervaloAtualizacao = null;
    }
    if (pararOuvirMensagens) {
      pararOuvirMensagens();
      pararOuvirMensagens = null;
    }
    if (pararOuvirConexao) {
      pararOuvirConexao();
      pararOuvirConexao = null;
    }
  }

  return { aoAbrir, aoFechar };
})();

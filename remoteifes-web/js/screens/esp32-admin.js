const Esp32Admin = (() => {
  const listEl = document.getElementById("esp32DeviceList");
  const emptyEl = document.getElementById("esp32DeviceListEmpty");
  const rolloutPainel = document.getElementById("otaRolloutPainel");

  let dispositivos = [];
  let rollout = null;
  let elegiveisRollout = [];
  let limitesRollout = { loteMin: 1, loteMax: 5, lotePadrao: 2, maxSimultaneos: 2 };
  let tamanhoLoteRollout = null;
  let canarioRollout = null;
  let assinaturaRollout = null;
  const selecaoRollout = new Set();
  let salaObservada = null;
  let pararOuvirMensagens = null;
  let pararOuvirConexao = null;
  let intervaloAtualizacao = null;
  let carregando = false;
  let manifestoFirmware = null;

  const MODO_ROTULOS = {
    operation: "operação",
    config_idle: "modo config",
    config_clone: "modo clonagem",
  };

  const OTA_FASE_ROTULOS = {
    ofertado: "atualização enviada ao dispositivo…",
    baixando: "baixando firmware…",
    gravado: "firmware gravado, reiniciando…",
    reiniciando: "reiniciando para validar…",
    concluido: "atualização concluída",
    falhou: "falha na atualização",
  };

  function renderOta(d) {
    const dispositivo = d.dispositivo || {};
    const conectado = !!dispositivo.conectado;
    const ota = dispositivo.ota || { fase: "ocioso" };
    const versaoDispositivo = dispositivo.fwVersao || d.fwVersao || null;
    const versaoPublicada = manifestoFirmware ? manifestoFirmware.versao : null;
    const emAndamento = ["ofertado", "baixando", "gravado", "reiniciando"].includes(ota.fase);
    const atualizado = versaoPublicada && versaoDispositivo === versaoPublicada;

    let statusLinha = "";
    if (ota.fase === "baixando" && ota.total) {
      const pct = Math.min(100, Math.round((ota.recebido / ota.total) * 100));
      statusLinha = `${OTA_FASE_ROTULOS.baixando} ${pct}%`;
    } else if (OTA_FASE_ROTULOS[ota.fase]) {
      statusLinha = OTA_FASE_ROTULOS[ota.fase];
      if (ota.fase === "falhou" && ota.erro) statusLinha += `: ${ota.erro}`;
    }

    const emRollout = salaNoRolloutAtivo(d.sala);
    const podeAtualizar = conectado && versaoPublicada && !emAndamento && !atualizado && !emRollout;
    return `
      <div class="esp32-ota">
        <div class="esp32-ota-linha">
          <span>Firmware: <strong>${escapeHtml(versaoDispositivo || "desconhecido")}</strong>${
            versaoPublicada ? ` · publicado: <strong>${escapeHtml(versaoPublicada)}</strong>` : ""
          }${atualizado ? ` <span class="esp32-conn-badge on">atualizado</span>` : ""}</span>
          <button type="button" class="btn btn-off ota-btn" ${podeAtualizar ? "" : "disabled"}>Atualizar firmware (OTA)</button>
        </div>
        ${statusLinha ? `<div class="esp32-ota-status ${ota.fase}">${escapeHtml(statusLinha)}</div>` : ""}
        ${emRollout ? `<div class="esp32-ota-status">esta sala faz parte da distribuição em etapas em andamento</div>` : ""}
      </div>
    `;
  }

  function renderCredencial(d) {
    const c = d.credencial || { provisionado: false };
    let badge;
    if (!c.provisionado) badge = `<span class="esp32-conn-badge off">sem credencial (só MAC)</span>`;
    else if (c.revogado) badge = `<span class="esp32-conn-badge off">credencial revogada</span>`;
    else if (c.graceRotacaoAtivo) badge = `<span class="esp32-conn-badge modo">rotação: tolerância ativa</span>`;
    else badge = `<span class="esp32-conn-badge on">credencial ativa</span>`;

    const idLinha = c.provisionado
      ? `<div class="hint">deviceId: <code>${escapeHtml(c.deviceId || "")}</code>${
          c.ultimoUsoEm ? ` · último uso: ${escapeHtml(c.ultimoUsoEm)}` : ""
        }</div>`
      : "";

    let botoes;
    if (!c.provisionado || c.revogado) {
      botoes = `<button type="button" class="btn btn-on cred-provisionar-btn">Provisionar credencial</button>`;
    } else {
      botoes = `
        <button type="button" class="btn btn-off cred-rotacionar-btn">Rotacionar</button>
        <button type="button" class="btn btn-off cred-substituir-btn">Substituir (troca de hardware)</button>
        <button type="button" class="link-btn danger cred-revogar-btn">Revogar</button>
      `;
    }

    return `
      <div class="esp32-cred">
        <div class="esp32-cred-linha"><span>Autenticação do dispositivo ${badge}</span></div>
        ${idLinha}
        <div class="esp32-actions">${botoes}</div>
      </div>
    `;
  }

  async function mostrarSegredo(titulo, r) {
    await Dialog.abrir({
      titulo,
      confirmarTexto: "Fechar",
      semCancelar: true,
      montarCorpo(body) {
        const p = document.createElement("p");
        p.className = "hint";
        p.textContent = r.enviadoAoDispositivo
          ? "A credencial foi enviada ao dispositivo conectado: ele vai reconectar já autenticado. Guarde o segredo abaixo mesmo assim, ele não será exibido de novo."
          : "Informe estes dois valores no portal de setup do ESP32. O segredo não será exibido novamente.";
        const box = document.createElement("div");
        box.className = "esp32-cred-segredo";
        box.innerHTML = `
          <div><span>deviceId</span><code>${escapeHtml(r.deviceId)}</code></div>
          <div><span>segredo</span><code>${escapeHtml(r.segredo)}</code></div>
        `;
        const copiar = document.createElement("button");
        copiar.type = "button";
        copiar.className = "btn btn-off";
        copiar.textContent = "Copiar deviceId e segredo";
        copiar.addEventListener("click", () => {
          const txt = `deviceId=${r.deviceId}\nsegredo=${r.segredo}`;
          if (navigator.clipboard) navigator.clipboard.writeText(txt).then(() => Toast.aviso("copiado"), () => {});
        });
        body.append(p, box, copiar);
      },
    });
  }

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

      ${renderOta(d)}

      ${renderCredencial(d)}

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

    const otaBtn = li.querySelector(".ota-btn");
    if (otaBtn && !otaBtn.disabled) {
      otaBtn.addEventListener("click", async () => {
        const versaoPublicada = manifestoFirmware ? manifestoFirmware.versao : "";
        const ok = await Dialog.confirmar({
          titulo: "Atualizar firmware por OTA",
          mensagem: `Enviar o firmware ${versaoPublicada} para o ESP32 da sala ${d.sala}? O dispositivo baixa a imagem, verifica o hash, grava e reinicia. Se a nova versão não validar, ele reverte sozinho para a atual.`,
          confirmarTexto: "Enviar atualização",
        });
        if (!ok) return;
        otaBtn.disabled = true;
        const resp = await Api.atualizarFirmwareEsp32(d.sala);
        if (!resp.ok) {
          otaBtn.disabled = false;
          Toast.erro(resp.erro || "não foi possível iniciar a atualização");
        } else {
          Toast.aviso("atualização enviada ao dispositivo");
        }
      });
    }

    const credProvBtn = li.querySelector(".cred-provisionar-btn");
    if (credProvBtn) credProvBtn.addEventListener("click", async () => {
      const ok = await Dialog.confirmar({
        titulo: "Provisionar credencial",
        mensagem: `Gerar uma credencial exclusiva para o ESP32 da sala ${d.sala}? A partir daí a sala passa a exigir essa credencial (o MAC sozinho deixa de ser aceito). Se o dispositivo estiver conectado agora, ele recebe a credencial automaticamente.`,
        confirmarTexto: "Provisionar",
      });
      if (!ok) return;
      const resp = await Api.provisionarCredencialEsp32(d.sala);
      if (!resp.ok) return Toast.erro(resp.erro || "não foi possível provisionar");
      await mostrarSegredo("Credencial provisionada", resp);
      carregar();
    });

    const credRotBtn = li.querySelector(".cred-rotacionar-btn");
    if (credRotBtn) credRotBtn.addEventListener("click", async () => {
      const ok = await Dialog.confirmar({
        titulo: "Rotacionar credencial",
        mensagem: `Gerar um novo segredo para a sala ${d.sala}? O segredo anterior continua válido por 24 h para dar tempo do dispositivo migrar.`,
        confirmarTexto: "Rotacionar",
      });
      if (!ok) return;
      const resp = await Api.rotacionarCredencialEsp32(d.sala);
      if (!resp.ok) return Toast.erro(resp.erro || "não foi possível rotacionar");
      await mostrarSegredo("Credencial rotacionada", resp);
      carregar();
    });

    const credSubBtn = li.querySelector(".cred-substituir-btn");
    if (credSubBtn) credSubBtn.addEventListener("click", async () => {
      const ok = await Dialog.confirmar({
        titulo: "Substituir credencial",
        mensagem: `Emitir um novo deviceId e segredo para a sala ${d.sala} (troca de placa)? O segredo anterior deixa de valer imediatamente. A associação da sala é preservada.`,
        confirmarTexto: "Substituir",
        perigo: true,
      });
      if (!ok) return;
      const resp = await Api.substituirCredencialEsp32(d.sala);
      if (!resp.ok) return Toast.erro(resp.erro || "não foi possível substituir");
      await mostrarSegredo("Nova credencial", resp);
      carregar();
    });

    const credRevBtn = li.querySelector(".cred-revogar-btn");
    if (credRevBtn) credRevBtn.addEventListener("click", async () => {
      const ok = await Dialog.confirmar({
        titulo: "Revogar credencial",
        mensagem: `Revogar a credencial da sala ${d.sala}? A conexão atual do dispositivo é encerrada e ele não volta a autenticar até ser reprovisionado.`,
        confirmarTexto: "Revogar",
        perigo: true,
      });
      if (!ok) return;
      const resp = await Api.revogarCredencialEsp32(d.sala);
      if (!resp.ok) return Toast.erro(resp.erro || "não foi possível revogar");
      Toast.aviso("credencial revogada");
      carregar();
    });

    const resetWifiBtn = li.querySelector(".reset-wifi-btn");
    resetWifiBtn.addEventListener("click", async () => {
      const ok = await Dialog.confirmar({
        titulo: "Resetar Wi-Fi do dispositivo",
        mensagem: `Resetar o Wi-Fi do ESP32 da sala ${d.sala}? O dispositivo vai apagar a rede e o endereço do servidor, preservar sua credencial exclusiva e reiniciar em modo de configuração (ponto de acesso).`,
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

  const ROLLOUT_ESTADO_ROTULOS = {
    preflight: "verificando compatibilidade",
    canario: "canário em atualização",
    lotes: "atualizando em lotes",
    pausado: "pausada",
    concluido: "concluída",
    interrompido: "interrompida",
    cancelado: "cancelada",
  };

  const ROLLOUT_DISPOSITIVO_ROTULOS = {
    pendente: "na fila",
    atualizando: "atualizando",
    reiniciando: "reiniciando para validar",
    validado: "validado",
    falhou: "falhou",
    revertido: "revertido",
    indeterminado: "sem confirmação",
    ignorado: "não atualizado",
    cancelado: "cancelado",
  };

  const ROLLOUT_CLASSES = {
    validado: "ok",
    falhou: "erro",
    revertido: "erro",
    indeterminado: "erro",
    atualizando: "andamento",
    reiniciando: "andamento",
  };

  function rolloutAtivo() {
    return !!rollout && ["preflight", "canario", "lotes", "pausado"].includes(rollout.estado);
  }

  function etapaRollout() {
    if (!rollout) return "";
    if (rollout.estado === "pausado") return "pausada";
    if (rollout.pausaSolicitada) return "pausando";
    if (rollout.loteAtual === 0) return "canário";
    const total = rollout.dispositivos.reduce((maior, d) => Math.max(maior, d.lote), 0);
    return `lote ${rollout.loteAtual} de ${total}`;
  }

  function resumoRollout() {
    const contagem = { validado: 0, falha: 0, naoAtualizado: 0, restante: 0 };
    rollout.dispositivos.forEach((d) => {
      if (d.estado === "validado") contagem.validado += 1;
      else if (["falhou", "revertido", "indeterminado"].includes(d.estado)) contagem.falha += 1;
      else if (["ignorado", "cancelado"].includes(d.estado)) contagem.naoAtualizado += 1;
      else contagem.restante += 1;
    });
    return `${contagem.validado} validado(s) · ${contagem.falha} com falha · ${contagem.naoAtualizado} não atualizado(s) · ${contagem.restante} restante(s)`;
  }

  function renderLinhasRollout() {
    return rollout.dispositivos
      .map((d) => {
        const etapa = d.lote === 0 ? "canário" : `lote ${d.lote}`;
        const classe = ROLLOUT_CLASSES[d.estado] || "neutro";
        return `
          <li class="ota-rollout-item">
            <span class="ota-rollout-sala">${escapeHtml(d.nome)} <span class="room-sub">(${escapeHtml(d.sala)})</span></span>
            <span class="ota-rollout-etapa">${etapa}</span>
            <span class="ota-rollout-estado ${classe}">${escapeHtml(ROLLOUT_DISPOSITIVO_ROTULOS[d.estado] || d.estado)}</span>
            ${d.motivo ? `<span class="ota-rollout-motivo">${escapeHtml(d.motivo)}</span>` : ""}
          </li>
        `;
      })
      .join("");
  }

  function renderRolloutAtivo() {
    const pausada = rollout.estado === "pausado" || rollout.pausaSolicitada;
    const rotulo = rollout.estado !== "pausado" && rollout.pausaSolicitada
      ? "pausando ao terminar o que já começou"
      : ROLLOUT_ESTADO_ROTULOS[rollout.estado] || rollout.estado;
    return `
      <div class="ota-rollout-cabecalho">
        <h3>Distribuição do firmware ${escapeHtml(rollout.versao)}</h3>
        <span class="esp32-conn-badge ${pausada ? "modo" : "on"}">${escapeHtml(rotulo)}</span>
      </div>
      <p class="ota-rollout-status" aria-live="polite">Etapa: ${escapeHtml(etapaRollout())} · ${escapeHtml(resumoRollout())}</p>
      <ul class="ota-rollout-lista">${renderLinhasRollout()}</ul>
      <div class="esp32-actions">
        ${pausada
          ? `<button type="button" class="btn btn-on rollout-retomar-btn">Retomar</button>`
          : `<button type="button" class="btn btn-off rollout-pausar-btn">Pausar</button>`}
        <button type="button" class="link-btn danger rollout-cancelar-btn">Cancelar o que não começou</button>
      </div>
    `;
  }

  function renderRolloutEncerrado() {
    if (!rollout) return "";
    const erro = rollout.estado !== "concluido";
    return `
      <div class="ota-rollout-encerrada ${erro ? "erro" : "ok"}">
        <strong>Última distribuição (${escapeHtml(rollout.versao)}): ${escapeHtml(ROLLOUT_ESTADO_ROTULOS[rollout.estado] || rollout.estado)}</strong>
        ${rollout.motivoParada ? `<div class="ota-rollout-motivo">${escapeHtml(rollout.motivoParada)}</div>` : ""}
        <div class="hint">${escapeHtml(resumoRollout())}</div>
        <ul class="ota-rollout-lista">${renderLinhasRollout()}</ul>
      </div>
    `;
  }

  function renderSelecaoRollout() {
    if (!manifestoFirmware) {
      return `<p class="hint">Publique um firmware no servidor para distribuir uma atualização em etapas.</p>`;
    }
    if (!elegiveisRollout.length) {
      return `<p class="hint">Nenhum ESP32 com MAC cadastrado para distribuir.</p>`;
    }
    const opcoes = elegiveisRollout
      .map((e) => {
        const marcado = selecaoRollout.has(e.sala);
        const detalhe = e.elegivel
          ? `firmware ${escapeHtml(e.versaoDispositivo || "desconhecido")}`
          : `${escapeHtml(e.versaoDispositivo || "desconhecido")} — ${escapeHtml(e.motivo)}`;
        return `
          <li class="ota-rollout-opcao ${e.elegivel ? "" : "inapto"}">
            <label>
              <input type="checkbox" value="${escapeHtml(e.sala)}" ${marcado ? "checked" : ""} ${e.elegivel ? "" : "disabled"}>
              <span class="ota-rollout-sala">${escapeHtml(e.nome)} <span class="room-sub">(${escapeHtml(e.sala)})</span></span>
              <span class="ota-rollout-motivo">${detalhe}</span>
            </label>
          </li>
        `;
      })
      .join("");
    const canarios = [...selecaoRollout]
      .map((sala) => `<option value="${escapeHtml(sala)}"${sala === canarioRollout ? " selected" : ""}>${escapeHtml(sala)}</option>`)
      .join("");
    const lotes = [];
    for (let n = limitesRollout.loteMin; n <= limitesRollout.loteMax; n += 1) {
      lotes.push(`<option value="${n}"${n === tamanhoLoteRollout ? " selected" : ""}>${n}</option>`);
    }
    return `
      <ul class="ota-rollout-opcoes">${opcoes}</ul>
      <div class="ota-rollout-form">
        <label>Canário
          <select class="rollout-canario-sel" ${selecaoRollout.size ? "" : "disabled"}>${canarios || "<option>—</option>"}</select>
        </label>
        <label>Dispositivos por lote
          <select class="rollout-lote-sel">${lotes.join("")}</select>
        </label>
        <button type="button" class="btn btn-on rollout-iniciar-btn" ${selecaoRollout.size ? "" : "disabled"}>Iniciar distribuição</button>
      </div>
    `;
  }

  function renderRollout() {
    if (!rolloutPainel) return;
    const assinatura = JSON.stringify([rollout, elegiveisRollout, [...selecaoRollout], canarioRollout, tamanhoLoteRollout, manifestoFirmware && manifestoFirmware.versao]);
    if (assinatura === assinaturaRollout) return;
    assinaturaRollout = assinatura;
    const ativo = rolloutAtivo();
    rolloutPainel.innerHTML = `
      <div class="ota-rollout-topo">
        <h3>Distribuição em etapas</h3>
        <p class="hint">Atualiza vários ESP32 em ondas: um canário primeiro e, só depois de ele voltar validado, lotes limitados pelo mesmo teto de ${limitesRollout.maxSimultaneos} atualizações simultâneas. Uma falha no canário ou em um lote para a distribuição.</p>
      </div>
      ${ativo ? renderRolloutAtivo() : `${renderRolloutEncerrado()}${renderSelecaoRollout()}`}
    `;

    rolloutPainel.querySelectorAll(".ota-rollout-opcao input").forEach((entrada) => {
      entrada.addEventListener("change", () => {
        if (entrada.checked) selecaoRollout.add(entrada.value);
        else selecaoRollout.delete(entrada.value);
        if (!selecaoRollout.has(canarioRollout)) canarioRollout = [...selecaoRollout][0] || null;
        renderRollout();
      });
    });

    const canarioSel = rolloutPainel.querySelector(".rollout-canario-sel");
    if (canarioSel) canarioSel.addEventListener("change", () => { canarioRollout = canarioSel.value; });

    const loteSel = rolloutPainel.querySelector(".rollout-lote-sel");
    if (loteSel) loteSel.addEventListener("change", () => { tamanhoLoteRollout = Number(loteSel.value); });

    const iniciarBtn = rolloutPainel.querySelector(".rollout-iniciar-btn");
    if (iniciarBtn) iniciarBtn.addEventListener("click", iniciarRollout);

    const pausarBtn = rolloutPainel.querySelector(".rollout-pausar-btn");
    if (pausarBtn) pausarBtn.addEventListener("click", () => comandarRollout("pausar", "não foi possível pausar"));

    const retomarBtn = rolloutPainel.querySelector(".rollout-retomar-btn");
    if (retomarBtn) retomarBtn.addEventListener("click", () => comandarRollout("retomar", "não foi possível retomar"));

    const cancelarBtn = rolloutPainel.querySelector(".rollout-cancelar-btn");
    if (cancelarBtn) cancelarBtn.addEventListener("click", async () => {
      const ok = await Dialog.confirmar({
        titulo: "Cancelar distribuição",
        mensagem: "Cancelar os dispositivos que ainda não começaram? Quem já está gravando o firmware continua até terminar, porque interromper uma gravação é o que mais arrisca o equipamento.",
        confirmarTexto: "Cancelar pendentes",
        perigo: true,
      });
      if (!ok) return;
      comandarRollout("cancelar", "não foi possível cancelar");
    });
  }

  async function comandarRollout(acao, erroPadrao) {
    const resp = await Api.comandarRolloutEsp32(acao);
    if (!resp.ok) return Toast.erro(resp.erro || erroPadrao);
    rollout = resp.rollout;
    renderRollout();
  }

  async function iniciarRollout() {
    const salas = elegiveisRollout.filter((e) => selecaoRollout.has(e.sala)).map((e) => e.sala);
    if (!salas.length) return;
    const ok = await Dialog.confirmar({
      titulo: "Iniciar distribuição em etapas",
      mensagem: `Distribuir o firmware ${manifestoFirmware.versao} para ${salas.length} dispositivo(s)? O canário ${canarioRollout || salas[0]} é atualizado sozinho e os lotes só começam depois que ele reconectar com a versão nova.`,
      confirmarTexto: "Iniciar distribuição",
    });
    if (!ok) return;
    const resp = await Api.iniciarRolloutEsp32({ salas, canario: canarioRollout || salas[0], tamanhoLote: tamanhoLoteRollout });
    if (!resp.ok) return Toast.erro(resp.erro || "não foi possível iniciar a distribuição");
    rollout = resp.rollout;
    selecaoRollout.clear();
    canarioRollout = null;
    renderRollout();
  }

  async function carregarRollout() {
    const resp = await Api.rolloutEsp32();
    if (!resp || !resp.ok) return;
    rollout = resp.rollout;
    elegiveisRollout = Array.isArray(resp.elegiveis) ? resp.elegiveis : [];
    limitesRollout = resp.limites || limitesRollout;
    if (!rolloutAtivo()) {
      const aptas = new Set(elegiveisRollout.filter((e) => e.elegivel).map((e) => e.sala));
      [...selecaoRollout].forEach((sala) => {
        if (!aptas.has(sala)) selecaoRollout.delete(sala);
      });
      if (!selecaoRollout.has(canarioRollout)) canarioRollout = [...selecaoRollout][0] || null;
    }
    if (tamanhoLoteRollout === null) tamanhoLoteRollout = limitesRollout.lotePadrao;
  }

  function aplicarRolloutWs(proximo) {
    const encerrou = rolloutAtivo() && proximo && !["preflight", "canario", "lotes", "pausado"].includes(proximo.estado);
    rollout = proximo;
    renderRollout();
    render();
    if (encerrou) {
      Toast.aviso(`distribuição ${ROLLOUT_ESTADO_ROTULOS[proximo.estado] || proximo.estado}`);
      carregarRollout().then(renderRollout);
    }
  }

  function salaNoRolloutAtivo(sala) {
    if (!rolloutAtivo()) return false;
    const item = rollout.dispositivos.find((d) => d.sala === sala);
    return !!item && ["pendente", "atualizando", "reiniciando"].includes(item.estado);
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

  function aplicarOtaDispositivo(sala, ota) {
    const item = dispositivos.find((d) => d.sala === sala);
    if (!item) return;
    if (!item.dispositivo) item.dispositivo = {};
    item.dispositivo.ota = ota;
    if (ota && ota.fase === "concluido") Toast.aviso(`sala ${sala}: firmware atualizado`);
    if (ota && ota.fase === "falhou") Toast.erro(`sala ${sala}: ${ota.erro || "falha na atualização"}`);
    render();
  }

  function aoMensagemWs(msg) {
    if (msg.tipo === "dispositivo_status") {
      aplicarEstadoDispositivo(msg.sala, msg.estado);
    } else if (msg.tipo === "dispositivo_captura") {
      aplicarCapturaDispositivo(msg.sala, msg.captura);
    } else if (msg.tipo === "dispositivo_ota") {
      aplicarOtaDispositivo(msg.sala, msg.ota);
    } else if (msg.tipo === "dispositivo_rollout") {
      aplicarRolloutWs(msg.rollout);
    } else if (msg.tipo === "dispositivo_erro") {
      Toast.erro(msg.mensagem || "erro reportado pelo dispositivo");
    }
  }

  function observarTodasAsSalas() {
    const salas = dispositivos.filter((d) => d.mac).map((d) => d.sala);
    ServerStatus.enviar({ tipo: "observar_dispositivos", salas });
  }

  async function carregarFirmware() {
    try {
      const resp = await Api.firmwareEsp32();
      manifestoFirmware = resp && resp.ok ? resp.manifesto : null;
    } catch (e) {
      manifestoFirmware = null;
    }
  }

  async function carregar() {
    if (carregando) return;
    carregando = true;
    try {
      await carregarFirmware();
      await carregarRollout();
      dispositivos = await Api.listarDispositivosEsp32();
      if (!Array.isArray(dispositivos)) dispositivos = [];
      renderRollout();
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

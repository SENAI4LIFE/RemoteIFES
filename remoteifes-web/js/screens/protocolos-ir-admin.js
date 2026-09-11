const ProtocolosIrAdmin = (() => {
  const clonadorSelect = document.getElementById("protocolosIrClonadorSelect");
  const destinoSelect = document.getElementById("protocolosIrDestinoSelect");
  const statusEl = document.getElementById("protocolosIrClonadorStatus");
  const avisoClonadorEl = document.getElementById("protocolosIrClonadorAviso");
  const toggleCloneBtn = document.getElementById("protocolosIrToggleCloneBtn");
  const capturaEl = document.getElementById("protocolosIrCapturaAtual");
  const testarCapturaBtn = document.getElementById("protocolosIrTestarCapturaBtn");
  const descartarCapturaBtn = document.getElementById("protocolosIrDescartarCapturaBtn");
  const labelInput = document.getElementById("protocolosIrLabelInput");
  const salvarCapturaBtn = document.getElementById("protocolosIrSalvarCapturaBtn");
  const listEl = document.getElementById("protocolosIrList");
  const emptyEl = document.getElementById("protocolosIrEmpty");
  const failsafeAviso = document.getElementById("protocolosIrFailsafeAviso");
  const failsafeCancelarBtn = document.getElementById("protocolosIrFailsafeCancelarBtn");

  const MOTIVOS_VINCULO = {
    "mac-alterado": "o MAC cadastrado para esta sala mudou desde que a clonadora foi definida",
    "credencial-alterada": "a credencial do ESP32 desta sala foi substituída ou revogada desde que a clonadora foi definida",
    "sala-inexistente": "a sala definida como clonadora não existe mais",
  };

  let dispositivos = [];
  let clonador = null;
  let protocolos = [];
  let ultimaCaptura = null;
  const capturasConsumidas = new Set();
  let failsafePendenteId = null;
  let pararMensagens = null;
  let pararConexao = null;
  let ocupado = false;

  function escape(v) {
    return escapeHtml(v == null ? "" : String(v));
  }

  function dispositivoDaSala(sala) {
    return dispositivos.find((d) => d.sala === sala) || null;
  }

  function estadoClonador() {
    const local = dispositivoDaSala(clonador?.sala)?.dispositivo;
    return local || clonador?.dispositivo || {};
  }

  function protocoloPorId(id) {
    return protocolos.find((p) => Number(p.id) === Number(id)) || null;
  }

  function cloneAtivo() {
    return estadoClonador().modo === "config_clone";
  }

  function nomeSala(sala) {
    const d = dispositivoDaSala(sala);
    return d ? `${sala} · ${d.nome}` : sala;
  }

  function preencherSelects() {
    const clonadorAtual = clonadorSelect.value || clonador?.sala || "";
    const destinoAtual = destinoSelect.value || "";
    const opcoes = dispositivos.map((d) => {
      const papel = d.dispositivo?.role === "cloner" ? "clonador" : "transmissor";
      const online = d.dispositivo?.conectado ? "conectado" : "desconectado";
      return `<option value="${escape(d.sala)}">${escape(d.sala)} · ${escape(d.nome)} · ${papel} · ${online}</option>`;
    }).join("");
    clonadorSelect.innerHTML = `<option value="">Nenhum</option>${opcoes}`;
    destinoSelect.innerHTML = `<option value="">Selecione uma ESP32</option>${opcoes}`;
    clonadorSelect.value = dispositivos.some((d) => d.sala === clonadorAtual) ? clonadorAtual : "";
    destinoSelect.value = dispositivos.some((d) => d.sala === destinoAtual) ? destinoAtual : "";
  }

  function atualizarStatusClonador() {
    avisoClonadorEl.classList.add("hidden");
    toggleCloneBtn.classList.remove("btn-off");
    toggleCloneBtn.classList.add("btn-on");
    if (!clonador?.sala) {
      statusEl.textContent = "Nenhum clonador definido. Escolha a ESP32 equipada com receptor IR e salve.";
      toggleCloneBtn.textContent = "Entrar no modo clone";
      toggleCloneBtn.disabled = true;
      return;
    }
    const estado = estadoClonador();
    const partes = [`${nomeSala(clonador.sala)}: ${estado.conectado ? "conectado" : "desconectado"}`];
    if (clonador.mac) partes.push(`MAC ${clonador.mac}`);
    if (clonador.deviceId) partes.push(`credencial ${clonador.deviceId}`);
    partes.push(cloneAtivo() ? "modo clone ativo (capturando)" : "operação normal");
    statusEl.textContent = partes.join(" · ");

    let aviso = null;
    if (!clonador.vinculoValido) aviso = MOTIVOS_VINCULO[clonador.motivo] || "o vínculo da clonadora precisa ser confirmado";
    else if (estado.conectado && estado.role !== "cloner") aviso = "o ESP32 conectado nesta sala não é a placa autorizada como clonadora";
    if (aviso) {
      avisoClonadorEl.querySelector("span").textContent = `${aviso}. Confirme a clonadora novamente em “Salvar clonador”.`;
      avisoClonadorEl.classList.remove("hidden");
    }

    const ativo = cloneAtivo();
    toggleCloneBtn.textContent = ativo ? "Sair do modo clone" : "Entrar no modo clone";
    toggleCloneBtn.classList.toggle("btn-on", !ativo);
    toggleCloneBtn.classList.toggle("btn-off", ativo);
    toggleCloneBtn.disabled = ocupado || !estado.conectado || !clonador.vinculoValido || estado.role !== "cloner";
  }

  function descreverCaptura(c) {
    const tipo = c.isKnown ? `protocolo reconhecido ${c.protocol || ""}` : `sinal RAW genérico${c.protocol && c.protocol !== "UNKNOWN" ? ` (${c.protocol})` : ""}`;
    return `${tipo} · ${c.hex || "sem código"} · ${(c.raw || []).length} pulsos · ${Math.round((c.carrierHz || 38000) / 1000)} kHz`;
  }

  function atualizarCaptura() {
    const tem = !!ultimaCaptura;
    capturaEl.textContent = tem
      ? `${descreverCaptura(ultimaCaptura)} · recebida de ${ultimaCaptura.sala || clonador?.sala || "?"}`
      : "Nenhuma captura recebida. Entre no modo clone e aponte o controle remoto para o receptor da clonadora.";
    testarCapturaBtn.disabled = !tem;
    descartarCapturaBtn.disabled = !tem;
    salvarCapturaBtn.disabled = !tem || ocupado;
  }

  function atualizarAvisoFailsafe() {
    const protocolo = protocoloPorId(failsafePendenteId);
    failsafeAviso.classList.toggle("hidden", !protocolo);
    failsafeCancelarBtn.classList.toggle("hidden", !protocolo);
    failsafeAviso.textContent = protocolo
      ? `Aguardando o comando de DESLIGAR para “${protocolo.label}”: aponte o controle original para o receptor e pressione somente o botão que desliga o ar-condicionado. A próxima captura será gravada como failsafe OFF desse protocolo, não como um novo protocolo.`
      : "";
  }

  function substituirProtocolo(atualizado) {
    protocolos = protocolos.map((p) => (Number(p.id) === Number(atualizado.id) ? atualizado : p));
    renderProtocolos();
    atualizarAvisoFailsafe();
  }

  async function iniciarCapturaFailsafe(p) {
    if (!clonador?.sala) return Toast.erro("defina primeiro o clonador oficial");
    if (!cloneAtivo()) return Toast.erro("entre primeiro no modo clone com a clonadora conectada");
    const continuar = await Dialog.confirmar({
      titulo: p.failsafe ? "Recapturar failsafe OFF" : "Configurar failsafe OFF",
      mensagem: `O próximo sinal recebido pela clonadora será gravado como comando de emergência para desligar o ar-condicionado do protocolo “${p.label}”. Aponte o controle original para o receptor e pressione apenas DESLIGAR.`,
      confirmarTexto: "Aguardar sinal de desligar",
    });
    if (!continuar) return;
    failsafePendenteId = p.id;
    atualizarAvisoFailsafe();
  }

  async function salvarCapturaComoFailsafe(captura) {
    const p = protocoloPorId(failsafePendenteId);
    failsafePendenteId = null;
    atualizarAvisoFailsafe();
    if (!p) return;
    const r = await Api.definirFailsafeProtocoloIr(p.id, captura.id);
    if (!r.ok) return Toast.erro(r.erro || "não foi possível salvar o failsafe OFF");
    capturasConsumidas.add(captura.id);
    substituirProtocolo(r.protocolo);
    Toast.aviso(`failsafe OFF salvo em “${r.protocolo.label}”${r.sincronizados ? ` e sincronizado com ${r.sincronizados} ESP32` : ""}`);
  }

  function formatarData(valor) {
    return Tempo.formatarDataHora(valor);
  }

  function renderProtocolo(p) {
    const li = document.createElement("li");
    li.className = "protocolos-ir-item";
    li.dataset.id = p.id;
    const aplicavel = p.isKnown && Number.isInteger(p.protocolId);
    const failsafeTexto = p.failsafe
      ? `failsafe OFF configurado · ${p.failsafe.raw.length} pulsos · ${Math.round(p.failsafe.carrierHz / 1000)} kHz`
      : "failsafe OFF não configurado (opcional)";
    const salasTexto = p.salas && p.salas.length ? `aplicado em ${p.salas.join(", ")}` : "não aplicado a nenhuma sala";
    li.innerHTML = `
      <div class="protocolos-ir-cabecalho">
        <div class="protocolos-ir-titulo"><strong class="protocolos-ir-label"></strong> <span class="esp32-conn-badge ${aplicavel ? "on" : "modo"}">${aplicavel ? `reconhecido · ${escape(p.protocol || "")}` : "RAW genérico"}</span></div>
        <div class="esp32-capture-hex">${escape(p.hex || "sem código")} · ${(p.raw || []).length} pulsos · ${Math.round((p.carrierHz || 38000) / 1000)} kHz</div>
      </div>
      <div class="room-sub">capturado por ${escape(p.origemSala || "?")}${p.origemMac ? ` (${escape(p.origemMac)})` : ""} em ${escape(formatarData(p.criadoEm))} · ${escape(salasTexto)}</div>
      <div class="room-sub protocolos-ir-failsafe ${p.failsafe ? "ok" : ""}">${escape(failsafeTexto)}</div>
      <div class="esp32-capture-actions">
        <button type="button" class="link-btn transmitir-btn">transmitir na ESP32 de destino</button>
        ${aplicavel ? `<button type="button" class="link-btn aplicar-btn">aplicar como protocolo da sala de destino</button>` : ""}
        ${aplicavel ? `<button type="button" class="link-btn failsafe-btn">${p.failsafe ? "recapturar failsafe OFF" : "configurar failsafe OFF"}</button>` : ""}
        ${p.failsafe ? `<button type="button" class="link-btn danger remover-failsafe-btn">remover failsafe OFF</button>` : ""}
        <button type="button" class="link-btn renomear-btn">renomear</button>
        <button type="button" class="link-btn danger excluir-btn">excluir</button>
      </div>
    `;
    li.querySelector(".protocolos-ir-label").textContent = p.label;

    li.querySelector(".transmitir-btn").addEventListener("click", async () => {
      const sala = destinoSelect.value;
      if (!sala) return Toast.erro("selecione uma ESP32 de destino");
      const r = await Api.transmitirProtocoloIr(p.id, sala);
      if (!r.ok) Toast.erro(r.erro || "não foi possível transmitir o protocolo");
      else Toast.aviso(`“${p.label}” transmitido por ${sala}`);
    });

    const aplicarBtn = li.querySelector(".aplicar-btn");
    if (aplicarBtn) aplicarBtn.addEventListener("click", async () => {
      const sala = destinoSelect.value;
      if (!sala) return Toast.erro("selecione a sala de destino");
      const ok = await Dialog.confirmar({
        titulo: "Aplicar protocolo à sala",
        mensagem: `Definir “${p.label}” (${p.protocol}) como protocolo operacional de ${nomeSala(sala)}? ${p.failsafe ? "O failsafe OFF deste protocolo será gravado na memória persistente do ESP32 da sala." : "Este protocolo não tem failsafe OFF: um failsafe antigo gravado nesse ESP32 será apagado."}`,
        confirmarTexto: "Aplicar",
      });
      if (!ok) return;
      const r = await Api.aplicarProtocoloIr(p.id, sala);
      if (!r.ok) return Toast.erro(r.erro || "não foi possível aplicar o protocolo");
      Toast.aviso(p.failsafe
        ? `protocolo e failsafe OFF aplicados em ${sala}${r.failsafeSincronizado ? "" : " (sincronizado quando o ESP32 reconectar)"}`
        : `protocolo aplicado em ${sala} sem failsafe OFF`);
      await carregar();
    });

    const failsafeBtn = li.querySelector(".failsafe-btn");
    if (failsafeBtn) failsafeBtn.addEventListener("click", () => iniciarCapturaFailsafe(p));

    const removerFailsafeBtn = li.querySelector(".remover-failsafe-btn");
    if (removerFailsafeBtn) removerFailsafeBtn.addEventListener("click", async () => {
      const ok = await Dialog.confirmar({
        titulo: "Remover failsafe OFF",
        mensagem: `Remover o comando de desligar de emergência de “${p.label}”? Os ESP32 das salas que usam este protocolo receberão a ordem de apagar o failsafe gravado.`,
        confirmarTexto: "Remover failsafe",
        perigo: true,
      });
      if (!ok) return;
      const r = await Api.removerFailsafeProtocoloIr(p.id);
      if (!r.ok) return Toast.erro(r.erro || "não foi possível remover o failsafe OFF");
      substituirProtocolo(r.protocolo);
      Toast.aviso("failsafe OFF removido");
    });

    li.querySelector(".renomear-btn").addEventListener("click", () => {
      Dialog.texto({
        titulo: "Renomear protocolo",
        descricao: "O nome precisa ser único na biblioteca (sem diferenciar maiúsculas de minúsculas).",
        label: "Nome (label)",
        valorInicial: p.label,
        minLength: 2,
        maxLength: 80,
        aoConfirmar: async (valor) => {
          const r = await Api.renomearProtocoloIr(p.id, valor);
          if (!r || !r.ok) return { ok: false, erro: (r && r.erro) || "não foi possível renomear" };
          substituirProtocolo(r.protocolo);
          return { ok: true };
        },
      }).then((valor) => {
        if (valor !== null) Toast.aviso("protocolo renomeado");
      });
    });

    li.querySelector(".excluir-btn").addEventListener("click", async () => {
      const ok = await Dialog.confirmar({
        titulo: "Excluir protocolo IR",
        mensagem: `Excluir permanentemente “${p.label}” da biblioteca? Salas que o usam mantêm o protocolo operacional, mas o failsafe OFF vinculado é apagado dos ESP32.`,
        confirmarTexto: "Excluir",
        perigo: true,
      });
      if (!ok) return;
      const r = await Api.excluirProtocoloIr(p.id);
      if (!r.ok) return Toast.erro(r.erro || "não foi possível excluir o protocolo");
      if (Number(failsafePendenteId) === Number(p.id)) failsafePendenteId = null;
      Toast.aviso("protocolo excluído");
      await carregar();
    });

    return li;
  }

  function renderProtocolos() {
    listEl.innerHTML = "";
    emptyEl.classList.toggle("hidden", protocolos.length > 0);
    protocolos.forEach((p) => listEl.appendChild(renderProtocolo(p)));
  }

  function observarClonador() {
    ServerStatus.enviar({ tipo: "observar_dispositivos", salas: clonador?.sala ? [clonador.sala] : [] });
  }

  function aoMensagem(msg) {
    if (!msg || !clonador?.sala || msg.sala !== clonador.sala) return;
    if (msg.tipo === "dispositivo_status") {
      const d = dispositivoDaSala(msg.sala);
      if (d) d.dispositivo = msg.estado;
      if (clonador.dispositivo) clonador.dispositivo = msg.estado;
      preencherSelects();
      atualizarStatusClonador();
    } else if (msg.tipo === "dispositivo_captura" && msg.captura) {
      if (failsafePendenteId) {
        salvarCapturaComoFailsafe(msg.captura);
        return;
      }
      ultimaCaptura = msg.captura;
      atualizarCaptura();
      Toast.aviso("nova captura IR recebida: informe um nome para salvá-la");
    } else if (msg.tipo === "dispositivo_erro") {
      Toast.erro(msg.mensagem || "erro reportado pelo dispositivo");
    }
  }

  async function carregar() {
    const [estado, lista] = await Promise.all([Api.listarProtocolosIr(), Api.listarDispositivosEsp32()]);
    if (!estado || !estado.ok) {
      Toast.erro((estado && estado.erro) || "não foi possível carregar os protocolos IR");
      return;
    }
    dispositivos = Array.isArray(lista) ? lista : [];
    clonador = estado.clonador && estado.clonador.sala ? estado.clonador : null;
    protocolos = Array.isArray(estado.protocolos) ? estado.protocolos : [];
    const recentes = Array.isArray(estado.capturas) ? estado.capturas : [];
    if (ultimaCaptura && !recentes.some((c) => c.id === ultimaCaptura.id)) ultimaCaptura = null;
    if (!ultimaCaptura && !failsafePendenteId) ultimaCaptura = recentes.find((c) => !capturasConsumidas.has(c.id)) || null;
    if (failsafePendenteId && !protocoloPorId(failsafePendenteId)) failsafePendenteId = null;
    preencherSelects();
    atualizarStatusClonador();
    atualizarCaptura();
    renderProtocolos();
    atualizarAvisoFailsafe();
    observarClonador();
  }

  document.getElementById("protocolosIrSalvarClonadorBtn").addEventListener("click", async () => {
    const sala = clonadorSelect.value || null;
    const ok = await Dialog.confirmar({
      titulo: sala ? "Definir clonador oficial" : "Remover clonador oficial",
      mensagem: sala
        ? `Definir ${nomeSala(sala)} como a única ESP32 autorizada a capturar sinais IR? O papel fica vinculado ao MAC e à credencial atuais dessa placa; as demais continuam como transmissoras.`
        : "Remover o clonador oficial? Nenhuma ESP32 poderá capturar sinais até que outra seja definida.",
      confirmarTexto: sala ? "Definir clonador" : "Remover",
      perigo: !sala,
    });
    if (!ok) return;
    const r = await Api.definirClonadorIr(sala);
    if (!r.ok) return Toast.erro(r.erro || "não foi possível definir o clonador");
    ultimaCaptura = null;
    capturasConsumidas.clear();
    failsafePendenteId = null;
    Toast.aviso(sala ? `clonador definido: ${sala}` : "clonador removido");
    await carregar();
  });

  toggleCloneBtn.addEventListener("click", async () => {
    if (!clonador?.sala) return Toast.erro("defina primeiro o clonador oficial");
    const ativar = !cloneAtivo();
    if (!ativar) {
      failsafePendenteId = null;
      atualizarAvisoFailsafe();
    }
    ocupado = true;
    toggleCloneBtn.disabled = true;
    try {
      const r = await Api.definirModoCloneIr(ativar);
      if (!r.ok) return Toast.erro(r.erro || "não foi possível alterar o modo da clonadora");
      Toast.aviso(ativar ? "modo clone ativado: o receptor IR está capturando" : "modo clone encerrado");
    } finally {
      ocupado = false;
      atualizarStatusClonador();
      atualizarCaptura();
    }
  });

  failsafeCancelarBtn.addEventListener("click", () => {
    failsafePendenteId = null;
    atualizarAvisoFailsafe();
    Toast.aviso("captura de failsafe cancelada");
  });

  testarCapturaBtn.addEventListener("click", async () => {
    if (!ultimaCaptura) return;
    const sala = destinoSelect.value;
    if (!sala) return Toast.erro("selecione uma ESP32 de destino");
    const r = await Api.testarRawEsp32(sala, ultimaCaptura.raw, ultimaCaptura.carrierHz || 38000);
    if (!r.ok) Toast.erro(r.erro || "não foi possível testar o sinal");
    else Toast.aviso(`sinal reenviado por ${sala}`);
  });

  descartarCapturaBtn.addEventListener("click", () => {
    if (ultimaCaptura) capturasConsumidas.add(ultimaCaptura.id);
    ultimaCaptura = null;
    atualizarCaptura();
  });

  salvarCapturaBtn.addEventListener("click", async () => {
    if (!ultimaCaptura) return Toast.erro("nenhuma captura disponível para salvar");
    const label = labelInput.value.trim();
    if (label.length < 2) {
      Toast.erro("informe um nome com ao menos 2 caracteres");
      labelInput.focus();
      return;
    }
    ocupado = true;
    salvarCapturaBtn.disabled = true;
    try {
      const r = await Api.salvarProtocoloIr(label, ultimaCaptura.id);
      if (!r.ok) return Toast.erro(r.erro || "não foi possível salvar a captura");
      labelInput.value = "";
      capturasConsumidas.add(ultimaCaptura.id);
      ultimaCaptura = null;
      Toast.aviso(`protocolo “${r.protocolo.label}” salvo na biblioteca`);
      await carregar();
    } finally {
      ocupado = false;
      atualizarCaptura();
    }
  });

  labelInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !salvarCapturaBtn.disabled) {
      event.preventDefault();
      salvarCapturaBtn.click();
    }
  });

  async function aoAbrir() {
    if (!state.isSuperAdmin) return;
    if (!pararMensagens) pararMensagens = ServerStatus.aoMensagem(aoMensagem);
    if (!pararConexao) pararConexao = ServerStatus.aoConectar(observarClonador);
    await carregar();
  }

  function aoFechar() {
    if (!pararMensagens && !pararConexao) return;
    ServerStatus.enviar({ tipo: "observar_dispositivos", salas: [] });
    failsafePendenteId = null;
    atualizarAvisoFailsafe();
    if (pararMensagens) { pararMensagens(); pararMensagens = null; }
    if (pararConexao) { pararConexao(); pararConexao = null; }
  }

  return { aoAbrir, aoFechar };
})();

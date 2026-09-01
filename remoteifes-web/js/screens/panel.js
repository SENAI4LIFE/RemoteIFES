let _panelPararStatus = null;

const _panelAplicarAvisoOfflineToast = Toast.criarAvisoDeEstado(
  "panelAvisoOffline",
  "O dispositivo está offline: o estado foi salvo e será aplicado quando o ESP32 reconectar."
);

async function openRoom(sala, nome) {
  state.salaAtual = sala;
  document.getElementById("panelRoomName").textContent = `${RoomsData.rotulo(sala)}: ${nome}`;
  showScreen("panel");
  if (typeof Router !== "undefined") Router.sync();
  await refreshStatus();
  iniciarAutoRefreshPanel();
}

function iniciarAutoRefreshPanel() {
  pararAutoRefreshPanel();
  _panelPararStatus = RTStatus.aoStatusSala((status) => aplicarStatusNoPainel(status));
  RTStatus.observarSala(state.salaAtual);
}

function pararAutoRefreshPanel() {
  if (_panelPararStatus) {
    _panelPararStatus();
    _panelPararStatus = null;
  }
  RTStatus.pararObservarSala();
}

function aplicarBloqueio(dados) {
  const banner = document.getElementById("lockBanner");
  const bloqueado = dados.travadaParaMim || dados.podeControlarEsta === false;

  document.getElementById("btnPower").disabled = bloqueado;
  document.getElementById("tempDown").disabled = bloqueado || dados.temperaturaAlvo <= dados.temperaturaMinima;
  document.getElementById("tempUp").disabled = bloqueado || dados.temperaturaAlvo >= dados.temperaturaMaxima;
  document.getElementById("btnTurbo").disabled = bloqueado || !dados.ligado;

  const avisoSomenteLeitura = document.getElementById("panelSomenteLeitura");
  avisoSomenteLeitura.classList.toggle("hidden", dados.podeControlarEsta !== false);

  if (dados.bloqueio && !dados.bloqueio.souEu) {
    banner.textContent = `Sala reservada por ${dados.bloqueio.usuarioNome} até ${dados.bloqueio.horaFim} (agendamento ativo)`;
    banner.classList.remove("hidden", "lock-banner-mine");
  } else if (dados.bloqueio) {
    banner.textContent = `Você tem um agendamento ativo nesta sala até ${dados.bloqueio.horaFim}`;
    banner.classList.remove("hidden");
    banner.classList.add("lock-banner-mine");
  } else {
    banner.classList.add("hidden");
    banner.classList.remove("lock-banner-mine");
  }
}

function aplicarStatusNoPainel(status) {
  const temperaturaAmbiente = Number(status.temperatura);
  document.getElementById("tempValue").textContent = Number.isFinite(temperaturaAmbiente)
    ? `${temperaturaAmbiente.toFixed(1)} °C`
    : "— °C";

  const conexao = document.getElementById("conexaoValue");
  conexao.textContent = status.online ? "online" : "offline";
  conexao.className = `status-badge ${status.online ? "on" : "off"}`;

  const badge = document.getElementById("statusValue");
  badge.textContent = status.ligado ? "ligado" : "desligado";
  badge.className = `status-badge ${status.ligado ? "on" : "off"}`;

  document.getElementById("modoValue").textContent = status.ligado ? "Cool" : "Off";
  document.getElementById("acRemoteBody").classList.toggle("ac-remote-body-off", !status.ligado);

  const power = document.getElementById("btnPower");
  power.classList.toggle("is-on", !!status.ligado);
  power.setAttribute("aria-pressed", String(!!status.ligado));

  const turbo = document.getElementById("btnTurbo");
  turbo.classList.toggle("is-on", !!status.turboAtivo);
  turbo.setAttribute("aria-pressed", String(!!status.turboAtivo));

  state.tempAlvo = status.temperaturaAlvo;
  state.tempMinima = status.temperaturaMinima;
  state.tempMaxima = status.temperaturaMaxima;
  document.getElementById("tempTarget").textContent = `${status.temperaturaAlvo}°C`;

  _panelAplicarAvisoOfflineToast(!status.online && status.ligado);
  aplicarBloqueio(status);
}

async function refreshStatus() {
  try {
    const status = await Api.statusSala(state.salaAtual);
    if (status.erro) throw new Error(status.erro);
    aplicarStatusNoPainel(status);
  } catch (erro) {
    Toast.erro("não foi possível falar com o servidor");
  }
}

async function enviarComandoPainel(botao, cmd, valor) {
  if (botao.disabled) return;
  botao.disabled = true;
  const resp = await Api.enviarComando(state.salaAtual, cmd, valor);
  if (!resp.ok) Toast.erro(resp.erro || "não foi possível enviar o comando");
  await refreshStatus();
}

document.getElementById("btnPower").addEventListener("click", (event) => {
  const ligado = event.currentTarget.classList.contains("is-on");
  enviarComandoPainel(event.currentTarget, ligado ? "desligar" : "ligar");
});

document.getElementById("btnTurbo").addEventListener("click", (event) => {
  const ativo = event.currentTarget.classList.contains("is-on");
  enviarComandoPainel(event.currentTarget, "turbo", !ativo);
});

document.getElementById("tempUp").addEventListener("click", (event) => {
  enviarComandoPainel(event.currentTarget, "temperatura", Math.min(state.tempMaxima, state.tempAlvo + 1));
});

document.getElementById("tempDown").addEventListener("click", (event) => {
  enviarComandoPainel(event.currentTarget, "temperatura", Math.max(state.tempMinima, state.tempAlvo - 1));
});

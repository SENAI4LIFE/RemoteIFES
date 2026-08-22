let _panelPararStatus = null;

const _panelAplicarAvisoOfflineToast = Toast.criarAvisoDeEstado(
  "panelAvisoOffline",
  "O dispositivo está offline: o comando foi salvo, mas ainda não há confirmação de que o ESP32 o recebeu."
);

async function openRoom(sala, nome) {
  state.salaAtual = sala;
  document.getElementById("panelRoomName").textContent = `${sala} — ${nome}`;
  showScreen("panel");
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
  const controlesDesabilitados = dados.travadaParaMim || dados.podeControlarEsta === false;

  ["btnOn", "btnOff", "tempUp", "tempDown"].forEach((id) => {
    document.getElementById(id).disabled = controlesDesabilitados;
  });

  const avisoSomenteLeitura = document.getElementById("panelSomenteLeitura");
  if (avisoSomenteLeitura) {
    avisoSomenteLeitura.classList.toggle("hidden", dados.podeControlarEsta !== false);
  }

  if (dados.bloqueio && !dados.bloqueio.souEu) {
    banner.textContent = `Sala reservada por ${dados.bloqueio.usuarioNome} até ${dados.bloqueio.horaFim} (agendamento ativo)`;
    banner.classList.remove("hidden");
  } else if (dados.bloqueio && dados.bloqueio.souEu) {
    banner.textContent = `Você tem um agendamento ativo nesta sala até ${dados.bloqueio.horaFim}`;
    banner.classList.remove("hidden");
    banner.classList.add("lock-banner-mine");
  } else {
    banner.classList.add("hidden");
    banner.classList.remove("lock-banner-mine");
  }
}

function aplicarAvisoOffline(offlineMasLigado) {
  _panelAplicarAvisoOfflineToast(offlineMasLigado);
}

function aplicarStatusNoPainel(status) {
  document.getElementById("tempValue").textContent = `${status.temperatura.toFixed(1)} °C`;

  const conexao = document.getElementById("conexaoValue");
  conexao.textContent = status.online ? "online" : "offline";
  conexao.className = `status-badge ${status.online ? "on" : "off"}`;

  const badge = document.getElementById("statusValue");
  badge.textContent = status.ligado ? "ligado" : "desligado";
  badge.className = `status-badge ${status.ligado ? "on" : "off"}`;

  aplicarAvisoOffline(!status.online && status.ligado);

  state.tempAlvo = status.temperaturaAlvo;
  state.tempMinima = status.temperaturaMinima;
  state.tempMaxima = status.temperaturaMaxima;
  document.getElementById("tempTarget").textContent = `${status.temperaturaAlvo}°C`;

  aplicarBloqueio(status);
}

async function refreshStatus() {
  try {
    const status = await Api.statusSala(state.salaAtual);
    if (status.erro) throw new Error(status.erro);
    aplicarStatusNoPainel(status);
  } catch (err) {
    Toast.erro("não foi possível falar com o servidor");
  }
}

document.getElementById("btnOn").addEventListener("click", async () => {
  const resp = await Api.enviarComando(state.salaAtual, "ligar");
  if (!resp.ok) {
    Toast.erro(resp.erro);
  }
  await refreshStatus();
});

document.getElementById("btnOff").addEventListener("click", async () => {
  const resp = await Api.enviarComando(state.salaAtual, "desligar");
  if (!resp.ok) {
    Toast.erro(resp.erro);
  }
  await refreshStatus();
});

document.getElementById("tempUp").addEventListener("click", async () => {
  const max = state.tempMaxima ?? 30;
  const novoAlvo = Math.min(max, state.tempAlvo + 1);
  const resp = await Api.enviarComando(state.salaAtual, "temperatura", novoAlvo);
  if (resp.ok) {
    state.tempAlvo = novoAlvo;
    document.getElementById("tempTarget").textContent = `${state.tempAlvo}°C`;
  }
});

document.getElementById("tempDown").addEventListener("click", async () => {
  const min = state.tempMinima ?? 16;
  const novoAlvo = Math.max(min, state.tempAlvo - 1);
  const resp = await Api.enviarComando(state.salaAtual, "temperatura", novoAlvo);
  if (resp.ok) {
    state.tempAlvo = novoAlvo;
    document.getElementById("tempTarget").textContent = `${state.tempAlvo}°C`;
  }
});

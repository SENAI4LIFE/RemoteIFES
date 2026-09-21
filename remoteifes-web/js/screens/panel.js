let _panelPararStatus = null;
let _panelGeracao = 0;
let _panelRevisao = 0;
let _panelConsulta = 0;

const _panelAplicarAvisoOfflineToast = Toast.criarAvisoDeEstado(
  "panelAvisoOffline",
  "O dispositivo está offline: o estado foi salvo e será aplicado quando o ESP32 reconectar."
);
// O servidor guarda o estado desejado; o ESP32 confirma quando o aplica (imediatamente no firmware
// atual, em até um ciclo de telemetria no anterior). Só avisamos se a confirmação demorar demais.
const _panelAplicarAvisoSemConfirmacaoToast = Toast.criarAvisoDeEstado(
  "panelAvisoSemConfirmacao",
  "O ESP32 ainda não confirmou o último comando: o estado foi salvo e continua valendo até a placa aplicá-lo."
);
// "online" é presença (a placa foi vista há pouco, mesmo só por heartbeat HTTP); comandos só são
// entregues pelo socket de comandos, que o servidor informa em canalComandos.
const PANEL_AVISO_SEM_CANAL = "O comando não foi entregue ao ESP32: a placa foi vista há pouco, mas está sem canal de comandos agora. O estado foi salvo e será aplicado quando ela reconectar.";
const PANEL_ESPERA_CONFIRMACAO_MS = 12000;
let _panelTimerConfirmacao = null;
let _panelUltimoStatus = null;

function acompanharConfirmacao(status) {
  _panelUltimoStatus = status;
  const badge = document.getElementById("statusValue");
  const pendente = !!status.online && status.dispositivoConfirmou === false;
  badge.dataset.confirmado = typeof status.dispositivoConfirmou === "boolean" ? String(status.dispositivoConfirmou) : "";
  badge.title = pendente ? "Estado salvo no servidor; aguardando o ESP32 confirmar" : "Estado do ar-condicionado";
  if (!pendente) {
    clearTimeout(_panelTimerConfirmacao);
    _panelTimerConfirmacao = null;
    _panelAplicarAvisoSemConfirmacaoToast(false);
    return;
  }
  if (_panelTimerConfirmacao) return;
  _panelTimerConfirmacao = setTimeout(() => {
    _panelTimerConfirmacao = null;
    const ultimo = _panelUltimoStatus;
    if (_panelPararStatus && ultimo && ultimo.online && ultimo.dispositivoConfirmou === false) _panelAplicarAvisoSemConfirmacaoToast(true);
  }, PANEL_ESPERA_CONFIRMACAO_MS);
}

async function openRoom(sala, nome) {
  state.salaAtual = sala;
  document.getElementById("panelRoomName").textContent = `${RoomsData.rotulo(sala)}: ${nome}`;
  showScreen("panel");
  if (typeof Router !== "undefined") Router.sync();
  iniciarAutoRefreshPanel();
  for (const id of ["btnPower", "tempDown", "tempUp", "btnTurbo"]) {
    document.getElementById(id).disabled = true;
  }
  await refreshStatus();
}

function iniciarAutoRefreshPanel() {
  pararAutoRefreshPanel();
  _panelPararStatus = RTStatus.aoStatusSala((status) => aplicarStatusNoPainel(status));
  RTStatus.observarSala(state.salaAtual);
}

function pararAutoRefreshPanel() {
  _panelGeracao += 1;
  if (_panelPararStatus) {
    _panelPararStatus();
    _panelPararStatus = null;
  }
  clearTimeout(_panelTimerConfirmacao);
  _panelTimerConfirmacao = null;
  _panelUltimoStatus = null;
  RTStatus.pararObservarSala();
}

function aplicarBloqueio(dados) {
  const banner = document.getElementById("lockBanner");
  const bloqueado = dados.travadaParaMim || dados.podeControlarEsta === false;

  document.getElementById("btnPower").disabled = bloqueado;
  document.getElementById("tempDown").disabled = bloqueado || dados.temperaturaAlvo <= dados.temperaturaMinima;
  document.getElementById("tempUp").disabled = bloqueado || dados.temperaturaAlvo >= dados.temperaturaMaxima;
  document.getElementById("btnTurbo").disabled = bloqueado || (!dados.ligado && dados.autoLigar === false);

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
  if (!_panelPararStatus || status.sala !== state.salaAtual) return;
  _panelRevisao += 1;
  const temperaturaAmbiente = Number(status.temperatura);
  document.getElementById("tempValue").textContent = Number.isFinite(temperaturaAmbiente)
    ? `${temperaturaAmbiente.toFixed(1)} °C`
    : "— °C";

  const conexao = document.getElementById("conexaoValue");
  const semCanal = !!status.online && status.canalComandos === false;
  conexao.textContent = !status.online ? "offline" : semCanal ? "online, sem comandos" : "online";
  conexao.className = `status-badge ${status.online && !semCanal ? "on" : "off"}`;
  conexao.parentElement.title = semCanal
    ? "O ESP32 foi visto há pouco, mas não tem canal de comandos agora: comandos ficam salvos até ele reconectar"
    : "Conexão do dispositivo";

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
  acompanharConfirmacao(status);
  aplicarBloqueio(status);
}

// Devolve true quando o painel foi atualizado com o estado autoritativo do servidor.
async function refreshStatus() {
  const sala = state.salaAtual;
  const geracao = _panelGeracao;
  const revisao = _panelRevisao;
  const consulta = ++_panelConsulta;
  const vigente = () => _panelPararStatus && sala === state.salaAtual
    && geracao === _panelGeracao && revisao === _panelRevisao && consulta === _panelConsulta;
  try {
    const status = await Api.statusSala(sala);
    if (!vigente()) return revisao !== _panelRevisao;
    if (status.erro) throw new Error(status.erro);
    aplicarStatusNoPainel(status);
    return true;
  } catch (erro) {
    if (vigente()) Toast.erro("não foi possível falar com o servidor");
    return false;
  }
}

async function enviarComandoPainel(botao, cmd, valor) {
  if (botao.disabled) return;
  botao.disabled = true;
  const resp = await Api.enviarComando(state.salaAtual, cmd, valor);
  if (!resp.ok) Toast.erro(resp.erro || "não foi possível enviar o comando");
  else if (resp.sala && resp.sala.online && resp.sala.canalComandos === false && resp.sala.enviadoAoDispositivo === false) Toast.aviso(PANEL_AVISO_SEM_CANAL);
  // Sem resposta (prazo esgotado ou conexão perdida) o desfecho é desconhecido: só o estado que o
  // servidor devolver diz se o comando valeu. Se nem isso chegar, o botão volta a ficar utilizável.
  const atualizado = await refreshStatus();
  if (!atualizado && state.salaAtual && botao.isConnected) botao.disabled = false;
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

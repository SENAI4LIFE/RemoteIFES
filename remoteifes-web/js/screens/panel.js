let _panelPararStatus = null;
let _funcoesAtuais = [];
let _funcoesEstadoAtuais = {};
let _fanFuncao = null;

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

  ["btnPower", "tempUp", "tempDown"].forEach((id) => {
    document.getElementById(id).disabled = controlesDesabilitados;
  });

  document.querySelectorAll('[data-disponivel="1"]').forEach((el) => {
    el.disabled = controlesDesabilitados;
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

function escapeHtml(texto) {
  const div = document.createElement("div");
  div.textContent = texto == null ? "" : String(texto);
  return div.innerHTML;
}

function estadoTextoDe(funcao, valor) {
  if (funcao.tipo === "booleano") return valor ? "Ligado" : "Desligado";
  if (funcao.tipo === "selecao") return valor === undefined || valor === null ? "—" : String(valor);
  return Number.isFinite(valor) ? String(valor) : "—";
}

const POSICOES_GRID_TOPO = ["grid_topo_1", "grid_topo_2", "grid_topo_3"];
const POSICOES_GRID_BASE = ["grid_base_1", "grid_base_2", "grid_base_3", "grid_base_4", "grid_base_5", "grid_base_6"];

function categorizarFuncoesPorPosicao(funcoes) {
  const porPosicao = {};
  funcoes.forEach((f) => {
    if (f.posicao) porPosicao[f.posicao] = f;
  });
  return {
    fanFuncao: porPosicao.fan || null,
    flankEsquerda: porPosicao.flank_esq || null,
    flankDireita: porPosicao.flank_dir || null,
    gridTopo: POSICOES_GRID_TOPO.map((p) => porPosicao[p]).filter(Boolean),
    gridBase: POSICOES_GRID_BASE.map((p) => porPosicao[p]).filter(Boolean),
  };
}

function categorizarFuncoesAutomatico(funcoes) {
  const restantes = funcoes.slice();
  const idxNumero = restantes.findIndex((f) => f.tipo === "numero");
  const fanFuncao = idxNumero !== -1 ? restantes.splice(idxNumero, 1)[0] : null;
  const flankEsquerda = restantes.shift() || null;
  const flankDireita = restantes.shift() || null;
  return {
    fanFuncao,
    flankEsquerda,
    flankDireita,
    gridTopo: restantes.slice(0, 3),
    gridBase: restantes.slice(3, 9),
  };
}

function categorizarFuncoes(funcoes) {
  const lista = (funcoes || []).slice();
  const temPosicaoDefinida = lista.some((f) => !!f.posicao);
  return temPosicaoDefinida ? categorizarFuncoesPorPosicao(lista) : categorizarFuncoesAutomatico(lista);
}

function aplicarEstadoVisual(botao, funcao) {
  const valor = _funcoesEstadoAtuais[funcao.chave];
  const estadoEl = botao.querySelector(".ac-remote-grid-btn-state");
  if (estadoEl) estadoEl.textContent = estadoTextoDe(funcao, valor);
  const ativo = funcao.tipo === "booleano" ? !!valor : valor !== undefined && valor !== null;
  botao.classList.toggle("active", ativo);
}

function renderFlank(botao, funcao) {
  if (!funcao) {
    if (botao.dataset.chave) {
      botao.classList.add("hidden");
      botao.dataset.disponivel = "0";
      botao.disabled = true;
      delete botao.dataset.chave;
      botao.removeAttribute("aria-label");
      botao.innerHTML = "";
    }
    return;
  }
  if (botao.dataset.chave !== funcao.chave) {
    botao.innerHTML = `<span class="ac-remote-grid-btn-label"></span>`;
  }
  botao.classList.remove("hidden");
  botao.dataset.disponivel = "1";
  botao.disabled = false;
  botao.dataset.chave = funcao.chave;
  botao.setAttribute("aria-label", funcao.rotulo);
  botao.querySelector(".ac-remote-grid-btn-label").textContent = funcao.rotulo;
  aplicarEstadoVisual(botao, funcao);
}

function renderGrid(container, lista) {
  const funcoesDisponiveis = (lista || []).filter(Boolean);
  const existentes = new Map();
  container.querySelectorAll(".ac-remote-grid-btn[data-chave]").forEach((botao) => existentes.set(botao.dataset.chave, botao));

  funcoesDisponiveis.forEach((funcao, index) => {
    let botao = existentes.get(funcao.chave);
    if (!botao) {
      botao = document.createElement("button");
      botao.type = "button";
      botao.className = "ac-remote-grid-btn";
      botao.dataset.chave = funcao.chave;
      botao.dataset.disponivel = "1";
      botao.innerHTML = `
        <span class="ac-remote-grid-btn-label"></span>
        <span class="ac-remote-grid-btn-state"></span>
      `;
    } else {
      existentes.delete(funcao.chave);
    }
    botao.querySelector(".ac-remote-grid-btn-label").textContent = funcao.rotulo;
    aplicarEstadoVisual(botao, funcao);

    const referencia = container.children[index];
    if (referencia !== botao) container.insertBefore(botao, referencia || null);
  });

  existentes.forEach((botao) => botao.remove());
  container.classList.toggle("hidden", funcoesDisponiveis.length === 0);
}

function renderControlesExtras(funcoes, funcoesEstado) {
  _funcoesAtuais = funcoes || [];
  _funcoesEstadoAtuais = funcoesEstado || {};

  const { fanFuncao, flankEsquerda, flankDireita, gridTopo, gridBase } = categorizarFuncoes(_funcoesAtuais);
  _fanFuncao = fanFuncao;

  renderFlank(document.getElementById("btnFlankLeft"), flankEsquerda);
  renderFlank(document.getElementById("btnFlankRight"), flankDireita);

  const fanUp = document.getElementById("fanUp");
  const fanDown = document.getElementById("fanDown");
  fanUp.dataset.disponivel = fanFuncao ? "1" : "0";
  fanDown.dataset.disponivel = fanFuncao ? "1" : "0";
  fanUp.disabled = !fanFuncao;
  fanDown.disabled = !fanFuncao;

  renderGrid(document.getElementById("acGridTopo"), gridTopo);
  renderGrid(document.getElementById("acGridBase"), gridBase);

  const semExtras = !fanFuncao && !flankEsquerda && !flankDireita && gridTopo.length === 0 && gridBase.length === 0;
  document.getElementById("acRemoteBody").classList.toggle("ac-remote-so-temp", semExtras);
}

function localizarFuncao(chave) {
  return _funcoesAtuais.find((f) => f.chave === chave) || null;
}

function proximoValorBooleano(atual) {
  return !atual;
}

function proximoValorSelecao(funcao, atual) {
  const opcoes = Array.isArray(funcao.opcoes) ? funcao.opcoes : null;
  if (!opcoes || opcoes.length === 0) return !atual;
  const idx = opcoes.indexOf(atual);
  return opcoes[(idx + 1) % opcoes.length];
}

function proximoValorNumero(funcao, atual) {
  const opcoes = funcao.opcoes && typeof funcao.opcoes === "object" ? funcao.opcoes : {};
  const min = Number.isFinite(opcoes.min) ? opcoes.min : 0;
  const max = Number.isFinite(opcoes.max) ? opcoes.max : 100;
  const step = Number.isFinite(opcoes.step) && opcoes.step > 0 ? opcoes.step : 1;
  const base = Number.isFinite(atual) ? atual : min;
  const proximo = base + step;
  return proximo > max ? min : proximo;
}

function proximoValorNumeroDirecional(funcao, atual, direcao) {
  const opcoes = funcao.opcoes && typeof funcao.opcoes === "object" ? funcao.opcoes : {};
  const min = Number.isFinite(opcoes.min) ? opcoes.min : 0;
  const max = Number.isFinite(opcoes.max) ? opcoes.max : 100;
  const step = Number.isFinite(opcoes.step) && opcoes.step > 0 ? opcoes.step : 1;
  const base = Number.isFinite(atual) ? atual : min;
  const proximo = base + direcao * step;
  return Math.min(max, Math.max(min, proximo));
}

async function enviarComandoFuncao(chave, novoValor) {
  const resp = await Api.enviarComando(state.salaAtual, chave, novoValor);
  if (!resp.ok) {
    Toast.erro(resp.erro || "não foi possível enviar o comando");
    return;
  }
  _funcoesEstadoAtuais[chave] = novoValor;
  const alvo = document.querySelector(`[data-chave="${CSS.escape(chave)}"]`);
  const funcao = localizarFuncao(chave);
  if (alvo && funcao) aplicarEstadoVisual(alvo, funcao);
}

document.getElementById("acRemoteBody").addEventListener("click", (event) => {
  const botao = event.target.closest("[data-chave]");
  if (!botao || botao.disabled) return;
  const funcao = localizarFuncao(botao.dataset.chave);
  if (!funcao) return;
  const valorAtual = _funcoesEstadoAtuais[funcao.chave];
  let novoValor;
  if (funcao.tipo === "booleano") novoValor = proximoValorBooleano(!!valorAtual);
  else if (funcao.tipo === "selecao") novoValor = proximoValorSelecao(funcao, valorAtual);
  else novoValor = proximoValorNumero(funcao, valorAtual);
  enviarComandoFuncao(funcao.chave, novoValor);
});

document.getElementById("fanUp").addEventListener("click", () => {
  if (!_fanFuncao) return;
  const novoValor = proximoValorNumeroDirecional(_fanFuncao, _funcoesEstadoAtuais[_fanFuncao.chave], 1);
  enviarComandoFuncao(_fanFuncao.chave, novoValor);
});

document.getElementById("fanDown").addEventListener("click", () => {
  if (!_fanFuncao) return;
  const novoValor = proximoValorNumeroDirecional(_fanFuncao, _funcoesEstadoAtuais[_fanFuncao.chave], -1);
  enviarComandoFuncao(_fanFuncao.chave, novoValor);
});

function aplicarStatusNoPainel(status) {
  document.getElementById("tempValue").textContent = `${status.temperatura.toFixed(1)} °C`;

  const conexao = document.getElementById("conexaoValue");
  conexao.textContent = status.online ? "online" : "offline";
  conexao.className = `status-badge ${status.online ? "on" : "off"}`;

  const badge = document.getElementById("statusValue");
  badge.textContent = status.ligado ? "ligado" : "desligado";
  badge.className = `status-badge ${status.ligado ? "on" : "off"}`;

  document.getElementById("modoValue").textContent = status.ligado ? "Cool" : "Off";

  const corpo = document.getElementById("acRemoteBody");
  corpo.classList.toggle("ac-remote-body-off", !status.ligado);

  const power = document.getElementById("btnPower");
  power.classList.toggle("is-on", !!status.ligado);
  power.setAttribute("aria-pressed", status.ligado ? "true" : "false");

  aplicarAvisoOffline(!status.online && status.ligado);

  state.tempAlvo = status.temperaturaAlvo;
  state.tempMinima = status.temperaturaMinima;
  state.tempMaxima = status.temperaturaMaxima;
  document.getElementById("tempTarget").textContent = `${status.temperaturaAlvo}°C`;

  renderControlesExtras(status.funcoes, status.funcoesEstado);
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

document.getElementById("btnPower").addEventListener("click", async () => {
  const ligado = document.getElementById("btnPower").classList.contains("is-on");
  const resp = await Api.enviarComando(state.salaAtual, ligado ? "desligar" : "ligar");
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

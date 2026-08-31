const TELAS_ACESSO_IDS = ["screen-portal", "screen-login", "screen-manutencao-acesso", "screen-server-config", "mainApp"];

function mostrarTelaAcesso(idAlvo) {
  TELAS_ACESSO_IDS.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle("hidden", id !== idAlvo);
  });
  const overlay = document.getElementById("screen-server-status");
  if (overlay) overlay.classList.add("hidden");
}

const ServerStatus = (() => {
  let ws = null;
  let conexaoId = 0;
  let reconectarTimeoutId = null;
  let estadoConectandoTimeoutId = null;
  let tentativas = 0;
  let confirmado = false;
  let acessoManualLiberado = false;
  let manutencaoAtiva = false;
  const ouvintesPronto = new Set();
  const ouvintesMensagem = new Set();
  const ouvintesConectado = new Set();
  const ATRASO_TELA_CONECTANDO = 300;

  const tela = document.getElementById("screen-server-status");
  const spinner = document.getElementById("serverStatusSpinner");
  const emoji = document.getElementById("serverStatusEmoji");
  const titulo = document.getElementById("serverStatusTitulo");
  const desc = document.getElementById("serverStatusDesc");
  const acessoAdminBtn = document.getElementById("serverStatusAcessoAdmin");
  const chipDot = document.getElementById("serverStatusDot");
  const chipLabel = document.getElementById("serverStatusChipLabel");

  const telaConfig = document.getElementById("screen-server-config");
  const formConfig = document.getElementById("serverConfigForm");
  const inputConfig = document.getElementById("serverConfigUrl");
  const erroConfig = document.getElementById("serverConfigError");

  const telaAcesso = document.getElementById("screen-manutencao-acesso");
  const formAcesso = document.getElementById("manutencaoAcessoForm");
  const inputAcessoUsuario = document.getElementById("manutencaoUsuario");
  const inputAcessoSenha = document.getElementById("manutencaoSenha");
  const cancelarAcessoBtn = document.getElementById("manutencaoAcessoCancelarBtn");

  function baseServidor() {
    return (window.RemoteIFESConfig && window.RemoteIFESConfig.serverUrl) || "";
  }

  function servidorConfigurado() {
    return /^https?:\/\//.test(baseServidor());
  }

  function wsUrl() {
    const base = baseServidor() || window.location.origin;
    const wsBase = base.replace(/^http/, "ws");
    return `${wsBase}/ws`;
  }

  function wsToken() {
    return (typeof Api !== "undefined" && Api.obterToken()) || "";
  }

  function mostrarEmoji(caractere) {
    spinner.classList.add("hidden");
    emoji.textContent = caractere;
    emoji.classList.remove("hidden");
  }

  function mostrarSpinner() {
    emoji.classList.add("hidden");
    spinner.classList.remove("hidden");
  }

  function aplicarChip(estado, texto) {
    chipDot.className = `server-status-dot server-status-dot-${estado}`;
    chipLabel.textContent = texto;
  }

  function limparEstadoConectandoAgendado() {
    if (estadoConectandoTimeoutId) {
      clearTimeout(estadoConectandoTimeoutId);
      estadoConectandoTimeoutId = null;
    }
  }

  function agendarEstadoConectando() {
    limparEstadoConectandoAgendado();
    estadoConectandoTimeoutId = setTimeout(() => {
      estadoConectandoTimeoutId = null;
      aplicarEstadoConectando();
    }, ATRASO_TELA_CONECTANDO);
  }

  function aplicarEstadoConectando() {
    tela.classList.remove("hidden");
    acessoAdminBtn.classList.add("hidden");
    mostrarSpinner();
    aplicarChip("offline", "Offline");
    titulo.textContent = "Sem conexão com o servidor";
    desc.textContent = "Reconectando automaticamente…";
  }

  function aplicarEstadoConfiguracao() {
    tela.classList.add("hidden");
    telaConfig.classList.remove("hidden");
    erroConfig.classList.add("hidden");
    setTimeout(() => inputConfig.focus(), 0);
  }

  function aplicarEstadoManutencao() {
    if (acessoManualLiberado) {
      tela.classList.add("hidden");
      return;
    }
    tela.classList.remove("hidden");
    mostrarEmoji("🔧");
    aplicarChip("manutencao", "Em manutenção");
    titulo.textContent = "Sistema em manutenção";
    desc.textContent = "O RemoteIFES está passando por uma manutenção programada. Tente novamente em alguns instantes.";
    acessoAdminBtn.classList.remove("hidden");
  }

  function esconderTela() {
    limparEstadoConectandoAgendado();
    tela.classList.add("hidden");
    acessoManualLiberado = false;
  }

  function mostrarAcessoManutencao() {
    formAcesso.reset();
    mostrarTelaAcesso("screen-manutencao-acesso");
    inputAcessoUsuario.focus();
  }

  function esconderAcessoManutencao() {
    telaAcesso.classList.add("hidden");
    formAcesso.reset();
  }

  function notificarPronto() {
    if (confirmado) return Promise.resolve();
    confirmado = true;
    const resultados = [];
    ouvintesPronto.forEach((cb) => resultados.push(cb()));
    return Promise.all(resultados);
  }

  function definirManutencao(ativa) {
    if (manutencaoAtiva === ativa) return;
    manutencaoAtiva = ativa;
    window.dispatchEvent(new CustomEvent("app:manutencao-estado", { detail: { ativa } }));
  }

  function processarMensagem(msg) {
    if (!msg) return;
    if (msg.tipo !== "servidor") {
      ouvintesMensagem.forEach((cb) => cb(msg));
      return;
    }
    limparEstadoConectandoAgendado();
    if (msg.manutencao) {
      definirManutencao(true);
      aplicarEstadoManutencao();
      notificarPronto();
      return;
    }
    const saindoDaManutencao = manutencaoAtiva;
    definirManutencao(false);
    if (msg.online === false) {
      aplicarEstadoConectando();
      return;
    }
    if (saindoDaManutencao && !telaAcesso.classList.contains("hidden")) {
      esconderAcessoManutencao();
      if (typeof mostrarPortal === "function") mostrarPortal();
    }
    notificarPronto().then(esconderTela);
  }

  function conectar() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    if (!servidorConfigurado()) {
      aplicarEstadoConfiguracao();
      return;
    }

    const idConexao = ++conexaoId;
    tentativas += 1;
    agendarEstadoConectando();

    let socket;
    try {
      const token = wsToken();
      socket = token ? new WebSocket(wsUrl(), [token]) : new WebSocket(wsUrl());
      ws = socket;
    } catch (err) {
      if (idConexao === conexaoId) agendarReconexao();
      return;
    }

    socket.addEventListener("open", () => {
      if (idConexao !== conexaoId || ws !== socket) return;
      tentativas = 0;
      ouvintesConectado.forEach((cb) => cb());
    });

    socket.addEventListener("message", (event) => {
      if (idConexao !== conexaoId || ws !== socket) return;
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (err) {
        return;
      }
      processarMensagem(msg);
    });

    socket.addEventListener("close", () => {
      if (idConexao !== conexaoId || ws !== socket) return;
      ws = null;
      agendarReconexao();
    });

    socket.addEventListener("error", () => {
      if (idConexao === conexaoId && ws === socket) socket.close();
    });
  }

  function reconectarComTokenAtual() {
    conexaoId += 1;
    if (ws) {
      ws.close();
      ws = null;
    }
    if (reconectarTimeoutId) {
      clearTimeout(reconectarTimeoutId);
      reconectarTimeoutId = null;
    }
    tentativas = 0;
    conectar();
  }

  function agendarReconexao() {
    if (reconectarTimeoutId) clearTimeout(reconectarTimeoutId);
    const espera = Math.min(15000, 1000 * tentativas);
    reconectarTimeoutId = setTimeout(conectar, espera);
  }

  function aoFicarPronto(cb) {
    ouvintesPronto.add(cb);
    if (confirmado) cb();
    return () => ouvintesPronto.delete(cb);
  }

  function aoMensagem(cb) {
    ouvintesMensagem.add(cb);
    return () => ouvintesMensagem.delete(cb);
  }

  function aoConectar(cb) {
    ouvintesConectado.add(cb);
    return () => ouvintesConectado.delete(cb);
  }

  function enviar(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  function estaConectado() {
    return !!ws && ws.readyState === WebSocket.OPEN;
  }

  acessoAdminBtn.addEventListener("click", () => {
    acessoManualLiberado = true;
    mostrarAcessoManutencao();
  });

  formConfig.addEventListener("submit", (event) => {
    event.preventDefault();
    erroConfig.classList.add("hidden");
    if (!window.RemoteIFESConfig || !window.RemoteIFESConfig.definirServidor(inputConfig.value)) {
      erroConfig.textContent = "Use um endereço HTTP ou HTTPS válido, sem caminho adicional.";
      erroConfig.classList.remove("hidden");
      inputConfig.focus();
      return;
    }
    window.location.reload();
  });

  cancelarAcessoBtn.addEventListener("click", () => {
    acessoManualLiberado = false;
    esconderAcessoManutencao();
    if (manutencaoAtiva) aplicarEstadoManutencao();
  });

  formAcesso.addEventListener("submit", async (e) => {
    e.preventDefault();
    const usuario = inputAcessoUsuario.value;
    const senha = inputAcessoSenha.value;

    const resp = await Api.login(usuario, senha);
    if (!resp.ok) {
      Toast.erro(resp.erro || "não foi possível entrar");
      return;
    }
    if (!resp.isAdmin) {
      Toast.erro("este usuário não tem privilégios de administrador");
      Api.logout();
      return;
    }

    esconderAcessoManutencao();
    if (typeof definirTipoLoginSelecionado === "function") definirTipoLoginSelecionado("admin");
    if (typeof aplicarSessaoLogada === "function") aplicarSessaoLogada(resp);
    if (typeof switchTab === "function") switchTab("inicio");
  });

  window.addEventListener("app:manutencao-ativa", () => {
    definirManutencao(true);
    if (!acessoManualLiberado) aplicarEstadoManutencao();
  });

  function reconectarSeVisivelEDesconectado() {
    if (document.visibilityState === "visible" && !estaConectado() && servidorConfigurado()) {
      if (reconectarTimeoutId) {
        clearTimeout(reconectarTimeoutId);
        reconectarTimeoutId = null;
      }
      conectar();
    }
  }
  function reconectarAoRetomar() {
    if (document.visibilityState === "visible" && servidorConfigurado()) {
      reconectarComTokenAtual();
    }
  }
  document.addEventListener("visibilitychange", reconectarSeVisivelEDesconectado);
  document.addEventListener("resume", reconectarAoRetomar);
  window.addEventListener("online", reconectarAoRetomar);

  function emManutencao() {
    return manutencaoAtiva;
  }

  function exibirManutencaoSeAtiva() {
    if (!manutencaoAtiva) return false;
    acessoManualLiberado = false;
    esconderAcessoManutencao();
    mostrarTelaAcesso(null);
    aplicarEstadoManutencao();
    return true;
  }

  return {
    conectar,
    aoFicarPronto,
    reconectarComTokenAtual,
    emManutencao,
    exibirManutencaoSeAtiva,
    aoMensagem,
    aoConectar,
    enviar,
    estaConectado,
  };
})();

const ServerStatus = (() => {
  let ws = null;
  let reconectarTimeoutId = null;
  let tentativas = 0;
  let confirmado = false;
  let acessoManualLiberado = false;
  let manutencaoAtiva = false;
  const ouvintesPronto = new Set();

  const tela = document.getElementById("screen-server-status");
  const spinner = document.getElementById("serverStatusSpinner");
  const emoji = document.getElementById("serverStatusEmoji");
  const titulo = document.getElementById("serverStatusTitulo");
  const desc = document.getElementById("serverStatusDesc");
  const acessoAdminBtn = document.getElementById("serverStatusAcessoAdmin");
  const chipDot = document.getElementById("serverStatusDot");
  const chipLabel = document.getElementById("serverStatusChipLabel");

  const telaAcesso = document.getElementById("screen-manutencao-acesso");
  const formAcesso = document.getElementById("manutencaoAcessoForm");
  const inputAcessoUsuario = document.getElementById("manutencaoUsuario");
  const inputAcessoSenha = document.getElementById("manutencaoSenha");
  const cancelarAcessoBtn = document.getElementById("manutencaoAcessoCancelarBtn");

  function wsUrl() {
    const base = (window.RemoteIFESConfig && window.RemoteIFESConfig.serverUrl) || "http://localhost:8080";
    const wsBase = base.replace(/^http/, "ws");
    const token = (typeof Api !== "undefined" && Api.obterToken()) || "";
    return `${wsBase}/ws?token=${encodeURIComponent(token)}`;
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

  function aplicarEstadoConectando() {
    tela.classList.remove("hidden");
    acessoAdminBtn.classList.add("hidden");
    mostrarSpinner();
    aplicarChip("offline", "Offline");
    titulo.textContent = "Sem conexão com o servidor";
    desc.textContent = `Tentativa de conexão nº ${Math.max(1, tentativas)}`;
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
    tela.classList.add("hidden");
    acessoManualLiberado = false;
  }

  function mostrarAcessoManutencao() {
    document.getElementById("mainApp").classList.add("hidden");
    document.getElementById("screen-portal").classList.add("hidden");
    document.getElementById("screen-login").classList.add("hidden");
    formAcesso.reset();
    telaAcesso.classList.remove("hidden");
    inputAcessoUsuario.focus();
  }

  function esconderAcessoManutencao() {
    telaAcesso.classList.add("hidden");
    formAcesso.reset();
  }

  function notificarPronto() {
    if (confirmado) return;
    confirmado = true;
    ouvintesPronto.forEach((cb) => cb());
  }

  function definirManutencao(ativa) {
    if (manutencaoAtiva === ativa) return;
    manutencaoAtiva = ativa;
    window.dispatchEvent(new CustomEvent("app:manutencao-estado", { detail: { ativa } }));
  }

  function processarMensagem(msg) {
    if (!msg || msg.tipo !== "servidor") return;
    if (msg.manutencao) {
      definirManutencao(true);
      aplicarEstadoManutencao();
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
    esconderTela();
    notificarPronto();
  }

  function conectar() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    tentativas += 1;
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

  function reconectarComTokenAtual() {
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

  acessoAdminBtn.addEventListener("click", () => {
    acessoManualLiberado = true;
    tela.classList.add("hidden");
    mostrarAcessoManutencao();
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
    if (typeof aplicarSessaoLogada === "function") aplicarSessaoLogada(resp);
    if (typeof switchTab === "function") switchTab("salas");
  });

  window.addEventListener("app:manutencao-ativa", () => {
    definirManutencao(true);
    if (!acessoManualLiberado) aplicarEstadoManutencao();
  });

  function emManutencao() {
    return manutencaoAtiva;
  }

  return { conectar, aoFicarPronto, reconectarComTokenAtual, emManutencao };
})();

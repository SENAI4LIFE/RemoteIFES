let tipoLoginSelecionado = "normal";

const TEXTOS_LOGIN = {
  normal: {
    titulo: "Entrar",
    hint: "Use o login do RemoteIFES.",
    usuarioLabel: "Usuário",
  },
  admin: {
    titulo: "Entrar como administrador",
    hint: "Acesso restrito à administração do sistema.",
    usuarioLabel: "Login de administrador",
  },
};

function aplicarTextoLogin(tipo) {
  const textos = TEXTOS_LOGIN[tipo];
  document.getElementById("loginTitulo").textContent = textos.titulo;
  document.getElementById("loginHint").textContent = textos.hint;
  document.getElementById("usernameLabel").textContent = textos.usuarioLabel;
  document.getElementById("loginForm").classList.toggle("login-form-admin", tipo === "admin");
}

function mostrarPortal() {
  mostrarTelaAcesso("screen-portal");
}

function mostrarLogin(tipo) {
  mostrarTelaAcesso("screen-login");
  document.getElementById("username").value = "";
  tipoLoginSelecionado = tipo;
  aplicarTextoLogin(tipo);
}

function definirTipoLoginSelecionado(tipo) {
  tipoLoginSelecionado = tipo;
  aplicarTextoLogin(tipo);
}

function aplicarDisponibilidadePortalNormal(manutencaoAtiva) {
  const opcaoNormal = document.querySelector('.portal-option[data-tipo="normal"]');
  const aviso = document.getElementById("portalManutencaoAviso");
  if (opcaoNormal) {
    opcaoNormal.classList.toggle("portal-option-disabled", manutencaoAtiva);
    opcaoNormal.setAttribute("aria-disabled", manutencaoAtiva ? "true" : "false");
    opcaoNormal.title = manutencaoAtiva ? "Indisponível durante a manutenção do sistema" : "";
  }
  if (aviso) aviso.classList.toggle("hidden", !manutencaoAtiva);
}

document.querySelectorAll(".portal-option").forEach((el) => {
  el.setAttribute("role", "button");
  if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "0");

  const ativar = () => {
    if (el.classList.contains("portal-option-disabled")) return;
    mostrarLogin(el.dataset.tipo);
  };

  el.addEventListener("click", ativar);
  el.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    ativar();
  });
});

window.addEventListener("app:manutencao-estado", (e) => {
  aplicarDisponibilidadePortalNormal(!!(e.detail && e.detail.ativa));
});

if (typeof ServerStatus !== "undefined") {
  aplicarDisponibilidadePortalNormal(ServerStatus.emManutencao());
}

document.getElementById("loginVoltarBtn").addEventListener("click", mostrarPortal);

function aplicarSessaoLogada(resp, { reconectarStatus = true } = {}) {
  state.usuario = resp.usuario;
  state.nome = resp.nome;
  state.isAdmin = resp.isAdmin;
  state.isSuperAdmin = resp.isSuperAdmin;
  state.nivel = resp.nivel;
  state.podeControlar = resp.podeControlar;
  state.temSalaComoProprietario = !!resp.temSalaComoProprietario;
  state.senhaPadraoAtiva = !!resp.senhaPadraoAtiva && !!resp.isSuperAdmin;

  document.getElementById("userTag").textContent = resp.isAdmin ? `${resp.nome} (admin)` : resp.nome;
  document.getElementById("adminTabBtn").classList.toggle("hidden", !resp.isAdmin);
  document.getElementById("agendaTabBtn").classList.toggle("hidden", !resp.isAdmin);
  document.getElementById("gradeTabBtn").classList.toggle("hidden", !resp.isAdmin);
  document.getElementById("propriedadeTabBtn").classList.toggle("hidden", resp.isAdmin || !resp.temSalaComoProprietario);
  document.getElementById("notifWrap").classList.toggle("hidden", !resp.isAdmin);
  document.querySelectorAll(".superadmin-only").forEach((el) => {
    el.classList.toggle("hidden", !resp.isSuperAdmin);
  });
  if (typeof AccountMenu !== "undefined") AccountMenu.atualizar();
  document.getElementById("defaultPasswordWarning").classList.toggle("hidden", !state.senhaPadraoAtiva);

  mostrarTelaAcesso("mainApp");

  if (resp.isAdmin) Notificacoes.iniciar();
  Relatos.aoLogar();

  IdleTimer.iniciar(resp.sessaoExpiraEm, resp.popupAvisoSegundos, resp.servidorAgora);
  RTStatus.conectar();
  if (reconectarStatus && typeof ServerStatus !== "undefined") ServerStatus.reconectarComTokenAtual();
}

async function restaurarSessaoSalva() {
  if (state.usuario) return false;
  const abrirAjudaSemSessao = () => {
    if (typeof Router !== "undefined" && location.hash.startsWith("#/ajuda")) Router.restaurar();
  };
  if (!Api.temTokenSalvo()) {
    abrirAjudaSemSessao();
    return false;
  }
  const resp = await Api.me();
  if (!resp.ok) {
    await Api.logout();
    abrirAjudaSemSessao();
    return false;
  }
  aplicarSessaoLogada(resp, { reconectarStatus: false });
  if (typeof Router !== "undefined") await Router.restaurar();
  else switchTab("inicio");
  return true;
}

document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const usuario = document.getElementById("username").value;
  const senha = document.getElementById("password").value;

  const resp = await Api.login(usuario, senha);
  if (!resp.ok) {
    Toast.erro(resp.manutencao ? "Manutenção: só administradores podem entrar agora." : (resp.erro || "não foi possível entrar"));
    return;
  }

  if (tipoLoginSelecionado === "admin" && !resp.isAdmin) {
    Toast.erro("este usuário não tem privilégios de administrador");
    Api.logout();
    return;
  }

  aplicarSessaoLogada(resp);
  if (typeof Router !== "undefined") await Router.restaurar();
  else switchTab("inicio");
});

function realizarLogout({ manterTela = false } = {}) {
  IdleTimer.parar();
  if (typeof pararAutoRefreshPanel === "function") pararAutoRefreshPanel();
  if (typeof pararAutoRefreshRooms === "function") pararAutoRefreshRooms();
  if (typeof SimpleWizard !== "undefined") SimpleWizard.pararAutoRefresh();
  if (typeof ScreenFloorplan !== "undefined") ScreenFloorplan.aoFechar();
  if (typeof Esp32Admin !== "undefined") Esp32Admin.aoFechar();
  if (typeof Admin !== "undefined" && Admin._ativosIntervalId) {
    clearInterval(Admin._ativosIntervalId);
    Admin._ativosIntervalId = null;
  }
  Notificacoes.pararPolling();
  Relatos.aoDeslogar();
  RTStatus.desconectar();
  if (typeof RoleDocumentation !== "undefined") RoleDocumentation.limpar();
  if (typeof ServerStatus !== "undefined") ServerStatus.reconectarComTokenAtual();
  state.usuario = null;
  state.nome = null;
  state.isAdmin = false;
  state.isSuperAdmin = false;
  state.nivel = 1;
  state.podeControlar = false;
  state.temSalaComoProprietario = false;
  state.senhaPadraoAtiva = false;
  state.bloco = null;
  state.andar = null;
  state.salaAtual = null;

  document.getElementById("userTag").classList.add("hidden");
  document.getElementById("logoutBtn").classList.add("hidden");
  document.getElementById("adminTabBtn").classList.add("hidden");
  document.getElementById("agendaTabBtn").classList.add("hidden");
  document.getElementById("gradeTabBtn").classList.add("hidden");
  document.getElementById("propriedadeTabBtn").classList.add("hidden");
  document.querySelectorAll(".superadmin-only").forEach((el) => el.classList.add("hidden"));
  document.getElementById("defaultPasswordWarning").classList.add("hidden");
  if (typeof AccountMenu !== "undefined") AccountMenu.atualizar();
  document.getElementById("mainApp").classList.add("hidden");
  document.getElementById("loginForm").reset();

  try {
    history.replaceState(null, "", location.pathname + location.search);
  } catch (erro) {}

  if (manterTela) {
    mostrarLogin(tipoLoginSelecionado);
  } else {
    mostrarPortal();
    tipoLoginSelecionado = "normal";
    aplicarTextoLogin("normal");
  }
}

document.getElementById("logoutBtn").addEventListener("click", async () => {
  await Api.logout();
  realizarLogout();
});

window.addEventListener("app:sessao-expirada", () => {
  if (!state.usuario) return;
  Api.logout();
  realizarLogout({ manterTela: true });
  Toast.erro("sua sessão expirou por inatividade: entre novamente");
});

document.getElementById("defaultPasswordChangeBtn").addEventListener("click", async () => {
  if (!state.isSuperAdmin || !state.senhaPadraoAtiva) return;
  const alterada = await Dialog.senha({
    titulo: "Alterar senha do superadministrador",
    descricao: "Defina uma senha com pelo menos 8 caracteres. As sessões atuais serão encerradas.",
    aoConfirmar: async (novaSenha) => {
      const resposta = await Api.trocarMinhaSenha(novaSenha);
      return resposta && resposta.ok ? { ok: true } : { ok: false, erro: resposta?.erro || "não foi possível trocar a senha" };
    },
  });
  if (!alterada) return;
  Api.limparSessaoLocal();
  realizarLogout({ manterTela: true });
  Toast.aviso("Senha atualizada. Entre novamente com a nova senha.");
});

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
  document.getElementById("mainApp").classList.add("hidden");
  document.getElementById("screen-login").classList.add("hidden");
  document.getElementById("screen-portal").classList.remove("hidden");
}

function mostrarLogin(tipo) {
  document.getElementById("screen-portal").classList.add("hidden");
  document.getElementById("screen-login").classList.remove("hidden");
  document.getElementById("username").value = "";
  tipoLoginSelecionado = tipo;
  aplicarTextoLogin(tipo);
}

document.querySelectorAll(".portal-option").forEach((el) => {
  el.addEventListener("click", () => mostrarLogin(el.dataset.tipo));
});

document.getElementById("loginVoltarBtn").addEventListener("click", mostrarPortal);

function aplicarSessaoLogada(resp) {
  state.usuario = resp.usuario;
  state.nome = resp.nome;
  state.isAdmin = resp.isAdmin;
  state.isSuperAdmin = resp.isSuperAdmin;
  state.nivel = resp.nivel;
  state.podeControlar = resp.podeControlar;

  document.getElementById("userTag").textContent = resp.isAdmin ? `${resp.nome} (admin)` : resp.nome;
  document.getElementById("userTag").classList.remove("hidden");
  document.getElementById("logoutBtn").classList.remove("hidden");
  document.getElementById("adminTabBtn").classList.toggle("hidden", !resp.isAdmin);
  document.getElementById("agendaTabBtn").classList.toggle("hidden", !resp.isAdmin);
  document.getElementById("gradeTabBtn").classList.toggle("hidden", !resp.isAdmin);
  document.querySelectorAll(".superadmin-only").forEach((el) => {
    el.classList.toggle("hidden", !resp.isSuperAdmin);
  });

  document.getElementById("screen-portal").classList.add("hidden");
  document.getElementById("screen-login").classList.add("hidden");
  document.getElementById("mainApp").classList.remove("hidden");

  IdleTimer.iniciar(resp.timeoutInatividadeMinutos, resp.popupAvisoSegundos);
}

async function restaurarSessaoSalva() {
  if (!Api.temTokenSalvo()) return false;
  const resp = await Api.me();
  if (!resp.ok) {
    await Api.logout();
    return false;
  }
  aplicarSessaoLogada(resp);
  switchTab("salas");
  return true;
}

document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const usuario = document.getElementById("username").value;
  const senha = document.getElementById("password").value;
  const errorEl = document.getElementById("loginError");
  errorEl.classList.add("hidden");

  const resp = await Api.login(usuario, senha);
  if (!resp.ok) {
    errorEl.textContent = resp.erro || "não foi possível entrar";
    errorEl.classList.remove("hidden");
    return;
  }

  if (tipoLoginSelecionado === "admin" && !resp.isAdmin) {
    errorEl.textContent = "este usuário não tem privilégios de administrador";
    errorEl.classList.remove("hidden");
    Api.logout();
    return;
  }

  aplicarSessaoLogada(resp);
  switchTab("salas");
});

function realizarLogout({ manterTela = false } = {}) {
  IdleTimer.parar();
  state.usuario = null;
  state.nome = null;
  state.isAdmin = false;
  state.isSuperAdmin = false;
  state.nivel = 1;
  state.podeControlar = false;
  state.bloco = null;
  state.andar = null;
  state.salaAtual = null;

  document.getElementById("userTag").classList.add("hidden");
  document.getElementById("logoutBtn").classList.add("hidden");
  document.getElementById("adminTabBtn").classList.add("hidden");
  document.getElementById("agendaTabBtn").classList.add("hidden");
  document.getElementById("gradeTabBtn").classList.add("hidden");
  document.querySelectorAll(".superadmin-only").forEach((el) => el.classList.add("hidden"));
  document.getElementById("mainApp").classList.add("hidden");
  document.getElementById("loginForm").reset();

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
  const errorEl = document.getElementById("loginError");
  errorEl.textContent = "sua sessão expirou por inatividade — entre novamente";
  errorEl.classList.remove("hidden");
});

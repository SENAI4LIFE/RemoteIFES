let tipoLoginSelecionado = "normal";

document.querySelectorAll(".login-type-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".login-type-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    tipoLoginSelecionado = btn.dataset.tipo;
    document.getElementById("username").value = tipoLoginSelecionado === "admin" ? "admin" : "";
  });
});

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

  // O toggle é apenas conveniência de UX: a permissão real vem do servidor.
  if (tipoLoginSelecionado === "admin" && !resp.isAdmin) {
    errorEl.textContent = "este usuário não tem privilégios de administrador";
    errorEl.classList.remove("hidden");
    Api.logout();
    return;
  }

  state.usuario = resp.usuario;
  state.nome = resp.nome;
  state.isAdmin = resp.isAdmin;
  state.podeControlar = resp.podeControlar;
  state.podeAgendar = resp.podeAgendar;

  document.getElementById("userTag").textContent = resp.isAdmin ? `${resp.nome} (admin)` : resp.nome;
  document.getElementById("userTag").classList.remove("hidden");
  document.getElementById("logoutBtn").classList.remove("hidden");
  document.getElementById("adminTabBtn").classList.toggle("hidden", !resp.isAdmin);

  document.getElementById("screen-login").classList.add("hidden");
  document.getElementById("mainApp").classList.remove("hidden");

  switchTab("salas");
});

document.getElementById("logoutBtn").addEventListener("click", () => {
  Api.logout();
  state.usuario = null;
  state.nome = null;
  state.isAdmin = false;
  state.podeControlar = false;
  state.podeAgendar = false;
  state.bloco = null;
  state.andar = null;
  state.salaAtual = null;

  document.getElementById("userTag").classList.add("hidden");
  document.getElementById("logoutBtn").classList.add("hidden");
  document.getElementById("adminTabBtn").classList.add("hidden");
  document.getElementById("mainApp").classList.add("hidden");
  document.getElementById("screen-login").classList.remove("hidden");
  document.getElementById("loginForm").reset();
});

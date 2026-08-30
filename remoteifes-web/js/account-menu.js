const AccountMenu = (() => {
  const wrap = document.getElementById("accountWrap");
  const botao = document.getElementById("accountMenuBtn");
  const menu = document.getElementById("accountMenu");
  let focoAnterior = null;

  function iniciais(nome) {
    const conectores = new Set(["da", "das", "de", "do", "dos", "e"]);
    const partes = String(nome || "")
      .trim()
      .split(/\s+/)
      .filter((parte) => /[\p{L}\p{N}]/u.test(parte) && !conectores.has(parte.toLocaleLowerCase("pt-BR")));
    return partes.slice(0, 2).map((parte) => Array.from(parte)[0]).join("").toLocaleUpperCase("pt-BR") || "?";
  }

  function atualizar() {
    if (!state.usuario) {
      fechar({ restaurarFoco: false });
      wrap.classList.add("hidden");
      return;
    }
    const papel = state.isSuperAdmin ? "Superadministrador" : state.isAdmin ? "Administrador" : "Usuário";
    botao.textContent = iniciais(state.nome || state.usuario);
    botao.setAttribute("aria-label", `Abrir menu da conta de ${state.nome || state.usuario}`);
    document.getElementById("accountMenuName").textContent = state.nome || state.usuario;
    document.getElementById("accountMenuLogin").textContent = `@${state.usuario}`;
    document.getElementById("accountMenuRole").textContent = papel;
    wrap.classList.remove("hidden");
  }

  function itens() {
    return Array.from(menu.querySelectorAll('[role="menuitem"]')).filter((el) => !el.disabled && !el.classList.contains("hidden"));
  }

  function abrir() {
    focoAnterior = document.activeElement;
    menu.classList.remove("hidden");
    botao.setAttribute("aria-expanded", "true");
    const primeiro = itens()[0];
    if (primeiro) primeiro.focus();
  }

  function fechar({ restaurarFoco = true } = {}) {
    if (menu.classList.contains("hidden")) return;
    menu.classList.add("hidden");
    botao.setAttribute("aria-expanded", "false");
    if (restaurarFoco && focoAnterior && typeof focoAnterior.focus === "function") focoAnterior.focus();
    focoAnterior = null;
  }

  botao.addEventListener("click", () => menu.classList.contains("hidden") ? abrir() : fechar());
  menu.addEventListener("keydown", (event) => {
    const disponiveis = itens();
    const atual = disponiveis.indexOf(document.activeElement);
    if (event.key === "Escape") return fechar();
    if (event.key === "Home" || event.key === "End" || event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const indice = event.key === "Home" ? 0 : event.key === "End" ? disponiveis.length - 1 :
        event.key === "ArrowDown" ? (atual + 1) % disponiveis.length : (atual - 1 + disponiveis.length) % disponiveis.length;
      if (disponiveis[indice]) disponiveis[indice].focus();
    }
  });
  menu.addEventListener("click", (event) => {
    const item = event.target.closest("[data-account-action]");
    if (!item) return;
    const acao = item.dataset.accountAction;
    fechar({ restaurarFoco: false });
    if (acao === "mobile" && typeof MobileApp !== "undefined") MobileApp.abrir();
    if (acao === "logout") document.getElementById("logoutBtn").click();
  });
  document.addEventListener("pointerdown", (event) => {
    if (!menu.classList.contains("hidden") && !wrap.contains(event.target)) fechar({ restaurarFoco: false });
  });
  document.addEventListener("focusin", (event) => {
    if (!menu.classList.contains("hidden") && !wrap.contains(event.target)) fechar({ restaurarFoco: false });
  });
  botao.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      abrir();
    }
  });

  return { atualizar, fechar, iniciais };
})();

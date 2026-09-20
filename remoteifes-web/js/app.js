const _tabInicial = document.querySelector('.tab-btn[data-tab="inicio"]');
_tabInicial.classList.add("active");
_tabInicial.setAttribute("aria-current", "page");

if ("serviceWorker" in navigator && !(window.RemoteIFESConfig && window.RemoteIFESConfig.empacotado)) {
  window.addEventListener("load", () => {
    const versao = window.REMOTEIFES_FRONTEND_VERSION || "unknown";
    // A recarga da aba após uma atualização é feita pelo próprio worker (clients.navigate),
    // que também alcança abas abertas por versões antigas do frontend. Duplicá-la aqui
    // causaria duas navegações para a mesma atualização.
    navigator.serviceWorker.register(`sw.js?v=${encodeURIComponent(versao)}`, { updateViaCache: "none" })
      .then((registro) => registro.update())
      .catch(() => {});
  });
}

document.getElementById("homeBtn").addEventListener("click", () => {
  if (state.usuario) {
    switchTab("inicio");
    return;
  }
  if (typeof ServerStatus !== "undefined" && ServerStatus.exibirManutencaoSeAtiva()) return;
  mostrarPortal();
});

ServerStatus.aoFicarPronto(() => {
  restaurarSessaoSalva();
});
ServerStatus.conectar();

// A faixa de senha padrão é sticky logo abaixo da barra superior. Outros elementos
// sticky (as sub-abas de Administração) precisam da altura real dela, que muda com
// a ampliação de texto e com a largura da tela.
(function () {
  const aviso = document.getElementById("defaultPasswordWarning");
  if (!aviso) return;
  const medir = () => {
    const estilo = getComputedStyle(aviso);
    const fixa = !aviso.classList.contains("hidden") && estilo.position === "sticky";
    // Onde a faixa termina quando encostada: o proprio deslocamento sticky mais a altura.
    const fim = fixa ? (parseFloat(estilo.top) || 0) + aviso.getBoundingClientRect().height : 0;
    document.documentElement.style.setProperty("--aviso-seguranca-fim", `${Math.round(fim)}px`);
  };
  medir();
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(medir).observe(aviso);
  new MutationObserver(medir).observe(aviso, { attributes: true, attributeFilter: ["class"] });
  window.addEventListener("resize", medir);
})();

// A barra inferior cresce com a ampliação de texto. Os botões flutuantes e a folga no fim
// da página partem da altura real dela (sem a área segura, que o CSS soma por conta
// própria), não de um valor fixo.
(function () {
  const barra = document.querySelector(".tabbar");
  if (!barra) return;
  const medir = () => {
    const altura = barra.getBoundingClientRect().height;
    if (!altura) {
      document.documentElement.style.removeProperty("--tabbar-h");
      return;
    }
    const areaSegura = parseFloat(getComputedStyle(barra).paddingBottom) || 0;
    document.documentElement.style.setProperty("--tabbar-h", `${Math.round(altura - areaSegura)}px`);
  };
  medir();
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(medir).observe(barra);
  window.addEventListener("resize", medir);
})();

// A barra lateral da Administração é sticky: enquanto a página não rola, ela fica abaixo
// do deslocamento sticky, e uma altura máxima calculada para a posição encostada passava
// por baixo da barra inferior. A posição real no viewport vai para --admin-nav-atual.
(function () {
  const nav = document.querySelector(".admin-subtabs");
  if (!nav) return;
  let agendado = false;
  const medir = () => {
    agendado = false;
    const estilo = getComputedStyle(nav);
    const topo = parseFloat(estilo.top);
    if (estilo.position !== "sticky" || Number.isNaN(topo) || !nav.offsetParent) {
      document.documentElement.style.removeProperty("--admin-nav-atual");
      return;
    }
    const atual = Math.max(topo, nav.getBoundingClientRect().top);
    document.documentElement.style.setProperty("--admin-nav-atual", `${Math.round(atual)}px`);
  };
  const agendar = () => {
    if (agendado) return;
    agendado = true;
    requestAnimationFrame(medir);
  };
  medir();
  if (typeof ResizeObserver !== "undefined") {
    // A posição da barra muda com o que fica acima dela: barra superior, faixa de senha
    // padrão e o cabeçalho da tela, além da própria barra aparecer ou sumir.
    const observador = new ResizeObserver(agendar);
    const acima = document.querySelector("#screen-admin .screen-head");
    [nav, document.querySelector(".topbar"), document.getElementById("defaultPasswordWarning"), acima].forEach((el) => { if (el) observador.observe(el); });
  }
  window.addEventListener("scroll", agendar, { passive: true });
  window.addEventListener("resize", agendar);
})();

const _tabInicial = document.querySelector('.tab-btn[data-tab="inicio"]');
_tabInicial.classList.add("active");
_tabInicial.setAttribute("aria-current", "page");

if ("serviceWorker" in navigator && !(window.RemoteIFESConfig && window.RemoteIFESConfig.empacotado)) {
  window.addEventListener("load", () => {
    const versao = window.REMOTEIFES_FRONTEND_VERSION || "unknown";
    // The tab reload after an update is done by the worker itself (clients.navigate), which also
    // reaches tabs opened by older frontend versions. Duplicating it here would cause two
    // navigations for the same update.
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

// The default-password banner is sticky just below the top bar. Other sticky elements (the
// Administration sub-tabs) need its real height, which changes with text enlargement and screen
// width.
(function () {
  const aviso = document.getElementById("defaultPasswordWarning");
  if (!aviso) return;
  const medir = () => {
    const estilo = getComputedStyle(aviso);
    const fixa = !aviso.classList.contains("hidden") && estilo.position === "sticky";
    // Where the banner ends when stuck: its own sticky offset plus its height.
    const fim = fixa ? (parseFloat(estilo.top) || 0) + aviso.getBoundingClientRect().height : 0;
    document.documentElement.style.setProperty("--aviso-seguranca-fim", `${Math.round(fim)}px`);
  };
  medir();
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(medir).observe(aviso);
  new MutationObserver(medir).observe(aviso, { attributes: true, attributeFilter: ["class"] });
  window.addEventListener("resize", medir);
})();

// The bottom bar grows with text enlargement. The floating buttons and the page-end clearance use
// its real height (without the safe area, which CSS adds itself), not a fixed value.
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

// The Administration sidebar is sticky: while the page has not scrolled it sits below the sticky
// offset, and a max height computed for the stuck position ran under the bottom bar. The real
// viewport position goes to --admin-nav-atual.
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
    // The bar position changes with what sits above it: top bar, default-password banner and the
    // screen header, and the bar itself appearing or disappearing.
    const observador = new ResizeObserver(agendar);
    const acima = document.querySelector("#screen-admin .screen-head");
    [nav, document.querySelector(".topbar"), document.getElementById("defaultPasswordWarning"), acima].forEach((el) => { if (el) observador.observe(el); });
  }
  window.addEventListener("scroll", agendar, { passive: true });
  window.addEventListener("resize", agendar);
})();

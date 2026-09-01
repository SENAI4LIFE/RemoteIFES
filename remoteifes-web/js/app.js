const _tabInicial = document.querySelector('.tab-btn[data-tab="inicio"]');
_tabInicial.classList.add("active");
_tabInicial.setAttribute("aria-current", "page");

if ("serviceWorker" in navigator) {
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

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

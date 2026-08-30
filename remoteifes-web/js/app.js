const _tabInicial = document.querySelector('.tab-btn[data-tab="inicio"]');
_tabInicial.classList.add("active");
_tabInicial.setAttribute("aria-current", "page");

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

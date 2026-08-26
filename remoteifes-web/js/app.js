document.querySelector('.tab-btn[data-tab="salas"]').classList.add("active");

document.getElementById("homeBtn").addEventListener("click", () => {
  if (state.usuario) {
    if (salasSubScreenAtual === "simple" && typeof SimpleWizard !== "undefined") {
      if (SimpleWizard.bloco) SimpleWizard.irParaAndar(SimpleWizard.bloco);
      else SimpleWizard.irParaBloco();
    }
    switchTab("salas");
    return;
  }
  if (typeof ServerStatus !== "undefined" && ServerStatus.exibirManutencaoSeAtiva()) return;
  mostrarPortal();
});

ServerStatus.aoFicarPronto(() => {
  restaurarSessaoSalva();
});
ServerStatus.conectar();

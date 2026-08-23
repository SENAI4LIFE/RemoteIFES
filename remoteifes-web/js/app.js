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

// Só tenta restaurar a sessão (e portanto exibir o app) depois que a tela de
// status confirmar que o servidor está no ar e fora de manutenção. Evita que
// uma falha de rede passageira ou o servidor fora do ar pareçam um logout.
ServerStatus.aoFicarPronto(() => {
  restaurarSessaoSalva();
});
ServerStatus.conectar();

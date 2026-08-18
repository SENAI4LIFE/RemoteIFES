document.querySelector('.tab-btn[data-tab="salas"]').classList.add("active");

document.getElementById("homeBtn").addEventListener("click", () => {
  if (state.usuario) {
    switchTab("salas");
  } else {
    mostrarPortal();
  }
});

restaurarSessaoSalva();

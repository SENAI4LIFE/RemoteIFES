const verSalasBtn = document.getElementById("verSalasBtn");

function atualizarBotaoVerSalas() {
  verSalasBtn.disabled = !(state.bloco && state.andar);
}

document.querySelectorAll("#blocoChoices .choice-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#blocoChoices .choice-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.bloco = btn.dataset.bloco;
    atualizarBotaoVerSalas();
  });
});

document.querySelectorAll("#andarChoices .choice-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#andarChoices .choice-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.andar = btn.dataset.andar;
    atualizarBotaoVerSalas();
  });
});

verSalasBtn.addEventListener("click", async () => {
  showScreen("rooms");
  await loadRooms(state.bloco, state.andar);
});

document.getElementById("backToLocationBtn").addEventListener("click", () => {
  showScreen("location");
});

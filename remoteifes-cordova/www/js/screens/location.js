const verSalasBtn = document.getElementById("verSalasBtn");
const locationTitle = document.querySelector("#screen-location .screen-head h1");

function atualizarTituloLocation() {
  if (!state.bloco) {
    locationTitle.textContent = "Selecione o bloco";
  } else if (!state.andar) {
    locationTitle.textContent = "Selecione o andar";
  } else {
    locationTitle.textContent = "Selecione a sala";
  }
}

function atualizarBotaoVerSalas() {
  verSalasBtn.disabled = !(state.bloco && state.andar);
  atualizarTituloLocation();
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

document.getElementById("locationSimpleBtn").addEventListener("click", () => {
  showScreen("simple");
});

atualizarBotaoVerSalas();

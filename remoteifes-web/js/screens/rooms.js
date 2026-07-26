async function loadRooms(bloco, andar) {
  const list = document.getElementById("roomList");
  const empty = document.getElementById("roomsEmpty");
  const titulo = document.getElementById("roomsTitle");
  titulo.textContent = `Bloco ${bloco} — ${andar}º andar`;
  list.innerHTML = "";

  const salas = await Api.listarSalas({ bloco, andar });
  if (salas.length === 0) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  salas.forEach((s) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <div>
        <div class="room-name">
          ${s.sala}
          ${s.agendadaAgora ? '<span class="schedule-badge" title="Agendamento ativo agora">agendada</span>' : ""}
        </div>
        <div class="room-sub">${s.nome}${s.ligado ? " · ligado" : ""}</div>
      </div>
      <span class="status-badge ${s.online ? "on" : "off"}">${s.online ? "online" : "offline"}</span>
    `;
    li.addEventListener("click", () => openRoom(s.sala, s.nome));
    list.appendChild(li);
  });
}

document.getElementById("backBtn").addEventListener("click", () => showScreen("rooms"));

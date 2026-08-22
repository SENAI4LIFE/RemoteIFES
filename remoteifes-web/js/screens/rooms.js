let _roomsBlocoAtual = null;
let _roomsAndarAtual = null;
let _roomsPararSalas = null;

async function loadRooms(bloco, andar) {
  _roomsBlocoAtual = bloco;
  _roomsAndarAtual = andar;
  const titulo = document.getElementById("roomsTitle");
  titulo.textContent = `Bloco ${bloco} — ${andar}º andar`;
  const salas = await Api.listarSalas({ bloco, andar });
  renderRooms(salas);
  iniciarAutoRefreshRooms();
}

function renderRooms(salasTodas) {
  const list = document.getElementById("roomList");
  const empty = document.getElementById("roomsEmpty");

  const salas = (salasTodas || []).filter(
    (s) => s.bloco === _roomsBlocoAtual && String(s.andar) === String(_roomsAndarAtual)
  );
  if (salas.length === 0) {
    list.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  list.innerHTML = "";
  salas.forEach((s) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <div>
        <div class="room-name">
          ${s.sala}
          ${s.agendadaAgora ? '<span class="schedule-badge" title="Agendamento ativo agora">agendada</span>' : ""}
          ${s.podeControlarEsta === false ? '<span class="schedule-badge readonly-badge" title="Apenas visualização">visualização</span>' : ""}
        </div>
        <div class="room-sub">${s.nome}${s.online && s.ligado ? " · ligado" : ""}</div>
      </div>
      <span class="status-badge ${s.online ? "on" : "off"}">${s.online ? "online" : "offline"}</span>
    `;
    li.addEventListener("click", () => openRoom(s.sala, s.nome));
    list.appendChild(li);
  });
}

function iniciarAutoRefreshRooms(somenteSeJaCarregado) {
  if (somenteSeJaCarregado && (!_roomsBlocoAtual || !_roomsAndarAtual)) return;
  pararAutoRefreshRooms();
  _roomsPararSalas = RTStatus.aoSalas((salas) => renderRooms(salas));
}

function pararAutoRefreshRooms() {
  if (_roomsPararSalas) {
    _roomsPararSalas();
    _roomsPararSalas = null;
  }
}

document.getElementById("backBtn").addEventListener("click", () => showScreen(salasSubScreenAtual));

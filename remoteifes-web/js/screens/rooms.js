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
        <div class="room-sub">${s.nome}${s.online && s.ligado ? " · ligado" : ""}</div>
      </div>
      <span class="status-badge ${s.online ? "on" : "off"}">${s.online ? "online" : "offline"}</span>
    `;
    li.addEventListener("click", () => openRoom(s.sala, s.nome));
    list.appendChild(li);
  });

  await loadSalasMapa();
}

let salasMapaInstancia = null;

async function loadSalasMapa() {
  const container = document.getElementById("salasMapa");
  if (!container || typeof L === "undefined") return;

  const salas = (await Api.listarSalas()).filter((s) => s.latitude && s.longitude);
  if (salas.length === 0) return;

  if (!salasMapaInstancia) {
    salasMapaInstancia = L.map(container);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; colaboradores do OpenStreetMap",
      maxZoom: 20,
    }).addTo(salasMapaInstancia);
  } else {
    salasMapaInstancia.eachLayer((layer) => {
      if (layer instanceof L.Marker) salasMapaInstancia.removeLayer(layer);
    });
  }

  const pontos = salas.map((s) => [s.latitude, s.longitude]);
  salas.forEach((s) => {
    const cor = s.online ? (s.ligado ? "#2e7d32" : "#1976d2") : "#9e9e9e";
    const icone = L.divIcon({
      className: "",
      html: `<span class="mapa-marker" style="background:${cor}"></span>`,
      iconSize: [16, 16],
    });
    L.marker([s.latitude, s.longitude], { icon: icone })
      .addTo(salasMapaInstancia)
      .bindTooltip(`${s.sala} — ${s.nome}`)
      .on("click", () => openRoom(s.sala, s.nome));
  });

  salasMapaInstancia.fitBounds(pontos, { padding: [20, 20] });
  setTimeout(() => salasMapaInstancia.invalidateSize(), 200);
}

document.getElementById("backBtn").addEventListener("click", () => showScreen("rooms"));

let _roomsBlocoAtual = null;
let _roomsAndarAtual = null;
let _roomsPararSalas = null;

async function loadRooms(bloco, andar) {
  _roomsBlocoAtual = bloco;
  _roomsAndarAtual = andar;
  const titulo = document.getElementById("roomsTitle");
  titulo.textContent = `Bloco ${bloco}, ${andar}º andar`;
  const salas = await Api.listarSalas({ bloco, andar });
  renderRooms(salas);
  iniciarAutoRefreshRooms();
}

function renderRooms(salasTodas) {
  const list = document.getElementById("roomList");
  const empty = document.getElementById("roomsEmpty");

  const secaoPlanta = document.querySelector(`[data-fp-section="${_roomsBlocoAtual.toLowerCase()}-${String(_roomsAndarAtual) === "1" ? "terreo" : `${_roomsAndarAtual}pav`}"]`);
  const rotulosPlanta = new Map();
  const codigosPlanta = new Set();
  if (secaoPlanta) {
    secaoPlanta.querySelectorAll(".room.selectable[data-sala]").forEach((el) => {
      codigosPlanta.add(el.dataset.sala);
      const nome = el.querySelector(".name")?.textContent?.trim();
      if (nome) rotulosPlanta.set(el.dataset.sala, nome);
    });
  }

  const salas = (salasTodas || []).filter(
    (s) => s.bloco === _roomsBlocoAtual && String(s.andar) === String(_roomsAndarAtual) &&
      (!codigosPlanta.size || codigosPlanta.has(s.sala))
  );
  if (salas.length === 0) {
    list.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  // Cada sala é um <li> estável: as atualizações em tempo real só trocam textos e classes, sem
  // recriar nem reposicionar o elemento (a ordem recebida não reordena a lista já exibida).
  UISync.sincronizarLista(list, salas, {
    seletor: "li[data-sala]",
    chave: (s) => s.sala,
    criar: () => {
      const li = document.createElement("li");
      li.tabIndex = 0;
      li.setAttribute("role", "button");
      li.innerHTML = `
        <div>
          <div class="room-name"></div>
          <div class="room-sub"></div>
        </div>
        <span class="status-badge"></span>
      `;
      li.addEventListener("click", () => openRoom(li.dataset.sala, li.dataset.nome));
      li.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        openRoom(li.dataset.sala, li.dataset.nome);
      });
      return li;
    },
    atualizar: (li, s) => {
      li.dataset.nome = s.nome;
      UISync.aplicarHtml(li.querySelector(".room-name"), `
        ${escapeHtml(rotulosPlanta.get(s.sala) || RoomsData.rotulo(s.sala))}
        ${s.agendadaAgora ? '<span class="schedule-badge" title="Agendamento ativo agora">agendada</span>' : ""}
        ${s.podeControlarEsta === false ? '<span class="schedule-badge readonly-badge" title="Apenas visualização">visualização</span>' : ""}
      `);
      const sub = li.querySelector(".room-sub");
      const textoSub = `${s.nome}${s.online && s.ligado ? " · ligado" : ""}`;
      if (sub.textContent !== textoSub) sub.textContent = textoSub;
      const badge = li.querySelector(".status-badge");
      const textoBadge = s.online ? "online" : "offline";
      if (badge.textContent !== textoBadge) badge.textContent = textoBadge;
      const classeBadge = `status-badge ${s.online ? "on" : "off"}`;
      if (badge.className !== classeBadge) badge.className = classeBadge;
    },
  });
}

function iniciarAutoRefreshRooms(somenteSeJaCarregado) {
  if (
    somenteSeJaCarregado &&
    (!_roomsBlocoAtual || !_roomsAndarAtual || _roomsBlocoAtual !== state.bloco || String(_roomsAndarAtual) !== String(state.andar))
  ) {
    return;
  }
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

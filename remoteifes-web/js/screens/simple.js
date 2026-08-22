const SimpleWizard = {
  bloco: null,
  andar: null,
  _pararSalas: null,

  irParaBloco() {
    this.pararAutoRefresh();
    this.bloco = null;
    this.andar = null;
    document.getElementById("simpleStepBloco").classList.remove("hidden");
    document.getElementById("simpleStepAndar").classList.add("hidden");
    document.getElementById("simpleStepSala").classList.add("hidden");
  },

  irParaAndar(bloco) {
    this.pararAutoRefresh();
    this.bloco = bloco;
    document.getElementById("simpleAndarTitulo").textContent = `Bloco ${bloco} — escolha o andar`;
    document.getElementById("simpleStepBloco").classList.add("hidden");
    document.getElementById("simpleStepAndar").classList.remove("hidden");
    document.getElementById("simpleStepSala").classList.add("hidden");
  },

  async irParaSala(andar) {
    this.andar = andar;
    document.getElementById("simpleSalaTitulo").textContent = `Bloco ${this.bloco} — ${andar}º andar`;
    document.getElementById("simpleStepBloco").classList.add("hidden");
    document.getElementById("simpleStepAndar").classList.add("hidden");
    document.getElementById("simpleStepSala").classList.remove("hidden");
    await this.carregarSalas();
    this.iniciarAutoRefresh();
  },

  iniciarAutoRefresh() {
    this.pararAutoRefresh();
    this._pararSalas = RTStatus.aoSalas((salas) => this.renderizarSalas(salas));
  },

  pararAutoRefresh() {
    if (this._pararSalas) {
      this._pararSalas();
      this._pararSalas = null;
    }
  },

  async carregarSalas() {
    const salas = await Api.listarSalas({ bloco: this.bloco, andar: this.andar });
    this.renderizarSalas(salas);
  },

  renderizarSalas(salasTodas) {
    const grid = document.getElementById("simpleGridSala");
    const empty = document.getElementById("simpleEmpty");

    const salas = (salasTodas || []).filter(
      (s) => s.bloco === this.bloco && String(s.andar) === String(this.andar)
    );
    if (salas.length === 0) {
      grid.innerHTML = "";
      empty.classList.remove("hidden");
      return;
    }
    empty.classList.add("hidden");

    grid.innerHTML = "";
    salas.forEach((s) => {
      const estado = s.online ? (s.ligado ? "is-ligado" : "is-desligado") : "is-offline";
      const tile = document.createElement("button");
      tile.type = "button";
      tile.className = `simple-tile simple-tile-sala ${estado}${s.agendadaAgora ? " is-reservada" : ""}`;
      tile.innerHTML = `
        <span class="simple-tile-icon">&#10052;&#65039;</span>
        <span class="simple-tile-label">${s.sala}</span>
        <span class="simple-tile-sub">${s.nome}${s.podeControlarEsta === false ? " · visualização" : ""}</span>
      `;
      tile.addEventListener("click", () => openRoom(s.sala, s.nome));
      grid.appendChild(tile);
    });
  },
};

document.querySelectorAll("#simpleGridBloco .simple-tile").forEach((btn) => {
  btn.addEventListener("click", () => SimpleWizard.irParaAndar(btn.dataset.bloco));
});

document.querySelectorAll("#simpleGridAndar .simple-tile").forEach((btn) => {
  btn.addEventListener("click", () => SimpleWizard.irParaSala(btn.dataset.andar));
});

document.getElementById("simpleBackToBlocoBtn").addEventListener("click", () => SimpleWizard.irParaBloco());
document.getElementById("simpleBackToAndarBtn").addEventListener("click", () => SimpleWizard.irParaAndar(SimpleWizard.bloco));

document.getElementById("simpleListBtn").addEventListener("click", () => showScreen("location"));
document.getElementById("simpleFloorplanBtn").addEventListener("click", () => showScreen("floorplan"));

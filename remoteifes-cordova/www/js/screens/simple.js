const SimpleWizard = {
  bloco: null,
  andar: null,
  _pararSalas: null,

  irParaBloco() {
    this.pararAutoRefresh();
    this.bloco = null;
    this.andar = null;
    document.getElementById("simpleScreenTitle").textContent = "Selecione o bloco";
    document.getElementById("simpleStepBloco").classList.remove("hidden");
    document.getElementById("simpleStepAndar").classList.add("hidden");
    document.getElementById("simpleStepSala").classList.add("hidden");
  },

  irParaAndar(bloco) {
    this.pararAutoRefresh();
    this.bloco = bloco;
    document.getElementById("simpleScreenTitle").textContent = "Selecione o andar";
    document.getElementById("simpleAndarTitulo").textContent = `Bloco ${bloco} — escolha o andar`;
    document.getElementById("simpleStepBloco").classList.add("hidden");
    document.getElementById("simpleStepAndar").classList.remove("hidden");
    document.getElementById("simpleStepSala").classList.add("hidden");
  },

  async irParaSala(andar) {
    this.andar = andar;
    document.getElementById("simpleScreenTitle").textContent = "Selecione a sala";
    const grid = document.getElementById("simpleGridSala");
    grid.classList.toggle("is-second-floor", String(andar) === "2");
    grid.classList.toggle("is-bloco-b-second-floor", this.bloco === "B" && String(andar) === "2");
    grid.classList.add("is-loading");
    document.getElementById("simpleSalaTitulo").textContent = `Bloco ${this.bloco} — ${andar}º andar`;
    document.getElementById("simpleStepBloco").classList.add("hidden");
    document.getElementById("simpleStepAndar").classList.add("hidden");
    document.getElementById("simpleStepSala").classList.remove("hidden");
    await this.carregarSalas();
    grid.classList.remove("is-loading");
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

    const secaoPlanta = document.querySelector(`[data-fp-section="${this.bloco.toLowerCase()}-${String(this.andar) === "1" ? "terreo" : `${this.andar}pav`}"]`);
    const rotulosPlanta = new Map();
    if (secaoPlanta) {
      secaoPlanta.querySelectorAll(".room.selectable[data-sala]").forEach((el) => {
        const nome = el.querySelector(".name")?.textContent?.trim();
        if (nome) rotulosPlanta.set(el.dataset.sala, nome);
      });
    }
    if (salas.length === 0) {
      grid.replaceChildren();
      empty.classList.remove("hidden");
      return;
    }
    empty.classList.add("hidden");

    const existentes = new Map();
    grid.querySelectorAll(".simple-tile-sala[data-sala]").forEach((tile) => {
      existentes.set(tile.dataset.sala, tile);
    });

    const fragment = document.createDocumentFragment();
    salas.forEach((s) => {
      let tile = existentes.get(s.sala);
      if (!tile) {
        tile = document.createElement("button");
        tile.type = "button";
        tile.dataset.sala = s.sala;
        tile.innerHTML = `
          <span class="simple-tile-icon">&#10052;&#65039;</span>
          <span class="simple-tile-label"></span>
          <span class="simple-tile-sub"></span>
        `;
        tile.addEventListener("click", () => openRoom(tile.dataset.sala, tile.dataset.nome));
      }

      tile.dataset.nome = s.nome;
      const estado = s.online ? (s.ligado ? "is-ligado" : "is-desligado") : "is-offline";
      tile.className = `simple-tile simple-tile-sala ${estado}${s.agendadaAgora ? " is-reservada" : ""}`;
      const rotuloPlanta = rotulosPlanta.get(s.sala);
      tile.querySelector(".simple-tile-label").textContent = rotuloPlanta || RoomsData.rotulo(s.sala);
      tile.querySelector(".simple-tile-sub").textContent = `${s.nome}${s.podeControlarEsta === false ? " · visualização" : ""}`;
      fragment.appendChild(tile);
      existentes.delete(s.sala);
    });

    grid.replaceChildren(fragment);
  }
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

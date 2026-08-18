const ScreenFloorplan = {
  _instancia: null,
  _intervalId: null,

  async aoAbrir() {
    if (!this._instancia) {
      this._instancia = Floorplan.create(document.getElementById("fpScaleInner"), document.querySelector("#screen-floorplan .fp-tabs"), {
        onSelect: (sala, el) => {
          const nomeEl = el.querySelector(".name");
          const nome = nomeEl ? nomeEl.textContent.trim() : sala;
          openRoom(sala, nome);
        },
      });
    }
    await this.atualizar();
    if (this._intervalId) clearInterval(this._intervalId);
    this._intervalId = setInterval(() => this.atualizar(), 10000);
  },

  aoFechar() {
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
  },

  async atualizar() {
    const salas = await Api.listarSalas();
    if (Array.isArray(salas) && this._instancia) this._instancia.aplicarStatus(salas);
  },
};

document.getElementById("verPlantaBtn").addEventListener("click", () => {
  showScreen("floorplan");
});

document.getElementById("floorplanListBtn").addEventListener("click", () => {
  showScreen("location");
});

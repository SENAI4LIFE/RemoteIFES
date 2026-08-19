const ScreenFloorplan = {
  _instancia: null,
  _intervalId: null,

  async aoAbrir() {
    if (!this._instancia) {
      this._instancia = Floorplan.create(document.getElementById("fpScaleInner"), document.querySelector("#screen-floorplan .fp-tabs"), {
        enableZoom: true,
        onSelect: (sala, el) => {
          const nomeEl = el.querySelector(".name");
          const nome = nomeEl ? nomeEl.textContent.trim() : sala;
          openRoom(sala, nome);
        },
      });

      const zoomFocusBtn = document.getElementById("floorplanZoomFocusBtn");
      const zoomInBtn = document.getElementById("floorplanZoomInBtn");
      const zoomOutBtn = document.getElementById("floorplanZoomOutBtn");
      const zoomResetBtn = document.getElementById("floorplanZoomResetBtn");
      let zoomFocusArmed = false;

      const atualizarZoomFocus = () => {
        if (zoomFocusBtn) zoomFocusBtn.classList.toggle("is-active", zoomFocusArmed);
      };

      if (zoomFocusBtn) zoomFocusBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        zoomFocusArmed = !zoomFocusArmed;
        atualizarZoomFocus();
      });
      if (zoomInBtn) zoomInBtn.addEventListener("click", () => this._instancia.zoomIn());
      if (zoomOutBtn) zoomOutBtn.addEventListener("click", () => this._instancia.zoomOut());
      if (zoomResetBtn) zoomResetBtn.addEventListener("click", () => {
        zoomFocusArmed = false;
        atualizarZoomFocus();
        this._instancia.resetZoom();
      });

      document.getElementById("fpScaleInner").addEventListener("click", (event) => {
        if (!zoomFocusArmed) return;
        event.preventDefault();
        event.stopPropagation();
        this._instancia.zoomToPoint(event.clientX, event.clientY);
        zoomFocusArmed = false;
        atualizarZoomFocus();
      }, true);
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

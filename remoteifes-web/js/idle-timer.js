const IdleTimer = {
  ativo: false,
  timeoutMs: 0,
  avisoMs: 60000,
  prazoFinal: 0,
  avisoMostrado: false,
  intervalId: null,

  iniciar(timeoutMinutos, avisoSegundos) {
    this.parar();
    if (!timeoutMinutos) return; 

    this.ativo = true;
    this.timeoutMs = timeoutMinutos * 60 * 1000;
    this.avisoMs = Math.min((avisoSegundos || 60) * 1000, this.timeoutMs);
    this._renovarPrazo();

    this._onAtividade = () => {
      if (!this.avisoMostrado) this._renovarPrazo();
    };
    ["click", "keydown", "touchstart"].forEach((evt) => {
      document.addEventListener(evt, this._onAtividade, { passive: true });
    });

    this.intervalId = setInterval(() => this._checar(), 1000);
  },

  parar() {
    this.ativo = false;
    this.avisoMostrado = false;
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = null;
    if (this._onAtividade) {
      ["click", "keydown", "touchstart"].forEach((evt) => {
        document.removeEventListener(evt, this._onAtividade);
      });
    }
    document.getElementById("idleModal").classList.add("hidden");
  },

  _renovarPrazo() {
    this.prazoFinal = Date.now() + this.timeoutMs;
  },

  _checar() {
    if (!this.ativo) return;
    const restanteMs = this.prazoFinal - Date.now();

    if (restanteMs <= 0) {
      this.parar();
      window.dispatchEvent(new CustomEvent("app:sessao-expirada"));
      return;
    }

    if (restanteMs <= this.avisoMs) {
      if (!this.avisoMostrado) {
        this.avisoMostrado = true;
        document.getElementById("idleModal").classList.remove("hidden");
      }
      const segundos = Math.ceil(restanteMs / 1000);
      const mm = String(Math.floor(segundos / 60)).padStart(2, "0");
      const ss = String(segundos % 60).padStart(2, "0");
      document.getElementById("idleCountdown").textContent = `${mm}:${ss}`;
    }
  },

  async continuar() {
    this.avisoMostrado = false;
    document.getElementById("idleModal").classList.add("hidden");
    this._renovarPrazo();
    await Api.ping();
  },
};

document.getElementById("idleContinuarBtn").addEventListener("click", () => IdleTimer.continuar());
document.getElementById("idleSairBtn").addEventListener("click", () => {
  IdleTimer.parar();
  window.dispatchEvent(new CustomEvent("app:sessao-expirada"));
});

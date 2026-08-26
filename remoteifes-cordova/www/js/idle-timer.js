const IdleTimer = {
  ativo: false,
  timeoutMs: 0,
  avisoMs: 60000,
  prazoFinal: 0,
  avisoMostrado: false,
  intervalId: null,
  _elementoAnterior: null,

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
    const anterior = this._elementoAnterior;
    this._elementoAnterior = null;
    if (anterior && typeof anterior.focus === "function") anterior.focus();
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
        this._elementoAnterior = document.activeElement;
        document.getElementById("idleModal").classList.remove("hidden");
        document.getElementById("idleContinuarBtn").focus();
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
    const anterior = this._elementoAnterior;
    this._elementoAnterior = null;
    if (anterior && typeof anterior.focus === "function") anterior.focus();
    this._renovarPrazo();
    await Api.ping();
  },
};

document.getElementById("idleContinuarBtn").addEventListener("click", () => IdleTimer.continuar());
document.getElementById("idleSairBtn").addEventListener("click", () => {
  IdleTimer.parar();
  window.dispatchEvent(new CustomEvent("app:sessao-expirada"));
});
document.getElementById("idleModal").addEventListener("keydown", (e) => {
  const modal = document.getElementById("idleModal");
  if (modal.classList.contains("hidden") || e.key !== "Tab") return;
  const focaveis = modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
  if (focaveis.length === 0) return;
  const primeiro = focaveis[0];
  const ultimo = focaveis[focaveis.length - 1];
  if (e.shiftKey && document.activeElement === primeiro) {
    e.preventDefault();
    ultimo.focus();
  } else if (!e.shiftKey && document.activeElement === ultimo) {
    e.preventDefault();
    primeiro.focus();
  }
});

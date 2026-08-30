const IdleTimer = {
  ativo: false,
  avisoMs: 60000,
  prazoServidorMs: 0,
  diferencaServidorMs: 0,
  avisoMostrado: false,
  intervalId: null,
  pingPendente: null,
  ultimoPingMs: 0,
  _elementoAnterior: null,
  _canal: typeof BroadcastChannel === "function" ? new BroadcastChannel("remoteifes-sessao") : null,
  _chaveSincronizacao: "remoteifes_sessao_sync",

  iniciar(sessaoExpiraEm, avisoSegundos, servidorAgora) {
    this.parar();
    if (!sessaoExpiraEm) return;
    this.ativo = true;
    this.avisoMs = Math.max(10000, Number(avisoSegundos || 60) * 1000);
    this._aplicarPrazo(sessaoExpiraEm, servidorAgora);
    this._onAtividade = () => this._registrarAtividade();
    ["pointerdown", "keydown", "touchstart", "mousemove"].forEach((evento) => {
      document.addEventListener(evento, this._onAtividade, { passive: true });
    });
    this.intervalId = setInterval(() => this._checar(), 1000);
    this._checar();
  },

  parar() {
    this.ativo = false;
    this.avisoMostrado = false;
    if (this.intervalId) clearInterval(this.intervalId);
    if (this.pingPendente) clearTimeout(this.pingPendente);
    this.intervalId = null;
    this.pingPendente = null;
    if (this._onAtividade) {
      ["pointerdown", "keydown", "touchstart", "mousemove"].forEach((evento) => {
        document.removeEventListener(evento, this._onAtividade);
      });
    }
    document.getElementById("idleModal").classList.add("hidden");
    document.getElementById("accountSessionTimer").textContent = "";
    const anterior = this._elementoAnterior;
    this._elementoAnterior = null;
    if (anterior && typeof anterior.focus === "function") anterior.focus();
  },

  _agoraServidor() {
    return Date.now() + this.diferencaServidorMs;
  },

  _aplicarPrazo(sessaoExpiraEm, servidorAgora) {
    const prazo = Date.parse(sessaoExpiraEm);
    const agoraServidor = Date.parse(servidorAgora || "");
    if (!Number.isFinite(prazo)) return false;
    if (Number.isFinite(agoraServidor)) this.diferencaServidorMs = agoraServidor - Date.now();
    this.prazoServidorMs = prazo;
    this.avisoMostrado = false;
    document.getElementById("idleModal").classList.add("hidden");
    return true;
  },

  sincronizar(dados, compartilhar = true) {
    if (!dados || !this._aplicarPrazo(dados.sessaoExpiraEm, dados.servidorAgora)) return;
    this.ultimoPingMs = Date.now();
    this._checar();
    if (compartilhar) this._compartilhar({ tipo: "prazo", sessaoExpiraEm: dados.sessaoExpiraEm, servidorAgora: dados.servidorAgora });
  },

  _registrarAtividade() {
    if (!this.ativo || this.avisoMostrado || this.pingPendente) return;
    const espera = Math.max(0, 15000 - (Date.now() - this.ultimoPingMs));
    this.pingPendente = setTimeout(async () => {
      this.pingPendente = null;
      const resposta = await Api.ping();
      if (resposta && resposta.ok) this.sincronizar(resposta);
    }, espera);
  },

  _formatar(restanteMs) {
    const segundos = Math.max(0, Math.ceil(restanteMs / 1000));
    if (segundos >= 3600) return `${Math.floor(segundos / 3600)}h ${Math.floor((segundos % 3600) / 60)}m`;
    return `${String(Math.floor(segundos / 60)).padStart(2, "0")}:${String(segundos % 60).padStart(2, "0")}`;
  },

  _checar() {
    if (!this.ativo) return;
    const restanteMs = this.prazoServidorMs - this._agoraServidor();
    document.getElementById("accountSessionTimer").textContent = this._formatar(restanteMs);
    if (restanteMs <= 0) {
      this._compartilhar({ tipo: "expirada" });
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
      document.getElementById("idleCountdown").textContent = this._formatar(restanteMs);
    }
  },

  async continuar() {
    const resposta = await Api.ping();
    if (!resposta || !resposta.ok) return;
    this.sincronizar(resposta);
    const anterior = this._elementoAnterior;
    this._elementoAnterior = null;
    if (anterior && typeof anterior.focus === "function") anterior.focus();
  },

  _compartilhar(mensagem) {
    if (this._canal) this._canal.postMessage(mensagem);
    try { localStorage.setItem(this._chaveSincronizacao, JSON.stringify({ ...mensagem, id: Date.now() })); } catch (erro) {}
  },

  _receber(mensagem) {
    if (!mensagem || !this.ativo) return;
    if (mensagem.tipo === "prazo") this.sincronizar(mensagem, false);
    if (mensagem.tipo === "expirada") window.dispatchEvent(new CustomEvent("app:sessao-expirada"));
  },
};

if (IdleTimer._canal) IdleTimer._canal.addEventListener("message", (evento) => IdleTimer._receber(evento.data));
window.addEventListener("storage", (evento) => {
  if (evento.key !== IdleTimer._chaveSincronizacao || !evento.newValue) return;
  try { IdleTimer._receber(JSON.parse(evento.newValue)); } catch (erro) {}
});
document.getElementById("idleContinuarBtn").addEventListener("click", () => IdleTimer.continuar());
document.getElementById("idleSairBtn").addEventListener("click", () => {
  IdleTimer._compartilhar({ tipo: "expirada" });
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

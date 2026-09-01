const Notificacoes = {
  _intervalId: null,

  iniciar() {
    this.pararPolling();
    document.getElementById("notifWrap").classList.remove("hidden");
    this.atualizarContagem();
    this._intervalId = setInterval(() => this.atualizarContagem(), 20000);
  },

  pararPolling() {
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
    document.getElementById("notifPanel").classList.add("hidden");
    document.getElementById("notifWrap").classList.add("hidden");
    this.sincronizarSino();
  },

  async atualizarContagem() {
    const resp = await Api.contarNotificacoesNaoLidas();
    const dot = document.getElementById("notifDot");
    if (resp && typeof resp.naoLidas === "number") {
      dot.classList.toggle("hidden", resp.naoLidas === 0);
    }
  },

  formatarHora(criadoEm) {
    if (!criadoEm) return "";
    return criadoEm.replace("T", " ").slice(0, 16);
  },

  async renderizar(lista, empty) {
    const notificacoes = await Api.listarNotificacoes();
    lista.innerHTML = "";
    if (!Array.isArray(notificacoes) || notificacoes.length === 0) {
      empty.classList.remove("hidden");
      return;
    }

    empty.classList.add("hidden");
    notificacoes.forEach((n) => {
      const li = document.createElement("li");
      li.className = `notif-item${n.lida ? "" : " nao-lida"}`;
      li.innerHTML = `
        <button type="button" class="notif-item-action">
          <span class="notif-item-msg">${escapeHtml(n.mensagem)}</span>
          <span class="notif-item-hora">${escapeHtml(this.formatarHora(n.criadoEm))}</span>
        </button>
      `;
      li.dataset.notificacaoId = String(n.id);
      li.querySelector("button").addEventListener("click", async () => {
        if (!n.lida) {
          await Api.marcarNotificacaoLida(n.id);
          document.querySelectorAll(`.notif-item[data-notificacao-id="${n.id}"]`).forEach((el) => el.classList.remove("nao-lida"));
          this.atualizarContagem();
        }
      });
      lista.appendChild(li);
    });
  },

  async carregarAdmin() {
    await this.renderizar(document.getElementById("adminNotifList"), document.getElementById("adminNotifEmpty"));
  },

  // Os dois popovers de rodape sao mutuamente exclusivos: abrir um fecha o outro.
  async abrirPainel() {
    const painel = document.getElementById("notifPanel");
    if (!painel) return;
    if (typeof Relatos !== "undefined") Relatos.fecharPainel();
    await this.renderizar(document.getElementById("notifList"), document.getElementById("notifEmpty"));
    painel.classList.remove("hidden");
    this.sincronizarSino();
  },

  fecharPainel() {
    const painel = document.getElementById("notifPanel");
    if (painel) painel.classList.add("hidden");
    this.sincronizarSino();
  },

  estaAberto() {
    const painel = document.getElementById("notifPanel");
    return !!painel && !painel.classList.contains("hidden");
  },

  async alternarPainel() {
    if (this.estaAberto()) this.fecharPainel();
    else await this.abrirPainel();
  },

  sincronizarSino() {
    const painel = document.getElementById("notifPanel");
    const sino = document.getElementById("notifBellBtn");
    if (painel && sino) sino.setAttribute("aria-expanded", String(!painel.classList.contains("hidden")));
  },
};

document.getElementById("notifBellBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  Notificacoes.alternarPainel();
});

document.getElementById("notifMarcarTodasBtn").addEventListener("click", async (e) => {
  e.stopPropagation();
  await Api.marcarTodasNotificacoesLidas();
  document.querySelectorAll(".notif-item.nao-lida").forEach((el) => el.classList.remove("nao-lida"));
  Notificacoes.atualizarContagem();
});

document.getElementById("adminNotifMarcarTodasBtn").addEventListener("click", async () => {
  await Api.marcarTodasNotificacoesLidas();
  document.querySelectorAll(".notif-item.nao-lida").forEach((el) => el.classList.remove("nao-lida"));
  Notificacoes.atualizarContagem();
});

document.getElementById("notifPanel").addEventListener("click", (e) => e.stopPropagation());

document.addEventListener("click", () => Notificacoes.fecharPainel());

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !Notificacoes.estaAberto()) return;
  Notificacoes.fecharPainel();
  const sino = document.getElementById("notifBellBtn");
  if (sino) sino.focus();
});

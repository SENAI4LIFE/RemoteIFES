const Notificacoes = {
  _intervalId: null,

  iniciar() {
    this.pararPolling();
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

  async abrirPainel() {
    const lista = document.getElementById("notifList");
    const empty = document.getElementById("notifEmpty");
    const notificacoes = await Api.listarNotificacoes();

    lista.innerHTML = "";
    if (!Array.isArray(notificacoes) || notificacoes.length === 0) {
      empty.classList.remove("hidden");
    } else {
      empty.classList.add("hidden");
      notificacoes.forEach((n) => {
        const li = document.createElement("li");
        li.className = `notif-item${n.lida ? "" : " nao-lida"}`;
        li.innerHTML = `
          <div class="notif-item-msg">${escapeHtml(n.mensagem)}</div>
          <div class="notif-item-hora">${escapeHtml(this.formatarHora(n.criadoEm))}</div>
        `;
        li.addEventListener("click", async () => {
          if (!n.lida) {
            await Api.marcarNotificacaoLida(n.id);
            li.classList.remove("nao-lida");
            this.atualizarContagem();
          }
        });
        lista.appendChild(li);
      });
    }

    document.getElementById("notifPanel").classList.toggle("hidden");
  },
};

document.getElementById("notifBellBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  Notificacoes.abrirPainel();
});

document.getElementById("notifMarcarTodasBtn").addEventListener("click", async (e) => {
  e.stopPropagation();
  await Api.marcarTodasNotificacoesLidas();
  document.querySelectorAll(".notif-item.nao-lida").forEach((el) => el.classList.remove("nao-lida"));
  Notificacoes.atualizarContagem();
});

document.getElementById("notifPanel").addEventListener("click", (e) => e.stopPropagation());

document.addEventListener("click", () => {
  document.getElementById("notifPanel").classList.add("hidden");
});

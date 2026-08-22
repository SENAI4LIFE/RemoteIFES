const ScreenPropriedade = {
  _salas: [],

  async aoAbrir() {
    const select = document.getElementById("propriedadeSala");
    const salaAnterior = select.value;

    this._salas = await Api.minhasSalasPropriedade();
    if (!Array.isArray(this._salas)) this._salas = [];

    select.innerHTML = this._salas
      .map((s) => `<option value="${s.sala}">${s.sala} — ${s.nome}</option>`)
      .join("");

    if (this._salas.length === 0) {
      document.getElementById("propriedadeAvisoRestricao").classList.add("hidden");
      document.getElementById("propriedadeUsuarioSelect").innerHTML = "";
      document.getElementById("propriedadeUsuariosList").innerHTML = "";
      document.getElementById("propriedadeUsuariosEmpty").classList.remove("hidden");
      document.getElementById("propriedadeUsuariosEmpty").textContent =
        "você ainda não é proprietário de nenhuma sala";
      return;
    }

    if (salaAnterior && this._salas.some((s) => s.sala === salaAnterior)) {
      select.value = salaAnterior;
    }

    await this.carregar(select.value);
  },

  async carregar(sala) {
    if (!sala) return;
    const info = this._salas.find((s) => s.sala === sala);
    document.getElementById("propriedadeAvisoRestricao").classList.toggle(
      "hidden",
      !info || info.acessoRestrito
    );

    const candidatos = await Api.listarCandidatosPropriedade(sala);
    const selectCandidatos = document.getElementById("propriedadeUsuarioSelect");
    if (Array.isArray(candidatos)) {
      selectCandidatos.innerHTML = candidatos
        .map((u) => `<option value="${u.id}">${u.nome} (@${u.usuario})</option>`)
        .join("");
    } else {
      selectCandidatos.innerHTML = "";
    }

    const usuariosComAcesso = await Api.listarAcessoPropriedade(sala);
    this.renderUsuarios(sala, Array.isArray(usuariosComAcesso) ? usuariosComAcesso : []);
  },

  renderUsuarios(sala, usuarios) {
    const list = document.getElementById("propriedadeUsuariosList");
    const empty = document.getElementById("propriedadeUsuariosEmpty");
    list.innerHTML = "";

    if (usuarios.length === 0) {
      empty.textContent = "nenhum usuário com acesso concedido ainda";
      empty.classList.remove("hidden");
      return;
    }
    empty.classList.add("hidden");

    usuarios.forEach((u) => {
      const li = document.createElement("li");
      li.innerHTML = `
        <div class="room-name">${u.nome} <span class="room-sub">@${u.usuario}</span></div>
        <button type="button" class="link-btn danger revogar-acesso-propriedade">revogar</button>
      `;
      li.querySelector(".revogar-acesso-propriedade").addEventListener("click", async () => {
        const resp = await Api.revogarAcessoPropriedade(sala, u.id);
        if (resp.ok) this.renderUsuarios(sala, resp.usuarios);
      });
      list.appendChild(li);
    });
  },
};

document.getElementById("propriedadeSala").addEventListener("change", (e) => {
  ScreenPropriedade.carregar(e.target.value);
});

document.getElementById("propriedadeConcederBtn").addEventListener("click", async () => {
  const sala = document.getElementById("propriedadeSala").value;
  const select = document.getElementById("propriedadeUsuarioSelect");
  const errorEl = document.getElementById("propriedadeError");
  errorEl.classList.add("hidden");

  if (!sala || !select.value) return;

  const resp = await Api.concederAcessoPropriedade(sala, Number(select.value));
  if (!resp.ok) {
    errorEl.textContent = resp.erro || "não foi possível conceder o acesso";
    errorEl.classList.remove("hidden");
    return;
  }
  ScreenPropriedade.renderUsuarios(sala, resp.usuarios);
});

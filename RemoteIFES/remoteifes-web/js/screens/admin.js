const Admin = {
  async aoAbrir() {
    await this.carregarUsuarios();
  },

  async carregarUsuarios() {
    const list = document.getElementById("usuariosList");
    list.innerHTML = "";
    const usuarios = await Api.listarUsuarios();

    usuarios.forEach((u) => {
      const li = document.createElement("li");
      li.innerHTML = `
        <div>
          <div class="room-name">${u.nome} ${u.isAdmin ? "· admin" : ""}</div>
          <div class="room-sub">
            @${u.usuario} ·
            ${u.ativo ? "ativo" : "desativado"}
            ${!u.isAdmin ? `· controlar: ${u.podeControlar ? "sim" : "não"} · agendar: ${u.podeAgendar ? "sim" : "não"}` : ""}
          </div>
        </div>
        ${u.isAdmin ? "" : `
          <div class="agenda-actions">
            <button type="button" class="link-btn toggle-controlar">${u.podeControlar ? "revogar controle" : "conceder controle"}</button>
            <button type="button" class="link-btn toggle-agendar">${u.podeAgendar ? "revogar agenda" : "conceder agenda"}</button>
            <button type="button" class="link-btn toggle-ativo">${u.ativo ? "desativar" : "reativar"}</button>
            <button type="button" class="link-btn danger remover-usuario">remover</button>
          </div>
        `}
      `;

      if (!u.isAdmin) {
        li.querySelector(".toggle-controlar").addEventListener("click", async () => {
          await Api.atualizarUsuario(u.id, { podeControlar: !u.podeControlar });
          await this.carregarUsuarios();
        });
        li.querySelector(".toggle-agendar").addEventListener("click", async () => {
          await Api.atualizarUsuario(u.id, { podeAgendar: !u.podeAgendar });
          await this.carregarUsuarios();
        });
        li.querySelector(".toggle-ativo").addEventListener("click", async () => {
          await Api.atualizarUsuario(u.id, { ativo: !u.ativo });
          await this.carregarUsuarios();
        });
        li.querySelector(".remover-usuario").addEventListener("click", async () => {
          if (!confirm(`Remover o usuário ${u.nome}? Esta ação não pode ser desfeita.`)) return;
          await Api.removerUsuario(u.id);
          await this.carregarUsuarios();
        });
      }

      list.appendChild(li);
    });
  },

  async carregarSessoes() {
    const list = document.getElementById("sessoesList");
    const empty = document.getElementById("sessoesEmpty");
    list.innerHTML = "";

    const sessoes = await Api.listarSessoesAtivas();
    if (sessoes.length === 0) {
      empty.classList.remove("hidden");
      return;
    }
    empty.classList.add("hidden");

    sessoes.forEach((s) => {
      const li = document.createElement("li");
      li.innerHTML = `
        <div>
          <div class="room-name">${s.nome} ${s.isAdmin ? "· admin" : ""}</div>
          <div class="room-sub">@${s.usuario} · último uso: ${s.ultimoUso}</div>
        </div>
      `;
      list.appendChild(li);
    });
  },

  async carregarLogs() {
    const list = document.getElementById("logsList");
    list.innerHTML = "";

    const logs = await Api.listarLogs();
    logs.forEach((l) => {
      const li = document.createElement("li");
      li.innerHTML = `
        <div>
          <div class="room-name">${l.sala} · ${l.cmd}${l.valor !== null ? ` (${l.valor})` : ""}</div>
          <div class="room-sub">${l.usuario || "sistema"} · ${l.origem} · ${l.criadoEm}</div>
        </div>
      `;
      list.appendChild(li);
    });
  },
};

document.getElementById("criarUsuarioBtn").addEventListener("click", async () => {
  const errorEl = document.getElementById("usuarioError");
  errorEl.classList.add("hidden");

  const dados = {
    usuario: document.getElementById("novoUsuarioLogin").value.trim(),
    nome: document.getElementById("novoUsuarioNome").value.trim(),
    senha: document.getElementById("novoUsuarioSenha").value,
    podeControlar: document.getElementById("novoUsuarioControlar").checked,
    podeAgendar: document.getElementById("novoUsuarioAgendar").checked,
  };

  if (!dados.usuario || !dados.nome || !dados.senha) {
    errorEl.textContent = "preencha usuário, nome e senha";
    errorEl.classList.remove("hidden");
    return;
  }

  const resp = await Api.criarUsuario(dados);
  if (!resp.ok) {
    errorEl.textContent = resp.erro || "não foi possível criar o usuário";
    errorEl.classList.remove("hidden");
    return;
  }

  document.getElementById("novoUsuarioLogin").value = "";
  document.getElementById("novoUsuarioNome").value = "";
  document.getElementById("novoUsuarioSenha").value = "";
  await Admin.carregarUsuarios();
});

document.querySelectorAll(".admin-subtab-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    document.querySelectorAll(".admin-subtab-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");

    document.querySelectorAll(".admin-sub").forEach((el) => el.classList.add("hidden"));
    const sub = btn.dataset.sub;
    document.getElementById(`adminSub-${sub}`).classList.remove("hidden");

    if (sub === "sessoes") await Admin.carregarSessoes();
    if (sub === "logs") await Admin.carregarLogs();
  });
});

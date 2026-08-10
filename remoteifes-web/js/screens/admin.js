const Admin = {
  async aoAbrir() {
    document.getElementById("novoUsuarioAdminLabel").classList.toggle("hidden", !state.isSuperAdmin);
    await this.carregarUsuarios();
  },

  async carregarUsuarios() {
    const list = document.getElementById("usuariosList");
    list.innerHTML = "";
    const usuarios = await Api.listarUsuarios();

    usuarios.forEach((u) => {
      const souSuperAdmin = state.isSuperAdmin;
      const podeRebaixar = u.isAdmin && !u.isSuperAdmin && souSuperAdmin;
      const podePromover = !u.isAdmin && souSuperAdmin;
      const podeEditar = !u.isSuperAdmin;
      const podeVerOuTrocarSenha = !u.isSuperAdmin || souSuperAdmin;
      const podeGerenciarAtivoAdmin = u.isAdmin && !u.isSuperAdmin && souSuperAdmin;

      const li = document.createElement("li");
      li.innerHTML = `
        <div>
          <div class="room-name">${u.nome} ${u.isSuperAdmin ? "· admin principal" : u.isAdmin ? "· admin" : ""}</div>
          <div class="room-sub">
            @${u.usuario}
            ${!u.ativo ? "· desativado" : ""}
            ${!u.isAdmin ? `· controlar: ${u.podeControlar ? "sim" : "não"} · agendar: ${u.podeAgendar ? "sim" : "não"}` : ""}
          </div>
        </div>
        <div class="agenda-actions">
          ${podeVerOuTrocarSenha ? `<button type="button" class="link-btn trocar-senha">trocar senha</button>` : ""}
          ${podeEditar ? `<button type="button" class="link-btn trocar-login">trocar login</button>` : ""}
          ${podePromover ? `<button type="button" class="link-btn conceder-admin">conceder admin</button>` : ""}
          ${podeRebaixar ? `<button type="button" class="link-btn danger revogar-admin">revogar admin</button>` : ""}
          ${podeGerenciarAtivoAdmin ? `<button type="button" class="link-btn toggle-ativo-admin">${u.ativo ? "desativar" : "reativar"}</button>` : ""}
          ${!u.isAdmin ? `
            <button type="button" class="link-btn toggle-controlar">${u.podeControlar ? "revogar controle" : "conceder controle"}</button>
            <button type="button" class="link-btn toggle-agendar">${u.podeAgendar ? "revogar agenda" : "conceder agenda"}</button>
            <button type="button" class="link-btn toggle-ativo">${u.ativo ? "desativar" : "reativar"}</button>
            <button type="button" class="link-btn danger remover-usuario">remover</button>
          ` : ""}
        </div>
      `;

      if (podeVerOuTrocarSenha) {
        li.querySelector(".trocar-senha").addEventListener("click", async () => {
          const nova = prompt(`Nova senha para ${u.nome}:`);
          if (!nova) return;
          const resp = await Api.trocarSenhaUsuario(u.id, nova);
          if (!resp.ok) alert(resp.erro || "não foi possível trocar a senha");
        });
      }

      if (podeEditar) {
        li.querySelector(".trocar-login").addEventListener("click", async () => {
          const novoLogin = prompt(`Novo login para ${u.nome}:`, u.usuario);
          if (!novoLogin) return;
          const resp = await Api.trocarLoginUsuario(u.id, novoLogin.trim());
          if (!resp.ok) {
            alert(resp.erro || "não foi possível trocar o login");
            return;
          }
          await this.carregarUsuarios();
        });
      }

      if (podePromover) {
        li.querySelector(".conceder-admin").addEventListener("click", async () => {
          if (!confirm(`Conceder permissão de administrador para ${u.nome}?`)) return;
          const resp = await Api.atualizarUsuario(u.id, { isAdmin: true });
          if (!resp.ok) alert(resp.erro || "não foi possível conceder admin");
          await this.carregarUsuarios();
        });
      }

      if (podeRebaixar) {
        li.querySelector(".revogar-admin").addEventListener("click", async () => {
          if (!confirm(`Remover permissão de administrador de ${u.nome}?`)) return;
          const resp = await Api.atualizarUsuario(u.id, { isAdmin: false });
          if (!resp.ok) alert(resp.erro || "não foi possível revogar admin");
          await this.carregarUsuarios();
        });
      }

      if (podeGerenciarAtivoAdmin) {
        li.querySelector(".toggle-ativo-admin").addEventListener("click", async () => {
          const resp = await Api.atualizarUsuario(u.id, { ativo: !u.ativo });
          if (!resp.ok) alert(resp.erro || "não foi possível alterar o status do administrador");
          await this.carregarUsuarios();
        });
      }

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

  async carregarAtivos() {
    const list = document.getElementById("ativosList");
    const empty = document.getElementById("ativosEmpty");
    list.innerHTML = "";
    if (this._ativosIntervalId) clearInterval(this._ativosIntervalId);

    const usuarios = await Api.listarUsuariosAtivos();
    if (usuarios.length === 0) {
      empty.classList.remove("hidden");
      return;
    }
    empty.classList.add("hidden");

    usuarios.forEach((u) => {
      const li = document.createElement("li");
      const rotulo = { online: "online", inativo: "inativo", offline: "offline" }[u.status];
      li.innerHTML = `
        <div>
          <div class="room-name">
            ${u.nome} ${u.isAdmin ? "· admin" : ""}
            ${u.sessaoLoginEm ? `<span class="session-timer" data-login="${u.sessaoLoginEm}">00:00</span>` : ""}
          </div>
          <div class="room-sub">@${u.usuario} · último acesso: ${Tempo.formatarDataHora(u.ultimoAcesso)}</div>
        </div>
        <span class="status-badge ${u.status === "online" ? "on" : u.status === "inativo" ? "inativo" : "off"}">${rotulo}</span>
      `;
      list.appendChild(li);
    });

    const atualizarTimers = () => {
      document.querySelectorAll("#ativosList .session-timer").forEach((el) => {
        const loginMs = Tempo.paraEpochMs(el.dataset.login);
        if (loginMs == null) return;
        el.textContent = Tempo.formatarDuracao((Date.now() - loginMs) / 1000);
      });
    };
    atualizarTimers();
    this._ativosIntervalId = setInterval(atualizarTimers, 1000);
  },

  async carregarSessoes(data) {
    const list = document.getElementById("sessoesList");
    list.innerHTML = "";
    const sessoes = await Api.listarHistoricoSessoes(data);
    sessoes.forEach((s) => {
      const li = document.createElement("li");
      li.innerHTML = `
        <div>
          <div class="room-name">
            ${s.nome} (@${s.usuario})
            <span class="session-timer ${s.emAndamento ? "" : "encerrada"}">${Tempo.formatarDuracao(s.duracaoSegundos)}</span>
          </div>
          <div class="room-sub">
            login: ${Tempo.formatarDataHora(s.login)} ·
            logout: ${s.logout ? Tempo.formatarDataHora(s.logout) : "ainda conectado"}
          </div>
        </div>
      `;
      list.appendChild(li);
    });
  },

  async carregarLogs(data) {
    const list = document.getElementById("logsList");
    list.innerHTML = "";
    const logs = await Api.listarLogs(data);
    logs.forEach((l) => {
      const li = document.createElement("li");
      li.innerHTML = `
        <div>
          <div class="room-name">${l.sala} · ${l.cmd}${l.valor !== null ? ` (${l.valor})` : ""}</div>
          <div class="room-sub">${l.usuario || "sistema"} · ${l.origem} · ${Tempo.formatarDataHora(l.criadoEm)}</div>
        </div>
      `;
      list.appendChild(li);
    });
  },

  async carregarDispositivos(data) {
    const list = document.getElementById("dispositivosList");
    list.innerHTML = "";
    const eventos = await Api.listarDispositivos({ data });
    eventos.forEach((e) => {
      const li = document.createElement("li");
      li.innerHTML = `
        <div>
          <div class="room-name">${e.sala}</div>
          <div class="room-sub">${e.status === "online" ? "ficou online" : "ficou offline"} · ${Tempo.formatarDataHora(e.criadoEm)}</div>
        </div>
        <span class="status-badge ${e.status === "online" ? "on" : "off"}">${e.status}</span>
      `;
      list.appendChild(li);
    });
  },

  async carregarMapa() {
    const grid = document.getElementById("mapaGrid");
    grid.innerHTML = "";
    const salas = await Api.listarSalas();
    salas.forEach((s) => {
      const div = document.createElement("div");
      const estado = !s.online ? "offline" : (s.ligado ? "online-ligado" : "online-desligado");
      div.className = `mapa-cell mapa-${estado}${s.agendadaAgora ? " mapa-reservada" : ""}`;
      div.title = `${s.sala} — ${s.online ? (s.ligado ? "online, ligado" : "online, desligado") : "offline (comando enviado pode ainda não ter sido confirmado pelo dispositivo)"}${s.agendadaAgora ? " · reservada agora" : ""}`;
      div.textContent = s.sala;
      grid.appendChild(div);
    });
  },

  async carregarConfiguracoes() {
    const resp = await Api.obterConfiguracoes();
    if (!resp.ok) return;
    const cfg = resp.configuracoes;
    document.getElementById("cfgTimeoutInatividade").value = cfg.timeoutInatividadeMinutos ?? "";
    document.getElementById("cfgTimeoutInatividade").placeholder = `indefinido (sugestão: ${cfg.timeoutInatividadeMinutosSugestao} min)`;
    document.getElementById("cfgAdminSujeitoTimeout").checked = !!cfg.adminSujeitoTimeout;
    document.getElementById("cfgPopupAviso").value = cfg.popupAvisoSegundos;
    document.getElementById("cfgLimiarOnline").value = cfg.limiarOnlineMinutos;
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
    isAdmin: state.isSuperAdmin && document.getElementById("novoUsuarioAdmin").checked,
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
  document.getElementById("novoUsuarioAdmin").checked = false;
  await Admin.carregarUsuarios();
});

document.querySelectorAll(".admin-subtab-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    document.querySelectorAll(".admin-subtab-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");

    document.querySelectorAll(".admin-sub").forEach((el) => el.classList.add("hidden"));
    const sub = btn.dataset.sub;
    document.getElementById(`adminSub-${sub}`).classList.remove("hidden");

    if (sub !== "ativos" && Admin._ativosIntervalId) {
      clearInterval(Admin._ativosIntervalId);
      Admin._ativosIntervalId = null;
    }

    if (sub === "ativos") await Admin.carregarAtivos();
    if (sub === "sessoes") await Admin.carregarSessoes();
    if (sub === "logs") await Admin.carregarLogs();
    if (sub === "dispositivos") await Admin.carregarDispositivos();
    if (sub === "mapa") await Admin.carregarMapa();
    if (sub === "config") await Admin.carregarConfiguracoes();
  });
});

document.getElementById("salvarConfigBtn").addEventListener("click", async () => {
  const errorEl = document.getElementById("configError");
  const savedEl = document.getElementById("configSavedHint");
  errorEl.classList.add("hidden");
  savedEl.classList.add("hidden");

  const timeoutVal = document.getElementById("cfgTimeoutInatividade").value.trim();
  const dados = {
    timeoutInatividadeMinutos: timeoutVal === "" ? null : Number(timeoutVal),
    adminSujeitoTimeout: document.getElementById("cfgAdminSujeitoTimeout").checked,
    popupAvisoSegundos: Number(document.getElementById("cfgPopupAviso").value),
    limiarOnlineMinutos: Number(document.getElementById("cfgLimiarOnline").value),
  };

  const resp = await Api.atualizarConfiguracoes(dados);
  if (!resp.ok) {
    errorEl.textContent = resp.erro || "não foi possível salvar as configurações";
    errorEl.classList.remove("hidden");
    return;
  }

  savedEl.classList.remove("hidden");

  const timeoutEfetivo = state.isAdmin && !resp.configuracoes.adminSujeitoTimeout
    ? null
    : resp.configuracoes.timeoutInatividadeMinutos;
  IdleTimer.iniciar(timeoutEfetivo, resp.configuracoes.popupAvisoSegundos);
});

document.getElementById("sessoesFiltroData").addEventListener("change", (e) => {
  Admin.carregarSessoes(e.target.value || undefined);
});

document.getElementById("logsFiltroData").addEventListener("change", (e) => {
  Admin.carregarLogs(e.target.value || undefined);
});

document.getElementById("logsApagarData").addEventListener("click", async () => {
  const data = document.getElementById("logsFiltroData").value;
  if (!data) {
    alert("selecione uma data para apagar os logs daquele dia");
    return;
  }
  if (!confirm(`Apagar todos os logs do dia ${data}?`)) return;
  await Api.apagarLogs(data);
  await Admin.carregarLogs(data);
});

document.getElementById("logsApagarTudo").addEventListener("click", async () => {
  if (!confirm("Apagar TODOS os logs do banco de dados? Esta ação não pode ser desfeita.")) return;
  await Api.apagarLogs();
  await Admin.carregarLogs(document.getElementById("logsFiltroData").value || undefined);
});

document.getElementById("dispositivosFiltroData").addEventListener("change", (e) => {
  Admin.carregarDispositivos(e.target.value || undefined);
});

document.getElementById("sessoesApagarData").addEventListener("click", async () => {
  const data = document.getElementById("sessoesFiltroData").value;
  if (!data) {
    alert("selecione uma data para apagar o histórico daquele dia");
    return;
  }
  if (!confirm(`Apagar o histórico de sessões do dia ${data}?`)) return;
  await Api.apagarHistoricoSessoes(data);
  await Admin.carregarSessoes(data);
});

document.getElementById("sessoesApagarTudo").addEventListener("click", async () => {
  if (!confirm("Apagar TODO o histórico de sessões? Esta ação não pode ser desfeita.")) return;
  await Api.apagarHistoricoSessoes();
  await Admin.carregarSessoes(document.getElementById("sessoesFiltroData").value || undefined);
});

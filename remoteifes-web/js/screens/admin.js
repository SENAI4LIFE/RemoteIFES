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
            ${!u.isAdmin ? `· controlar: ${u.podeControlar ? "sim" : "não"}` : ""}
          </div>
        </div>
        <div class="agenda-actions">
          ${podeVerOuTrocarSenha ? `<button type="button" class="link-btn trocar-senha">trocar senha</button>` : ""}
          ${podeEditar ? `<button type="button" class="link-btn trocar-nome">trocar nome</button>` : ""}
          ${podeEditar ? `<button type="button" class="link-btn trocar-login">trocar login</button>` : ""}
          ${podePromover ? `<button type="button" class="link-btn conceder-admin">conceder admin</button>` : ""}
          ${podeRebaixar ? `<button type="button" class="link-btn danger revogar-admin">revogar admin</button>` : ""}
          ${podeGerenciarAtivoAdmin ? `<button type="button" class="link-btn toggle-ativo-admin">${u.ativo ? "desativar" : "reativar"}</button>` : ""}
          ${!u.isAdmin ? `
            <button type="button" class="link-btn toggle-controlar">${u.podeControlar ? "revogar controle" : "conceder controle"}</button>
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
        li.querySelector(".trocar-nome").addEventListener("click", async () => {
          const novoNome = prompt(`Novo nome para ${u.nome}:`, u.nome);
          if (!novoNome) return;
          const resp = await Api.trocarNomeUsuario(u.id, novoNome.trim());
          if (!resp.ok) {
            alert(resp.erro || "não foi possível trocar o nome");
            return;
          }
          await this.carregarUsuarios();
        });

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

  async carregarAcessos(data) {
    const list = document.getElementById("acessosList");
    list.innerHTML = "";
    const acessos = await Api.listarAcessosEsp({ data });
    acessos.forEach((a) => {
      const li = document.createElement("li");
      li.innerHTML = `
        <div>
          <div class="room-name">${a.sala}</div>
          <div class="room-sub">${a.ip || "IP desconhecido"} · ${Tempo.formatarDataHora(a.criadoEm)}</div>
        </div>
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
      // Salas combinadas (ex.: "B-105-B-106", dois códigos unidos por um traço) são exibidas
      // em duas linhas, sem o traço do meio, em vez do texto corrido.
      const combinada = s.sala.match(/^([A-Za-z]+-\d+[a-z]?)-([A-Za-z]+-\d+[a-z]?)$/);
      if (combinada) {
        div.classList.add("mapa-cell-dupla");
        const l1 = document.createElement("span");
        l1.textContent = combinada[1];
        const l2 = document.createElement("span");
        l2.textContent = combinada[2];
        div.append(l1, l2);
      } else {
        div.textContent = s.sala;
      }
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

    if (state.isSuperAdmin) {
      document.getElementById("cfgTemperaturaMinima").value = cfg.temperaturaMinima;
      document.getElementById("cfgTemperaturaMaxima").value = cfg.temperaturaMaxima;
      document.getElementById("cfgModoTeste").checked = !!cfg.modoTeste;
      document.getElementById("cfgRedesAutorizadas").value = (cfg.redesAutorizadas || []).join("\n");
    }
  },

  async carregarMacs() {
    const list = document.getElementById("macsList");
    const searchInput = document.getElementById("macsSearchInput");
    list.innerHTML = "";
    searchInput.value = "";
    document.getElementById("macsListEmpty").classList.add("hidden");
    const salas = await Api.listarSalasAdmin();
    const presets = await Api.listarPresets();
    const usuarios = await Api.listarUsuarios();
    const usuariosControlaveis = usuarios.filter((u) => !u.isAdmin);

    for (const s of salas) {
      const li = document.createElement("li");
      li.id = `macCard-${s.sala}`;
      li.innerHTML = `
        <div class="mac-row" style="width:100%">
          <div class="room-name">${s.sala} — ${s.nome} <span class="status-badge ${s.online ? "on" : "off"}">${s.online ? "online" : "offline"}</span></div>
          <label>Endereço MAC do ESP32</label>
          <input type="text" class="mac-input" placeholder="AA:BB:CC:DD:EE:FF" value="${s.mac || ""}" />
          <label>Preset em uso</label>
          <select class="preset-select">
            <option value="">(nenhum: usa o padrão)</option>
            ${presets.map((p) => `<option value="${p.id}" ${s.presetId === p.id ? "selected" : ""}>${p.nome}${p.padrao ? " (padrão)" : ""}</option>`).join("")}
          </select>
          <div class="two-col">
            <button type="button" class="link-btn salvar-mac">salvar MAC</button>
            ${s.ipEsp32 ? `<button type="button" class="link-btn acessar-esp32">acessar interface do ESP32</button>` : `<span class="hint">IP ainda não reportado</span>`}
          </div>
          <p class="error hidden mac-error"></p>

          <label class="checkbox-label">
            <input type="checkbox" class="acesso-restrito-check" ${s.acessoRestrito ? "checked" : ""} /> Restringir controle desta sala a usuários específicos
          </label>
          <div class="acesso-usuarios-area ${s.acessoRestrito ? "" : "hidden"}">
            <label>Conceder acesso de controle a</label>
            <div class="two-col">
              <select class="acesso-usuario-select">
                ${usuariosControlaveis.map((u) => `<option value="${u.id}">${u.nome} (@${u.usuario})</option>`).join("")}
              </select>
              <button type="button" class="link-btn conceder-acesso-sala">conceder</button>
            </div>
            <ul class="room-list acesso-usuarios-list"></ul>
          </div>
        </div>
      `;

      li.querySelector(".salvar-mac").addEventListener("click", async () => {
        const errorEl = li.querySelector(".mac-error");
        errorEl.classList.add("hidden");
        const mac = li.querySelector(".mac-input").value.trim();
        const resp = await Api.cadastrarMac(s.sala, mac || null);
        if (!resp.ok) {
          errorEl.textContent = resp.erro || "não foi possível salvar o MAC";
          errorEl.classList.remove("hidden");
        }
      });

      li.querySelector(".preset-select").addEventListener("change", async (e) => {
        const errorEl = li.querySelector(".mac-error");
        errorEl.classList.add("hidden");
        const presetId = e.target.value ? Number(e.target.value) : null;
        const resp = await Api.definirPresetDaSala(s.sala, presetId);
        if (!resp.ok) {
          errorEl.textContent = resp.erro || "não foi possível definir o preset";
          errorEl.classList.remove("hidden");
        }
      });

      const acessarBtn = li.querySelector(".acessar-esp32");
      if (acessarBtn) {
        acessarBtn.addEventListener("click", async () => {
          const resp = await Api.acessarEsp32(s.sala);
          if (!resp.ok) {
            alert(resp.erro || "não foi possível obter o endereço do ESP32");
            return;
          }
          window.open(resp.url, "_blank", "noopener");
        });
      }

      const acessoArea = li.querySelector(".acesso-usuarios-area");
      const acessoLista = li.querySelector(".acesso-usuarios-list");

      const renderAcessoUsuarios = (usuariosComAcesso) => {
        acessoLista.innerHTML = "";
        if (usuariosComAcesso.length === 0) {
          const vazio = document.createElement("li");
          vazio.innerHTML = `<div class="room-sub">nenhum usuário com acesso concedido ainda</div>`;
          acessoLista.appendChild(vazio);
          return;
        }
        usuariosComAcesso.forEach((u) => {
          const item = document.createElement("li");
          item.innerHTML = `
            <div class="room-name">${u.nome} <span class="room-sub">@${u.usuario}</span></div>
            <button type="button" class="link-btn danger revogar-acesso-sala">revogar</button>
          `;
          item.querySelector(".revogar-acesso-sala").addEventListener("click", async () => {
            const resp = await Api.revogarAcessoSala(s.sala, u.id);
            if (resp.ok) renderAcessoUsuarios(resp.usuarios);
          });
          acessoLista.appendChild(item);
        });
      };

      if (s.acessoRestrito) {
        const usuariosComAcesso = await Api.listarAcessoSala(s.sala);
        renderAcessoUsuarios(usuariosComAcesso);
      }

      li.querySelector(".acesso-restrito-check").addEventListener("change", async (e) => {
        const restrito = e.target.checked;
        const resp = await Api.definirAcessoRestrito(s.sala, restrito);
        if (!resp.ok) {
          alert(resp.erro || "não foi possível alterar a restrição de acesso");
          e.target.checked = !restrito;
          return;
        }
        acessoArea.classList.toggle("hidden", !restrito);
        if (restrito) {
          const usuariosComAcesso = await Api.listarAcessoSala(s.sala);
          renderAcessoUsuarios(usuariosComAcesso);
        }
      });

      li.querySelector(".conceder-acesso-sala").addEventListener("click", async () => {
        const select = li.querySelector(".acesso-usuario-select");
        if (!select.value) return;
        const resp = await Api.concederAcessoSala(s.sala, Number(select.value));
        if (resp.ok) renderAcessoUsuarios(resp.usuarios);
      });

      list.appendChild(li);
    }

    await this.carregarDetectados();
    this.carregarMacsFloorplan();
  },

  filtrarMacsList(query) {
    const normalizar = (texto) => texto
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();

    const termo = normalizar(query);
    const itens = document.querySelectorAll("#macsList > li");
    let visiveis = 0;

    itens.forEach((li) => {
      const corresponde = termo === "" || normalizar(li.textContent).includes(termo);
      li.classList.toggle("hidden", !corresponde);
      if (corresponde) visiveis++;
    });

    document.getElementById("macsListEmpty").classList.toggle("hidden", visiveis !== 0 || termo === "");
  },

  async carregarDetectados() {
    const list = document.getElementById("detectadosList");
    const empty = document.getElementById("detectadosEmpty");
    list.innerHTML = "";
    const detectados = await Api.listarDetectados();
    const salas = await Api.listarSalasAdmin();

    if (!Array.isArray(detectados) || detectados.length === 0) {
      empty.classList.remove("hidden");
      return;
    }
    empty.classList.add("hidden");

    detectados.forEach((d) => {
      const li = document.createElement("li");
      li.className = "detectado-card";
      li.innerHTML = `
        <div class="detectado-card-head">
          <span class="detectado-dot"></span>
          <span class="room-name">${d.mac}</span>
        </div>
        <div class="room-sub">IP: ${d.ip || "desconhecido"}</div>
        <div class="room-sub">Sala reportada: ${d.sala || "—"}</div>
        <div class="room-sub">Visto por último: ${Tempo.formatarDataHora(d.ultimaDeteccao)}</div>
        <select class="vincular-sala-select">
          <option value="">selecionar sala para vincular</option>
          ${salas.map((s) => `<option value="${s.sala}">${s.sala} — ${s.nome}</option>`).join("")}
        </select>
        <div class="detectado-card-actions">
          <button type="button" class="link-btn vincular-detectado">vincular</button>
          <button type="button" class="link-btn danger remover-detectado">descartar</button>
        </div>
      `;

      li.querySelector(".vincular-detectado").addEventListener("click", async () => {
        const select = li.querySelector(".vincular-sala-select");
        if (!select.value) {
          alert("selecione a sala de destino");
          return;
        }
        const resp = await Api.cadastrarMac(select.value, d.mac);
        if (!resp.ok) {
          alert(resp.erro || "não foi possível vincular o ESP32 à sala");
          return;
        }
        await Api.removerDetectado(d.mac);
        await Admin.carregarMacs();
      });

      li.querySelector(".remover-detectado").addEventListener("click", async () => {
        await Api.removerDetectado(d.mac);
        await Admin.carregarDetectados();
      });

      list.appendChild(li);
    });
  },

  _macsFpInstancia: null,

  carregarMacsFloorplan() {
    const container = document.getElementById("macsFpInner");
    const tabsContainer = document.getElementById("macsFpTabs");
    if (!container) return;
    if (container.dataset.montado === "1") {
      if (this._macsFpInstancia) this._macsFpInstancia.fitToWidth();
      return;
    }

    const origem = document.getElementById("fpScaleInner");
    if (!origem || !tabsContainer) return;

    container.innerHTML = origem.innerHTML;
    container.dataset.montado = "1";

    const origemTabs = document.querySelectorAll("#screen-floorplan .fp-tab-btn");
    tabsContainer.innerHTML = "";
    origemTabs.forEach((btn) => {
      const clone = document.createElement("button");
      clone.type = "button";
      clone.className = btn.className;
      clone.dataset.fpSection = btn.dataset.fpSection;
      clone.textContent = btn.textContent;
      tabsContainer.appendChild(clone);
    });

    this._macsFpInstancia = Floorplan.create(container, tabsContainer, {
      fitToWidth: true,
      enableZoom: true,
      onSelect: (sala) => {
        container.querySelectorAll(".room.selectable").forEach((el) => el.classList.remove("fp-admin-highlight"));
        const alvo = container.querySelector(`.room.selectable[data-sala="${sala}"]`);
        if (alvo) alvo.classList.add("fp-admin-highlight");
        const searchInput = document.getElementById("macsSearchInput");
        if (searchInput.value !== "") {
          searchInput.value = "";
          this.filtrarMacsList("");
        }
        const card = document.getElementById(`macCard-${sala}`);
        if (card) card.scrollIntoView({ behavior: "smooth", block: "center" });
      },
    });

    const zoomFocusBtn = document.getElementById("macsFpZoomFocusBtn");
    const zoomInBtn = document.getElementById("macsFpZoomInBtn");
    const zoomOutBtn = document.getElementById("macsFpZoomOutBtn");
    const zoomResetBtn = document.getElementById("macsFpZoomResetBtn");
    let zoomFocusArmed = false;

    const atualizarZoomFocus = () => {
      if (zoomFocusBtn) zoomFocusBtn.classList.toggle("is-active", zoomFocusArmed);
    };

    if (zoomFocusBtn) zoomFocusBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      zoomFocusArmed = !zoomFocusArmed;
      atualizarZoomFocus();
    });
    if (zoomInBtn) zoomInBtn.addEventListener("click", () => this._macsFpInstancia.zoomIn());
    if (zoomOutBtn) zoomOutBtn.addEventListener("click", () => this._macsFpInstancia.zoomOut());
    if (zoomResetBtn) zoomResetBtn.addEventListener("click", () => {
      zoomFocusArmed = false;
      atualizarZoomFocus();
      this._macsFpInstancia.resetZoom();
    });

    container.addEventListener("click", (event) => {
      if (!zoomFocusArmed) return;
      const wrap = event.target.closest(".plan-wrap");
      if (!wrap) return;
      event.preventDefault();
      event.stopPropagation();
      this._macsFpInstancia.zoomToPoint(event.clientX, event.clientY);
      zoomFocusArmed = false;
      atualizarZoomFocus();
    }, true);
  },

  async carregarPresets() {
    const list = document.getElementById("presetsList");
    list.innerHTML = "";
    const presets = await Api.listarPresets();

    presets.forEach((p) => {
      const li = document.createElement("li");
      li.innerHTML = `
        <div>
          <div class="room-name">${p.nome} ${p.padrao ? "· padrão" : ""}</div>
          <div class="room-sub">
            ${p.funcoes.map((f) => `<span class="preset-funcao-tag">${f.rotulo}</span>`).join("") || "sem funções cadastradas"}
          </div>
        </div>
        ${!p.padrao ? `<button type="button" class="link-btn danger remover-preset">remover</button>` : ""}
      `;
      const removerBtn = li.querySelector(".remover-preset");
      if (removerBtn) {
        removerBtn.addEventListener("click", async () => {
          if (!confirm(`Remover o preset "${p.nome}"? As salas que o utilizam voltarão ao preset padrão.`)) return;
          const resp = await Api.removerPreset(p.id);
          if (!resp.ok) alert(resp.erro || "não foi possível remover o preset");
          await Admin.carregarPresets();
        });
      }
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
    if (sub === "acessos") await Admin.carregarAcessos();
    if (sub === "mapa") await Admin.carregarMapa();
    if (sub === "macs") await Admin.carregarMacs();
    if (sub === "presets") await Admin.carregarPresets();
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

  if (state.isSuperAdmin) {
    dados.temperaturaMinima = Number(document.getElementById("cfgTemperaturaMinima").value);
    dados.temperaturaMaxima = Number(document.getElementById("cfgTemperaturaMaxima").value);
    dados.modoTeste = document.getElementById("cfgModoTeste").checked;
    dados.redesAutorizadas = document.getElementById("cfgRedesAutorizadas").value
      .split("\n")
      .map((v) => v.trim())
      .filter(Boolean);
  }

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

document.getElementById("criarPresetBtn").addEventListener("click", async () => {
  const errorEl = document.getElementById("presetError");
  errorEl.classList.add("hidden");
  const nome = document.getElementById("novoPresetNome").value.trim();
  if (!nome) {
    errorEl.textContent = "informe o nome do preset";
    errorEl.classList.remove("hidden");
    return;
  }
  const resp = await Api.criarPreset(nome);
  if (!resp.ok) {
    errorEl.textContent = resp.erro || "não foi possível criar o preset";
    errorEl.classList.remove("hidden");
    return;
  }
  document.getElementById("novoPresetNome").value = "";
  await Admin.carregarPresets();
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

document.getElementById("acessosFiltroData").addEventListener("change", (e) => {
  Admin.carregarAcessos(e.target.value || undefined);
});

document.getElementById("acessosApagarData").addEventListener("click", async () => {
  const data = document.getElementById("acessosFiltroData").value;
  if (!data) {
    alert("selecione uma data para apagar os acessos daquele dia");
    return;
  }
  if (!confirm(`Apagar todos os acessos do dia ${data}?`)) return;
  await Api.apagarAcessosEsp(data);
  await Admin.carregarAcessos(data);
});

document.getElementById("acessosApagarTudo").addEventListener("click", async () => {
  if (!confirm("Apagar TODOS os acessos ao webserver dos ESP32? Esta ação não pode ser desfeita.")) return;
  await Api.apagarAcessosEsp();
  await Admin.carregarAcessos(document.getElementById("acessosFiltroData").value || undefined);
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

document.getElementById("macsSearchInput").addEventListener("input", (e) => {
  Admin.filtrarMacsList(e.target.value);
});

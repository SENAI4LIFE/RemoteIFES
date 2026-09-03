const Inicio = (() => {
  const el = (id) => document.getElementById(id);
  const grid = () => el("hubGridPrincipal");
  const gridAdmin = () => el("hubGridAdmin");
  const blocoAdmin = () => el("hubAdminBloco");
  const resumo = () => el("hubResumo");

  function irRota(rota) {
    if (typeof Router !== "undefined") Router.ir(rota, { push: true });
  }

  const PRINCIPAIS = [
    {
      id: "salas", icon: "🌡️", titulo: "Salas",
      desc: "Escolha uma sala e ligue, desligue ou ajuste o ar-condicionado.",
      quando: () => true, acao: () => irRota("/salas"),
    },
    {
      id: "planta", icon: "🗺️", titulo: "Planta baixa",
      desc: "Encontre a sala pelo mapa dos blocos e andares do campus.",
      quando: () => true, acao: () => irRota("/salas/planta"),
    },
    {
      id: "agenda", icon: "🗓️", titulo: "Agenda",
      desc: "Programe horários para ligar e desligar cada sala.",
      quando: () => !!state.isAdmin, acao: () => irRota("/agenda"),
    },
    {
      id: "grade", icon: "📊", titulo: "Grade",
      desc: "Acompanhe o status de todas as salas em um painel único.",
      quando: () => !!state.isAdmin, acao: () => irRota("/grade"),
    },
    {
      id: "config", icon: "🗝️", titulo: "Config. de sala",
      desc: "Gerencie quem pode controlar as salas sob sua responsabilidade.",
      quando: () => !state.isAdmin && !!state.temSalaComoProprietario, acao: () => irRota("/config"),
    },
    {
      id: "notificacoes", icon: "🔔", titulo: "Notificações",
      desc: "Avisos de conexão e falha dos dispositivos ESP32.",
      quando: () => !!state.isAdmin,
      acao: (evento) => {
        if (evento) evento.stopPropagation();
        if (typeof Notificacoes !== "undefined") Notificacoes.abrirPainel();
      },
    },
    {
      id: "relatos", icon: "🐞", titulo: "Relatar problema",
      desc: "Envie um problema para a equipe e acompanhe seus relatos.",
      quando: () => true,
      acao: (evento) => {
        if (evento) evento.stopPropagation();
        if (typeof Relatos !== "undefined") Relatos.abrirPainel();
      },
    },
    {
      id: "ajuda", icon: "📖", titulo: "Ajuda e manual",
      desc: "Guia completo do RemoteIFES, com busca e diagramas.",
      quando: () => true,
      acao: () => { if (typeof Manual !== "undefined") Manual.abrir(); },
    },
    {
      id: "aplicativo", icon: "📱", titulo: "Aplicativo móvel",
      desc: "Baixe e instale o aplicativo Android do RemoteIFES.",
      quando: () => true,
      acao: () => { if (typeof MobileApp !== "undefined") MobileApp.abrir(); },
    },
  ];

  const ADMIN = [
    { sub: "usuarios", icon: "👥", titulo: "Usuários", grupo: "Gestão" },
    { sub: "proprietarios", icon: "🗝️", titulo: "Proprietários", grupo: "Gestão" },
    { sub: "sessoes", icon: "🕒", titulo: "Sessões", grupo: "Gestão" },
    { sub: "ativos", icon: "🟢", titulo: "Ativos", grupo: "Gestão" },
    { sub: "mapa", icon: "🗺️", titulo: "Mapa", grupo: "Gestão" },
    { sub: "relatos", icon: "🐞", titulo: "Relatos", grupo: "Gestão", exigeSuper: true },
    { sub: "macs", icon: "🔧", titulo: "Cadastro", grupo: "Dispositivos", exigeSuper: true },
    { sub: "dispositivos", icon: "📡", titulo: "Histórico", grupo: "Dispositivos" },
    { sub: "notificacoes", icon: "🔔", titulo: "Notificações", grupo: "Dispositivos" },
    { sub: "esp32", icon: "📶", titulo: "Firmware / OTA", grupo: "Dispositivos", exigeSuper: true },
    { sub: "logs", icon: "📜", titulo: "Logs", grupo: "Sistema" },
    { sub: "monitoramento", icon: "🩺", titulo: "Status", grupo: "Sistema", exigeSuper: true },
    { sub: "config", icon: "⚙️", titulo: "Configurações", grupo: "Sistema", exigeSuper: true },
    { sub: "auditoria", icon: "🛡️", titulo: "Auditoria", grupo: "Sistema", exigeSuper: true },
  ];

  function criarCard(def, compacto) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = compacto ? "hub-card hub-card-compacto" : "hub-card";
    btn.dataset.hubCard = def.chave;

    const ic = document.createElement("span");
    ic.className = "hub-card-icon";
    ic.setAttribute("aria-hidden", "true");
    ic.textContent = def.icon;
    btn.appendChild(ic);

    const corpo = document.createElement("span");
    corpo.className = "hub-card-corpo";
    const titulo = document.createElement("span");
    titulo.className = "hub-card-title";
    titulo.textContent = def.titulo;
    corpo.appendChild(titulo);
    if (!compacto && def.desc) {
      const desc = document.createElement("span");
      desc.className = "hub-card-desc";
      desc.textContent = def.desc;
      corpo.appendChild(desc);
    }
    btn.appendChild(corpo);

    if (!compacto) {
      const badge = document.createElement("span");
      badge.className = "hub-card-badge hidden";
      badge.setAttribute("aria-hidden", "true");
      btn.appendChild(badge);
    }

    btn.addEventListener("click", (evento) => def.acao(evento));
    return btn;
  }

  function definirBadge(chave, texto, alerta) {
    const g = grid();
    const card = g && g.querySelector(`[data-hub-card="${chave}"]`);
    const badge = card && card.querySelector(".hub-card-badge");
    if (!badge) return;
    badge.classList.toggle("is-alerta", !!alerta);
    if (!texto) {
      badge.classList.add("hidden");
      badge.textContent = "";
      return;
    }
    badge.textContent = texto;
    badge.classList.remove("hidden");
  }

  function papelRotulo() {
    if (state.isSuperAdmin) return "Superadministrador";
    if (state.isAdmin) return "Administrador";
    if (state.temSalaComoProprietario) return "Proprietário de sala";
    return "Usuário";
  }

  function renderHero(complemento) {
    const titulo = el("hubHeroTitulo");
    const sub = el("hubHeroSub");
    const nome = state && state.nome ? String(state.nome).trim().split(/\s+/)[0] : "";
    if (titulo) titulo.textContent = nome ? `Olá, ${nome}` : "Início";
    if (sub) {
      sub.textContent = complemento
        ? `${papelRotulo()} · ${complemento}`
        : `${papelRotulo()} · controle do ar-condicionado das salas do campus.`;
    }
  }

  function renderPrincipais() {
    const g = grid();
    if (!g) return;
    g.textContent = "";
    PRINCIPAIS
      .filter((d) => { try { return d.quando(); } catch (e) { return false; } })
      .forEach((d) => g.appendChild(criarCard({ ...d, chave: d.id }, false)));
  }

  function renderAdmin() {
    const bloco = blocoAdmin();
    const g = gridAdmin();
    if (!bloco || !g) return;
    if (!state.isAdmin) {
      bloco.hidden = true;
      g.textContent = "";
      return;
    }
    bloco.hidden = false;
    g.textContent = "";
    ADMIN
      .filter((d) => !d.exigeSuper || state.isSuperAdmin)
      .forEach((d) => g.appendChild(criarCard({
        chave: `adm-${d.sub}`, icon: d.icon, titulo: `${d.grupo} · ${d.titulo}`,
        acao: () => irRota(`/admin/${d.sub}`),
      }, true)));
  }

  async function carregarSalas() {
    if (typeof Api === "undefined" || typeof Api.listarSalas !== "function") return;
    const salas = await Api.listarSalas();
    if (!Array.isArray(salas) || salas.length === 0) return;
    const online = salas.filter((s) => s && s.online).length;
    definirBadge("salas", `${online}/${salas.length} on-line`);
    renderHero(`${online} de ${salas.length} salas on-line agora.`);
  }

  async function carregarBadges() {
    if (state.isAdmin && typeof Api.contarNotificacoesNaoLidas === "function") {
      const n = await Api.contarNotificacoesNaoLidas();
      if (n && typeof n.naoLidas === "number") {
        definirBadge("notificacoes", n.naoLidas > 0 ? (n.naoLidas > 99 ? "99+" : String(n.naoLidas)) : "", true);
      }
    }
    if (state.isSuperAdmin && typeof Api.contarRelatos === "function") {
      const r = await Api.contarRelatos();
      if (r && typeof r.novos === "number") {
        definirBadge("relatos", r.novos > 0 ? (r.novos > 99 ? "99+" : String(r.novos)) : "", true);
      }
    }
  }

  function chip(estado, rotulo) {
    return typeof Status !== "undefined" ? Status.chip(estado, rotulo) : "";
  }

  async function carregarResumo() {
    const box = resumo();
    if (!box) return;
    if (!state.isSuperAdmin || typeof Api.obterMonitoramento !== "function") {
      box.hidden = true;
      box.textContent = "";
      return;
    }
    const resp = await Api.obterMonitoramento();
    if (!resp || !resp.ok || !resp.monitoramento) {
      box.hidden = true;
      return;
    }
    const m = resp.monitoramento;
    const b = m.banco || {};
    const arm = m.armazenamento || {};
    const e = m.esp32 || {};
    const bk = m.backup || {};
    const alertas = Array.isArray(m.alertas) ? m.alertas.length : 0;

    const chips = [
      chip(b.ok ? "disponivel" : "falha", b.ok ? "Banco de dados" : "Banco com falha"),
      chip(
        arm.erro ? "falha" : arm.alerta ? "temporariamente-indisponivel" : "disponivel",
        arm.erro ? "Armazenamento" : `Disco ${arm.livrePercent != null ? `${arm.livrePercent}% livre` : "ok"}`
      ),
      chip(
        e.otaComFalha > 0 ? "falha" : e.offlineInesperado > 0 ? "temporariamente-indisponivel" : "disponivel",
        `ESP32 ${e.conectadosWs || 0}/${e.comMac || 0}`
      ),
      chip(
        !bk.automatico ? "desabilitado-config" : bk.alerta ? "falha" : "disponivel",
        !bk.automatico ? "Backups desativados" : bk.alerta ? "Backups atrasados" : "Backups"
      ),
    ];

    box.hidden = false;
    box.classList.toggle("hub-resumo-alerta", alertas > 0);
    box.innerHTML =
      `<div class="hub-resumo-chips">${chips.join("")}</div>` +
      `<button type="button" class="hub-resumo-link">${alertas > 0 ? `${alertas} alerta${alertas > 1 ? "s" : ""} · ` : ""}Abrir monitoramento &rarr;</button>`;
    const lnk = box.querySelector(".hub-resumo-link");
    if (lnk) lnk.addEventListener("click", () => irRota("/admin/monitoramento"));
  }

  async function aoAbrir() {
    if (typeof state === "undefined" || !state.usuario) return;
    renderHero();
    renderPrincipais();
    renderAdmin();
    await Promise.allSettled([carregarSalas(), carregarBadges(), carregarResumo()]);
  }

  return { aoAbrir };
})();

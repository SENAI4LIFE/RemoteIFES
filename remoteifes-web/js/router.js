const Router = (() => {
  let restaurando = false;
  let salasCache = null;

  const ADMIN_SUBS = [
    "usuarios", "ativos", "sessoes", "logs", "dispositivos", "monitoramento",
    "acessos", "proprietarios", "mapa", "macs", "config", "esp32",
  ];
  const ADMIN_SUBS_SUPERADMIN = ["monitoramento", "macs", "config", "esp32"];
  const FP_SECOES = ["a-terreo", "a-2pav", "a-3pav", "b-terreo", "b-2pav", "b-3pav"];
  const RAIZES_COM_PARAMETRO = ["agenda", "agendamentos", "grade", "config", "ajuda"];

  function logado() {
    return !!(typeof state !== "undefined" && state.usuario);
  }

  function telaVisivel() {
    const el = document.querySelector("#mainApp .screen.tab-content:not(.hidden)");
    return el ? el.id : null;
  }

  function manualAberto() {
    return typeof Manual !== "undefined" && Manual.estaAberto && Manual.estaAberto();
  }

  function mobileAberto() {
    return typeof MobileApp !== "undefined" && MobileApp.estaAberto && MobileApp.estaAberto();
  }

  function construirCaminho() {
    if (mobileAberto()) return "/aplicativo";
    if (manualAberto()) {
      const secao = Manual.secaoAtual && Manual.secaoAtual();
      return secao ? `/ajuda/${secao}` : "/ajuda";
    }
    if (!logado()) return "";

    const id = telaVisivel();
    const val = (sel) => {
      const el = document.getElementById(sel);
      return el && el.value ? el.value : "";
    };

    switch (id) {
      case "screen-simple":
        return "/salas";
      case "screen-location":
        return "/salas/ambiente";
      case "screen-floorplan": {
        const ativa = document.querySelector("#screen-floorplan .fp-tab-btn.active");
        return `/salas/planta${ativa ? `/${ativa.dataset.fpSection}` : ""}`;
      }
      case "screen-rooms":
        return state.bloco && state.andar ? `/salas/lista/${state.bloco}/${state.andar}` : "/salas";
      case "screen-panel":
        return state.salaAtual ? `/sala/${encodeURIComponent(state.salaAtual)}` : "/salas";
      case "screen-agenda": {
        const s = val("agendaSala");
        return `/agenda${s ? `/${encodeURIComponent(s)}` : ""}`;
      }
      case "screen-grade": {
        const s = val("gradeSala");
        const d = val("gradeData");
        return `/grade${s ? `/${encodeURIComponent(s)}${d ? `/${d}` : ""}` : ""}`;
      }
      case "screen-propriedade": {
        const s = val("propriedadeSala");
        return `/config${s ? `/${encodeURIComponent(s)}` : ""}`;
      }
      case "screen-admin": {
        const ativa = document.querySelector(".admin-subtab-btn.active");
        return `/admin/${(ativa && ativa.dataset.sub) || "usuarios"}`;
      }
      default:
        return "";
    }
  }

  function chaveNavegacao(caminho) {
    const segs = String(caminho || "").replace(/^#/, "").split("/").filter(Boolean);
    if (!segs.length) return "";
    if (RAIZES_COM_PARAMETRO.includes(segs[0])) return `/${segs[0]}`;
    return `/${segs.join("/")}`;
  }

  function sync(opcoes) {
    if (restaurando) return;
    const caminho = construirCaminho();
    const alvo = caminho ? `#${caminho}` : "#/";
    const anterior = location.hash;
    if (anterior === alvo || (!caminho && !anterior)) return;
    const forcado = opcoes && typeof opcoes.push === "boolean" ? opcoes.push : null;
    const novaEntrada =
      forcado !== null
        ? forcado
        : !!anterior && anterior !== "#/" && chaveNavegacao(caminho) !== chaveNavegacao(anterior);
    try {
      if (novaEntrada) history.pushState(null, "", alvo);
      else history.replaceState(null, "", alvo);
    } catch (erro) {}
  }

  function segmentos() {
    return location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map((s) => {
      try {
        return decodeURIComponent(s);
      } catch (erro) {
        return s;
      }
    });
  }

  function irParaAba(tab) {
    if (typeof switchTab === "function") switchTab(tab);
  }

  function clicarSubAdmin(sub) {
    const alvo = ADMIN_SUBS.includes(sub) ? sub : "usuarios";
    const permitido =
      !ADMIN_SUBS_SUPERADMIN.includes(alvo) || (typeof state !== "undefined" && state.isSuperAdmin);
    const btn = document.querySelector(`.admin-subtab-btn[data-sub="${permitido ? alvo : "usuarios"}"]`);
    if (btn && !btn.classList.contains("hidden")) btn.click();
  }

  function abrirRelatos() {
    irParaAba("salas");
    if (typeof Relatos !== "undefined" && typeof Relatos.abrirPainel === "function") {
      Relatos.abrirPainel();
    }
  }

  async function abrirSalaPorCodigo(codigo) {
    if (typeof Api === "undefined" || typeof openRoom !== "function") return false;
    if (!salasCache) {
      try {
        salasCache = await Api.listarSalas();
      } catch (erro) {
        salasCache = [];
      }
    }
    const sala = Array.isArray(salasCache) ? salasCache.find((s) => s.sala === codigo) : null;
    if (!sala) return false;
    openRoom(sala.sala, sala.nome);
    return true;
  }

  async function aplicar(segs) {
    const [raiz, a, b, c] = segs;

    if (raiz === "ajuda") {
      if (typeof Manual !== "undefined") Manual.abrir(a || null);
      return;
    }

    if (raiz === "aplicativo") {
      if (logado() && typeof MobileApp !== "undefined") MobileApp.abrir();
      return;
    }

    if (typeof Manual !== "undefined" && Manual.estaAberto && Manual.estaAberto()) {
      Manual.fechar({ semRestaurar: true });
    }
    if (typeof MobileApp !== "undefined" && MobileApp.estaAberto && MobileApp.estaAberto()) {
      MobileApp.fechar({ semRestaurar: true });
    }

    if (!logado()) return;

    if (raiz === "sala") {
      irParaAba("salas");
      const ok = await abrirSalaPorCodigo(a || "");
      if (!ok && typeof showScreen === "function") showScreen("simple");
      return;
    }

    if (raiz === "relatos") {
      abrirRelatos();
      return;
    }

    if (raiz === "admin") {
      if (!state.isAdmin) return irParaAba("salas");
      if (a === "relatos") {
        abrirRelatos();
        return;
      }
      irParaAba("admin");
      clicarSubAdmin(a || "usuarios");
      return;
    }

    if (raiz === "agenda" || raiz === "agendamentos" || raiz === "grade") {
      if (!state.isAdmin) return irParaAba("salas");
      const aba = raiz === "agendamentos" ? "agenda" : raiz;
      irParaAba(aba);
      if (aba === "agenda" && a) definirSelect("agendaSala", a);
      if (aba === "grade" && a) {
        definirSelect("gradeSala", a);
        if (b) definirValor("gradeData", b);
      }
      return;
    }

    if (raiz === "config") {
      if (state.isAdmin || !state.temSalaComoProprietario) return irParaAba("salas");
      irParaAba("propriedade");
      if (a) definirSelect("propriedadeSala", a);
      return;
    }

    if (raiz === "salas" || !raiz) {
      irParaAba("salas");
      if (a === "ambiente" && typeof showScreen === "function") {
        showScreen("location");
      } else if (a === "planta" && typeof showScreen === "function") {
        showScreen("floorplan");
        if (b && FP_SECOES.includes(b)) {
          setTimeout(() => {
            const btn = document.querySelector(`#screen-floorplan .fp-tab-btn[data-fp-section="${b}"]`);
            if (btn) btn.click();
          }, 0);
        }
      } else if (a === "lista" && b && c) {
        state.bloco = b;
        state.andar = c;
        refletirEscolhaBlocoAndar(b, c);
        if (typeof showScreen === "function") showScreen("rooms");
        if (typeof loadRooms === "function") loadRooms(b, c);
      }
      return;
    }

    irParaAba("salas");
  }

  function definirValor(id, valor) {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = valor;
    el.dispatchEvent(new Event("change"));
  }

  function definirSelect(id, valor) {
    const el = document.getElementById(id);
    if (!el) return;
    const tem = Array.from(el.options).some((o) => o.value === valor);
    if (!tem) {
      setTimeout(() => definirSelect(id, valor), 120);
      return;
    }
    el.value = valor;
    el.dispatchEvent(new Event("change"));
  }

  function refletirEscolhaBlocoAndar(bloco, andar) {
    document.querySelectorAll("#blocoChoices .choice-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.bloco === bloco);
    });
    document.querySelectorAll("#andarChoices .choice-btn").forEach((b) => {
      b.classList.toggle("active", String(b.dataset.andar) === String(andar));
    });
    const verSalas = document.getElementById("verSalasBtn");
    if (verSalas) verSalas.disabled = false;
  }

  async function restaurar() {
    if (restaurando) return;
    const segs = segmentos();
    if (segs.length === 0) {
      if (logado()) irParaAba("salas");
      return;
    }
    restaurando = true;
    try {
      await aplicar(segs);
    } finally {
      restaurando = false;
      sync();
    }
  }

  function ir(caminho, opcoes) {
    const limpo = String(caminho || "").replace(/^#/, "");
    const alvo = `#${limpo.startsWith("/") ? "" : "/"}${limpo}`;
    const push = opcoes && opcoes.push === true;
    try {
      if (push && location.hash && location.hash !== "#/") history.pushState(null, "", alvo);
      else history.replaceState(null, "", alvo);
    } catch (erro) {}
    restaurar();
  }

  function aoVoltarOuAvancar() {
    if (restaurando) return;
    if (!logado() && !location.hash.startsWith("#/ajuda")) {
      try {
        history.replaceState(null, "", location.pathname + location.search);
      } catch (erro) {}
      return;
    }
    restaurar();
  }

  window.addEventListener("hashchange", aoVoltarOuAvancar);

  return { sync, restaurar, ir, estaRestaurando: () => restaurando };
})();

const Manual = (() => {
  const overlay = document.getElementById("screen-manual");
  const tocEl = document.getElementById("manualToc");
  const tocVazioEl = document.getElementById("manualTocVazio");
  const conteudoEl = document.getElementById("manualConteudo");
  const buscaEl = document.getElementById("manualBusca");

  const ATALHOS = ["inicio", "selecao-sala", "controlador", "solucao-problemas"];

  const ALIAS_SECAO = {
    ota: "ota-credenciais",
    credenciais: "ota-credenciais",
    credencial: "ota-credenciais",
    esp32: "esp32-cadastro",
    agenda: "agenda-grade",
    agendamentos: "agenda-grade",
    grade: "agenda-grade",
    admin: "administracao",
    sala: "selecao-sala",
    salas: "selecao-sala",
    pwa: "pwa-mobile",
    mobile: "pwa-mobile",
    cordova: "pwa-mobile",
    problemas: "solucao-problemas",
    ajuda: "inicio",
  };

  function resolverSecao(id) {
    if (!id) return null;
    if (document.getElementById(`manual-sec-${id}`)) return id;
    const alias = ALIAS_SECAO[id];
    if (alias && document.getElementById(`manual-sec-${alias}`)) return alias;
    const conhecidas = Array.from(conteudoEl.querySelectorAll(".manual-secao")).map((s) =>
      s.id.replace("manual-sec-", "")
    );
    return conhecidas.find((sid) => sid.startsWith(`${id}-`) || sid.split("-")[0] === id) || null;
  }

  let aberto = false;
  let secaoAtual = null;
  let renderRole = null;
  let hashAnterior = null;
  let elementoAnterior = null;
  let carregando = null;

  function normalizar(t) {
    return String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  }

  function papelPermitido(papel) {
    if (papel === "admin") return !!(typeof state !== "undefined" && state.isAdmin);
    if (papel === "superadmin") return !!(typeof state !== "undefined" && state.isSuperAdmin);
    return true;
  }

  function rotaPermitida(rota) {
    if (!rota) return false;
    if (typeof state === "undefined" || !state.usuario) return false;
    if (rota.startsWith("/admin/")) {
      const sub = rota.slice(7);
      if (["monitoramento", "macs", "config", "esp32"].includes(sub)) return !!state.isSuperAdmin;
      return !!state.isAdmin;
    }
    if (rota === "/agenda" || rota === "/grade") return !!state.isAdmin;
    if (rota === "/config") return !state.isAdmin && !!state.temSalaComoProprietario;
    return true;
  }

  function textoPlano(corpo) {
    return (corpo || [])
      .map((b) => {
        if (b.texto) return b.texto;
        if (b.itens) return b.itens.join(" ");
        if (b.linhas) return b.linhas.map((l) => l.join(" ")).join(" ");
        if (b.titulo) return b.titulo;
        return "";
      })
      .join(" ")
      .replace(/<[^>]+>/g, " ");
  }

  function bloco(b) {
    if (b.t === "p") return `<p>${b.texto}</p>`;
    if (b.t === "nota") return `<p class="manual-nota">${b.texto}</p>`;
    if (b.t === "sub") return `<h3>${escapeHtml(b.titulo)}</h3>`;
    if (b.t === "lista") return `<ul>${b.itens.map((i) => `<li>${i}</li>`).join("")}</ul>`;
    if (b.t === "passos") return `<ol>${b.itens.map((i) => `<li>${i}</li>`).join("")}</ol>`;
    if (b.t === "diagrama") {
      const raw = ManualContent.diagramas[b.chave] || "";
      const rot = (ManualContent.rotulos || {})[b.chave] || "Diagrama do manual";
      return `<figure class="manual-figura">${raw.replace("<defs>", `<title>${escapeHtml(rot)}</title><defs>`)}</figure>`;
    }
    if (b.t === "tabela") {
      return (
        `<div class="manual-tabela-wrap"><table class="manual-tabela"><thead><tr>` +
        b.cabecalho.map((c) => `<th>${escapeHtml(c)}</th>`).join("") +
        `</tr></thead><tbody>` +
        b.linhas.map((l) => `<tr>${l.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`).join("") +
        `</tbody></table></div>`
      );
    }
    return "";
  }

  function assinaturaPapel() {
    const s = typeof state !== "undefined" ? state : {};
    return `${!!s.usuario}|${!!s.isAdmin}|${!!s.isSuperAdmin}|${!!s.temSalaComoProprietario}`;
  }

  function render() {
    if (typeof ManualContent === "undefined") return;
    const assinatura = assinaturaPapel();
    if (renderRole === assinatura) return;
    renderRole = assinatura;
    const secoes = ManualContent.secoes.filter((s) => papelPermitido(s.papel));

    tocEl.innerHTML = secoes
      .map((s) => `<li><button type="button" class="manual-toc-link" data-sec="${s.id}">${escapeHtml(s.titulo)}</button></li>`)
      .join("");

    conteudoEl.innerHTML = secoes
      .map((s) => {
        const verNoApp =
          s.verNoApp && rotaPermitida(s.verNoApp)
            ? `<p><button type="button" class="link-btn manual-ver-app" data-rota="${escapeHtml(s.verNoApp)}">Ver no app &rarr;</button></p>`
            : "";
        return (
          `<section class="manual-secao" id="manual-sec-${s.id}" data-busca="${escapeHtml(normalizar(s.titulo + " " + textoPlano(s.corpo)))}">` +
          `<h2>${escapeHtml(s.titulo)}</h2>${verNoApp}${s.corpo.map(bloco).join("")}` +
          `</section>`
        );
      })
      .join("");

    tocEl.querySelectorAll(".manual-toc-link").forEach((btn) => {
      btn.addEventListener("click", () => irParaSecao(btn.dataset.sec));
    });
    conteudoEl.querySelectorAll(".manual-ver-app").forEach((btn) => {
      btn.addEventListener("click", () => {
        const rota = btn.dataset.rota;
        fechar({ semRestaurar: true });
        if (typeof Router !== "undefined") Router.ir(rota, { push: true });
      });
    });
  }

  function irParaSecao(id) {
    const alvo = document.getElementById(`manual-sec-${id}`);
    if (!alvo) return;
    secaoAtual = id;
    alvo.scrollIntoView({ behavior: "smooth", block: "start" });
    tocEl.querySelectorAll(".manual-toc-link").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.sec === id);
    });
    if (typeof Router !== "undefined" && aberto) Router.sync();
  }

  function filtrar() {
    const termo = normalizar(buscaEl.value.trim());
    let visiveis = 0;
    conteudoEl.querySelectorAll(".manual-secao").forEach((sec) => {
      const ok = !termo || sec.dataset.busca.includes(termo);
      sec.classList.toggle("hidden", !ok);
      const link = tocEl.querySelector(`.manual-toc-link[data-sec="${sec.id.replace("manual-sec-", "")}"]`);
      if (link) link.parentElement.classList.toggle("hidden", !ok);
      if (ok) visiveis += 1;
    });
    tocVazioEl.classList.toggle("hidden", visiveis !== 0);
  }

  async function garantirConteudo() {
    if (typeof ManualContent !== "undefined") return;
    if (!carregando) {
      carregando = new Promise((resolve) => {
        const s = document.createElement("script");
        s.src = "js/manual-content.js";
        s.onload = resolve;
        s.onerror = resolve;
        document.head.appendChild(s);
      });
    }
    await carregando;
  }

  function aoTeclar(e) {
    if (!aberto) return;
    if (e.key === "Escape") {
      e.preventDefault();
      fechar();
      return;
    }
    if (e.key !== "Tab") return;
    const focaveis = overlay.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    const lista = Array.from(focaveis).filter((el) => el.offsetParent !== null);
    if (lista.length === 0) return;
    const primeiro = lista[0];
    const ultimo = lista[lista.length - 1];
    if (e.shiftKey && document.activeElement === primeiro) {
      e.preventDefault();
      ultimo.focus();
    } else if (!e.shiftKey && document.activeElement === ultimo) {
      e.preventDefault();
      primeiro.focus();
    }
  }

  async function abrir(secaoId) {
    await garantirConteudo();
    render();

    if (!aberto) {
      const hashAtual = location.hash || "";
      hashAnterior = hashAtual.startsWith("#/ajuda") ? null : hashAtual;
      elementoAnterior = document.activeElement;
      overlay.classList.remove("hidden");
      document.body.classList.add("manual-open");
      document.addEventListener("keydown", aoTeclar, true);
      aberto = true;
    }

    const alvoId = resolverSecao(secaoId);
    secaoAtual = alvoId || null;
    if (alvoId) {
      irParaSecao(alvoId);
    } else {
      conteudoEl.scrollTop = 0;
    }

    (buscaEl || conteudoEl).focus();
    if (typeof Router !== "undefined") Router.sync();
  }

  function fechar({ semRestaurar = false } = {}) {
    if (!aberto) return;
    aberto = false;
    secaoAtual = null;
    overlay.classList.add("hidden");
    document.body.classList.remove("manual-open");
    document.removeEventListener("keydown", aoTeclar, true);
    if (elementoAnterior && typeof elementoAnterior.focus === "function") {
      try {
        elementoAnterior.focus();
      } catch (erro) {}
    }
    if (semRestaurar) return;
    if (typeof state !== "undefined" && state.usuario && typeof Router !== "undefined") {
      Router.ir(hashAnterior || "/salas");
    } else {
      try {
        history.replaceState(null, "", location.pathname + location.search);
      } catch (erro) {}
    }
  }

  function montarAtalhos() {
    const cont = document.getElementById("helpFabLinks");
    if (!cont || typeof ManualContent === "undefined") return;
    cont.innerHTML = ATALHOS.map((id) => {
      const s = ManualContent.secoes.find((x) => x.id === id && papelPermitido(x.papel));
      return s ? `<li><button type="button" class="link-btn" data-sec="${s.id}">${escapeHtml(s.titulo)}</button></li>` : "";
    }).join("");
    cont.querySelectorAll("button[data-sec]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const p = document.getElementById("helpFabPanel");
        if (p) p.classList.add("hidden");
        abrir(btn.dataset.sec);
      });
    });
  }

  const manualBtn = document.getElementById("helpFabManualBtn");
  if (manualBtn) {
    manualBtn.addEventListener("click", () => {
      const p = document.getElementById("helpFabPanel");
      if (p) p.classList.add("hidden");
      abrir();
    });
  }
  const fecharBtn = document.getElementById("manualFecharBtn");
  if (fecharBtn) fecharBtn.addEventListener("click", () => fechar());
  const voltarBtn = document.getElementById("manualVoltarBtn");
  if (voltarBtn) voltarBtn.addEventListener("click", () => fechar());
  if (buscaEl) buscaEl.addEventListener("input", filtrar);
  const fabToggle = document.getElementById("helpFabToggleBtn");
  if (fabToggle) {
    fabToggle.addEventListener("click", () => {
      if (typeof ManualContent !== "undefined") montarAtalhos();
      else garantirConteudo().then(montarAtalhos);
    });
  }

  return {
    abrir,
    fechar,
    estaAberto: () => aberto,
    secaoAtual: () => secaoAtual,
  };
})();

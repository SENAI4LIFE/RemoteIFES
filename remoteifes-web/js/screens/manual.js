const Manual = (() => {
  const overlay = document.getElementById("screen-manual");
  const tocEl = document.getElementById("manualToc");
  const tocVazioEl = document.getElementById("manualTocVazio");
  const conteudoEl = document.getElementById("manualConteudo");
  const buscaEl = document.getElementById("manualBusca");

  const ATALHOS = ["inicio", "selecao-sala", "controlador", "solucao-problemas"];
  const MODULOS_PUBLICOS = [
    "js/manual-content.js",
    "js/manual/common-start.js",
    "js/manual/common-rooms.js",
    "js/manual/common-account.js",
  ];

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
    hub: "inicio-acoes",
    atalhos: "inicio-acoes",
    conta: "conta-sessao",
    sessao: "conta-sessao",
    offline: "pwa-mobile",
    historico: "auditoria",
    notificacao: "notificacoes",
    acessibilidade: "acessibilidade",
    backup: "backup-restauracao",
    deploy: "implantacao-rollback",
    firmware: "firmware-ota",
    android: "android-release",
    rede: "servidor-rede",
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
      if (["monitoramento", "macs", "config", "esp32", "auditoria", "energia"].includes(sub)) return !!state.isSuperAdmin;
      return !!state.isAdmin;
    }
    if (rota === "/agenda" || rota === "/grade") return !!state.isAdmin;
    if (rota === "/config") return !state.isAdmin && !!state.temSalaComoProprietario;
    return true;
  }

  function textoPlano(valor) {
    if (Array.isArray(valor)) return valor.map(textoPlano).join(" ");
    if (valor && typeof valor === "object") return Object.values(valor).map(textoPlano).join(" ");
    return String(valor || "").replace(/<[^>]+>/g, " ");
  }

  function bloco(b) {
    if (b.t === "p") return `<p>${b.texto}</p>`;
    if (b.t === "nota") return `<p class="manual-nota${b.nivel ? ` manual-nota-${escapeHtml(b.nivel)}` : ""}">${b.texto}</p>`;
    if (b.t === "sub") return `<h3>${escapeHtml(b.titulo)}</h3>`;
    if (b.t === "lista") return `<ul>${b.itens.map((i) => `<li>${i}</li>`).join("")}</ul>`;
    if (b.t === "passos") return `<ol>${b.itens.map((i) => `<li>${i}</li>`).join("")}</ol>`;
    if (b.t === "fluxo") {
      const itens = (b.itens || []).map((item, indice) =>
        `<li class="manual-flow-item manual-flow-${escapeHtml(item.tipo || "step")}"><span class="manual-flow-num" aria-hidden="true">${indice + 1}</span><span>${escapeHtml(item.texto)}</span></li>`
      ).join("");
      return `<figure class="manual-flow" aria-label="${escapeHtml(b.titulo || "Fluxo")}"><figcaption>${escapeHtml(b.titulo || "Fluxo")}</figcaption><ol>${itens}</ol></figure>`;
    }
    if (b.t === "links") {
      const itens = (b.itens || []).map((item) =>
        `<li><button type="button" class="link-btn manual-crosslink" data-sec="${escapeHtml(item.id)}">${escapeHtml(item.texto || item.id)} &rarr;</button></li>`
      ).join("");
      return `<nav class="manual-links" aria-label="${escapeHtml(b.titulo || "Tópicos relacionados")}"><strong>${escapeHtml(b.titulo || "Tópicos relacionados")}</strong><ul>${itens}</ul></nav>`;
    }
    if (b.t === "comando") {
      const comandos = (b.comandos || (b.comando ? [b.comando] : []))
        .map((comando) => `<pre><code>${escapeHtml(comando)}</code></pre>`).join("");
      const detalhes = [
        b.quando ? ["Quando", b.quando] : null,
        b.preRequisitos ? ["Pré-requisitos", b.preRequisitos] : null,
        b.resultado ? ["Resultado esperado", b.resultado] : null,
        b.risco ? ["Atenção", b.risco] : null,
      ].filter(Boolean).map(([termo, valor]) => `<dt>${escapeHtml(termo)}</dt><dd>${escapeHtml(valor)}</dd>`).join("");
      return `<aside class="manual-command"><h4>${escapeHtml(b.titulo || "Comando")}</h4>${comandos}${detalhes ? `<dl>${detalhes}</dl>` : ""}</aside>`;
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
    const privadas = typeof RoleDocumentation !== "undefined" ? RoleDocumentation.secoes() : [];
    const categorias = ManualContent.categorias || {};
    const secoes = [...ManualContent.secoes, ...privadas]
      .filter((s) => papelPermitido(s.papel))
      .sort((a, b) => (categorias[a.categoria]?.ordem || 999) - (categorias[b.categoria]?.ordem || 999));

    let categoriaAtual = null;
    tocEl.innerHTML = secoes.map((s) => {
      const categoria = s.categoria || "comecar";
      const tituloCategoria = categorias[categoria]?.titulo || categoria;
      const cabecalho = categoria !== categoriaAtual
        ? `<li class="manual-toc-category" data-category-heading="${escapeHtml(categoria)}">${escapeHtml(tituloCategoria)}</li>`
        : "";
      categoriaAtual = categoria;
      return `${cabecalho}<li data-category="${escapeHtml(categoria)}"><button type="button" class="manual-toc-link" data-sec="${escapeHtml(s.id)}">${escapeHtml(s.titulo)}</button></li>`;
    }).join("");

    conteudoEl.innerHTML = secoes
      .map((s) => {
        const verNoApp =
          s.verNoApp && rotaPermitida(s.verNoApp)
            ? `<p><button type="button" class="link-btn manual-ver-app" data-rota="${escapeHtml(s.verNoApp)}">Ver no app &rarr;</button></p>`
            : "";
        return (
          `<section class="manual-secao" id="manual-sec-${escapeHtml(s.id)}" data-category="${escapeHtml(s.categoria || "comecar")}" data-busca="${escapeHtml(normalizar(`${s.titulo} ${(s.tags || []).join(" ")} ${textoPlano(s.corpo)}`))}">` +
          `<p class="manual-category-label">${escapeHtml(categorias[s.categoria]?.titulo || "Manual")}</p><h2>${escapeHtml(s.titulo)}</h2>${verNoApp}${s.corpo.map(bloco).join("")}` +
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
    conteudoEl.querySelectorAll(".manual-crosslink").forEach((btn) => {
      const permitido = !!document.getElementById(`manual-sec-${btn.dataset.sec}`);
      btn.closest("li").classList.toggle("hidden", !permitido);
      if (permitido) btn.addEventListener("click", () => {
        buscaEl.value = "";
        filtrar();
        irParaSecao(btn.dataset.sec);
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
    tocEl.querySelectorAll(".manual-toc-category").forEach((cabecalho) => {
      const categoria = cabecalho.dataset.categoryHeading;
      const algum = Array.from(tocEl.querySelectorAll(`[data-category="${CSS.escape(categoria)}"]`))
        .some((item) => !item.classList.contains("hidden"));
      cabecalho.classList.toggle("hidden", !algum);
    });
    tocVazioEl.classList.toggle("hidden", visiveis !== 0);
  }

  async function garantirConteudo() {
    if (typeof ManualContent !== "undefined" && ManualContent.secoes.length) return;
    if (!carregando) {
      carregando = (async () => {
        const versao = window.REMOTEIFES_FRONTEND_VERSION || "unknown";
        for (const caminho of MODULOS_PUBLICOS) {
          if (caminho.endsWith("manual-content.js") && typeof ManualContent !== "undefined") continue;
          await new Promise((resolve) => {
            const s = document.createElement("script");
            s.src = `${caminho}?v=${encodeURIComponent(versao)}`;
            s.onload = resolve;
            s.onerror = resolve;
            document.head.appendChild(s);
          });
        }
      })();
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
    if (typeof RoleDocumentation !== "undefined") await RoleDocumentation.carregar();
    renderRole = null;
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
      conteudoEl.focus({ preventScroll: true });
      irParaSecao(alvoId);
    } else {
      conteudoEl.scrollTop = 0;
      buscaEl.focus();
    }

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
      Router.ir(hashAnterior || "/inicio");
    } else {
      try {
        history.replaceState(null, "", location.pathname + location.search);
      } catch (erro) {}
    }
  }

  function montarAtalhos() {
    const cont = document.getElementById("helpFabLinks");
    const primarios = document.getElementById("helpFabPrimaryLinks");
    if (!cont || typeof ManualContent === "undefined") return;
    const contextual = (() => {
      const id = document.querySelector("#mainApp .screen.tab-content:not(.hidden)")?.id || "";
      if (id === "screen-admin") {
        const sub = document.querySelector(".admin-subtab-btn.active")?.dataset.sub;
        return ({
          usuarios: "usuarios-admin", ativos: "ativos-sessoes", sessoes: "ativos-sessoes",
          logs: "logs-dispositivos", dispositivos: "logs-dispositivos", acessos: "logs-dispositivos",
          notificacoes: "notificacoes", proprietarios: "proprietarios-admin", mapa: "proprietarios-admin",
          energia: "energia", monitoramento: "monitoramento", macs: "esp32-cadastro",
          config: "configuracoes-globais", esp32: "esp32-avancado", relatos: "relatos-gestao",
          auditoria: "auditoria",
        })[sub] || "administracao";
      }
      return ({ "screen-panel": "controlador", "screen-agenda": "agenda-grade", "screen-grade": "agenda-grade", "screen-propriedade": "controle-acesso-sala", "screen-inicio": "inicio-acoes" })[id] || "selecao-sala";
    })();
    if (primarios) {
      primarios.innerHTML = `<button type="button" class="btn btn-on btn-block" data-sec="${contextual}">Ajuda desta página</button><button type="button" id="helpFabManualBtn" class="btn btn-off btn-block" data-sec="">Manual completo</button><button type="button" class="link-btn" data-sec="solucao-problemas">Solução de problemas</button><button type="button" class="link-btn" data-help-action="report">Relatar problema</button><button type="button" class="link-btn" data-help-action="mobile">Aplicativo móvel</button>`;
      primarios.querySelectorAll("[data-sec]").forEach((btn) => btn.addEventListener("click", () => {
        document.getElementById("helpFabPanel").classList.add("hidden");
        abrir(btn.dataset.sec || null);
      }));
      primarios.querySelector('[data-help-action="report"]').addEventListener("click", (evento) => {
        // Sem isto, o fechamento global por clique no documento fecharia o painel de relatos recém-aberto.
        evento.stopPropagation();
        document.getElementById("helpFabPanel").classList.add("hidden");
        // Abre explicitamente (Relatos fecha o painel de notificações), sem alternar.
        if (typeof Relatos !== "undefined") Relatos.abrirPainel();
      });
      primarios.querySelector('[data-help-action="mobile"]').addEventListener("click", () => {
        document.getElementById("helpFabPanel").classList.add("hidden");
        if (typeof MobileApp !== "undefined") MobileApp.abrir();
      });
    }
    const idsAtalho = [...ATALHOS, ...(state.isAdmin ? ["administracao"] : []), ...(state.isSuperAdmin ? ["monitoramento", "operacao-admin"] : [])];
    const disponiveis = [...ManualContent.secoes, ...(typeof RoleDocumentation !== "undefined" ? RoleDocumentation.secoes() : [])];
    cont.innerHTML = idsAtalho.map((id) => {
      const s = disponiveis.find((x) => x.id === id && papelPermitido(x.papel));
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

  const fecharBtn = document.getElementById("manualFecharBtn");
  if (fecharBtn) fecharBtn.addEventListener("click", () => fechar());
  const voltarBtn = document.getElementById("manualVoltarBtn");
  if (voltarBtn) voltarBtn.addEventListener("click", () => fechar());
  if (buscaEl) buscaEl.addEventListener("input", filtrar);
  const fabToggle = document.getElementById("helpFabToggleBtn");
  if (fabToggle) {
    fabToggle.addEventListener("click", async () => {
      await garantirConteudo();
      if (typeof RoleDocumentation !== "undefined") await RoleDocumentation.carregar();
      montarAtalhos();
    });
  }

  return {
    abrir,
    fechar,
    estaAberto: () => aberto,
    secaoAtual: () => secaoAtual,
  };
})();

const HelpQuickMenu = {
  abrir() {
    const painel = document.getElementById("helpFabPanel");
    const botao = document.getElementById("helpFabToggleBtn");
    if (painel.classList.contains("hidden")) botao.click();
    const primeiro = painel.querySelector("button:not(.a11y-close-btn)");
    if (primeiro) primeiro.focus();
  },
};

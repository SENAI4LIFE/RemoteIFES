/*
 * RemoteIFES Operations Console: interface.
 *
 * Rendering rule: nothing from the server, Git, GitHub, the journal or the file system goes through
 * innerHTML. Everything is inserted with textContent or through nodes created here. Commit
 * messages, workflow names, file names and log lines are hostile content by definition.
 */
(function () {
  "use strict";

  var estado = {
    csrf: null,
    operador: null,
    elevada: false,
    elevacaoAte: 0,
    area: "inicio",
    sub: { atualizacoes: "remoteifes", aplicativos: "web" },
    painel: null,
    atualizacao: null,
    programa: null,
    mobile: null,
    ci: null,
    ciEm: 0,
    acoes: [],
    fluxo: null,
    runAberto: null,
    runRelogio: null,
    desinstalando: false,
  };

  // First-access invitation opened by the launcher. It is read once from the URL fragment (never
  // sent to the server in a request line) and removed from the address bar and the history before
  // any request is made.
  var conviteInicial = (function () {
    var m = /(?:^#|&)primeiro-acesso=([A-Za-z0-9_-]{32,128})(?:&|$)/.exec(window.location.hash || "");
    if (!m) return null;
    try { window.history.replaceState(null, "", window.location.pathname + window.location.search); } catch (e) {}
    return m[1];
  })();

  // --- DOM helpers -------------------------------------------------------------------------

  function $(id) { return document.getElementById(id); }

  function limpar(no) { while (no.firstChild) no.removeChild(no.firstChild); return no; }

  function el(tag, props, filhos) {
    var n = document.createElement(tag);
    props = props || {};
    if (props.classe) n.className = props.classe;
    if (props.texto !== undefined && props.texto !== null) n.textContent = String(props.texto);
    if (props.attrs) Object.keys(props.attrs).forEach(function (k) { if (props.attrs[k] !== null && props.attrs[k] !== undefined) n.setAttribute(k, props.attrs[k]); });
    if (props.on) Object.keys(props.on).forEach(function (k) { n.addEventListener(k, props.on[k]); });
    if (props.oculto) n.hidden = true;
    (filhos || []).forEach(function (f) {
      if (f === null || f === undefined || f === false) return;
      n.appendChild(typeof f === "string" || typeof f === "number" ? document.createTextNode(String(f)) : f);
    });
    return n;
  }

  function icone(nome, classe) {
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "icone" + (classe ? " " + classe : ""));
    svg.setAttribute("aria-hidden", "true");
    var use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "#" + nome);
    svg.appendChild(use);
    return svg;
  }

  function bolha(nome, tom, variante) {
    return el("span", { classe: "bolha" + (variante ? " " + variante : ""), attrs: { "aria-hidden": "true" } }, [icone(nome, tom)]);
  }

  function chip(nivel, texto, extra) {
    return el("span", { classe: "chip " + (nivel || "") + (extra ? " " + extra : ""), texto: texto });
  }

  function rico(texto) {
    var frag = document.createDocumentFragment();
    String(texto).split("**").forEach(function (parte, i) {
      if (!parte) return;
      frag.appendChild(i % 2 ? el("strong", { texto: parte }) : document.createTextNode(parte));
    });
    return frag;
  }

  function botao(texto, opcoes) {
    opcoes = opcoes || {};
    var b = el("button", { classe: "btn " + (opcoes.classe || ""), attrs: { type: "button", "aria-label": opcoes.rotulo || null } }, [
      opcoes.icone ? icone(opcoes.icone) : null,
      el("span", { texto: texto }),
    ]);
    if (opcoes.desabilitado) b.disabled = true;
    if (opcoes.aoClicar) b.addEventListener("click", opcoes.aoClicar);
    return b;
  }

  function linkExterno(texto, href, classe) {
    return el("a", { classe: "btn " + (classe || "contorno"), attrs: { href: href, target: "_blank", rel: "noopener noreferrer" } }, [icone("i-externo"), el("span", { texto: texto })]);
  }

  function cartao(opcoes, filhos) {
    var cab = null;
    if (opcoes.titulo) {
      cab = el("div", { classe: "cartao-cabecalho" }, [
        opcoes.icone ? bolha(opcoes.icone, opcoes.tom || "tom-operacao", opcoes.variante) : null,
        el("div", { classe: "titulo" }, [el(opcoes.nivel || "h2", { texto: opcoes.titulo }), opcoes.descricao ? el("p", { texto: opcoes.descricao }) : null]),
        opcoes.lado || null,
      ]);
    }
    return el("div", { classe: "cartao" + (opcoes.classe ? " " + opcoes.classe : ""), attrs: { id: opcoes.id || null } }, [cab].concat(filhos || []));
  }

  function aviso(nivel, titulo, texto, acoes) {
    var mapa = { erro: "i-circulo-x", alerta: "i-aviso", info: "i-info", ok: "i-circulo-check" };
    return el("div", { classe: "aviso " + nivel, attrs: { role: nivel === "erro" ? "alert" : null } }, [
      icone(mapa[nivel] || "i-info"),
      el("div", {}, [titulo ? el("strong", { texto: titulo }) : null, texto ? el("p", {}, [rico(texto)]) : null, acoes && acoes.length ? el("div", { classe: "acoes" }, acoes) : null]),
    ]);
  }

  function vazio(nome, tom, titulo, texto, acoes) {
    return el("div", { classe: "vazio" }, [
      bolha(nome, tom, "grande"),
      el("strong", { texto: titulo }),
      texto ? el("p", { texto: texto }) : null,
      acoes && acoes.length ? el("div", { classe: "acoes" }, acoes) : null,
    ]);
  }

  function fatos(pares) {
    var dl = el("dl", { classe: "fatos" });
    pares.forEach(function (p) {
      if (!p) return;
      var valor = p[1];
      var semValor = valor === null || valor === undefined || valor === "";
      dl.appendChild(el("div", { classe: "fato" }, [
        el("dt", { texto: p[0] }),
        el("dd", { classe: semValor ? "sem-valor" : p[2] || null, texto: semValor ? "desconhecido" : valor }),
      ]));
    });
    return dl;
  }

  function detalhes(titulo, filhos, aoAbrir) {
    var d = el("details", { classe: "detalhes" }, [el("summary", { texto: titulo }), el("div", { classe: "corpo" }, filhos)]);
    if (aoAbrir) {
      var aberto = false;
      d.addEventListener("toggle", function () { if (d.open && !aberto) { aberto = true; aoAbrir(d.querySelector(".corpo")); } });
    }
    return d;
  }

  function comando(texto) {
    var pre = el("pre", { texto: texto, attrs: { tabindex: "0" } });
    return el("div", { classe: "comando" }, [
      pre,
      botao("Copiar", { classe: "pequeno contorno", icone: "i-copiar", rotulo: "Copiar comando", aoClicar: function () { copiar(texto); } }),
    ]);
  }

  function copiar(texto) {
    function fallback() {
      var area = el("textarea", { texto: texto, attrs: { readonly: "readonly" } });
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) {}
      area.remove();
      toast(ok ? "Copiado." : "Não foi possível copiar; selecione o texto e copie.", ok ? "ok" : "erro");
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(texto).then(function () { toast("Copiado.", "ok"); }, fallback);
    } else {
      fallback();
    }
  }

  // --- Formatting ---------------------------------------------------------------------------

  function bytes(n) {
    if (n === null || n === undefined || !isFinite(n)) return null;
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1).replace(".", ",") + " KiB";
    if (n < 1073741824) return (n / 1048576).toFixed(1).replace(".", ",") + " MiB";
    return (n / 1073741824).toFixed(2).replace(".", ",") + " GiB";
  }

  function duracao(s) {
    if (s === null || s === undefined || !isFinite(s)) return null;
    s = Math.max(0, s);
    if (s < 60) return Math.round(s) + " s";
    if (s < 3600) return Math.round(s / 60) + " min";
    if (s < 86400) return (s / 3600).toFixed(1).replace(".", ",") + " h";
    return (s / 86400).toFixed(1).replace(".", ",") + " dias";
  }

  function quando(iso) {
    if (!iso) return null;
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
  }

  function haQuanto(iso) {
    if (!iso) return null;
    var t = Date.parse(iso);
    if (isNaN(t)) return null;
    var s = (Date.now() - t) / 1000;
    return s < 60 ? "agora" : "há " + duracao(s);
  }

  function contar(n, singular, plural) { return n + " " + (n === 1 ? singular : plural); }

  function curto(commit) { return commit ? String(commit).slice(0, 8) : null; }

  // --- Network ----------------------------------------------------------------------------

  function api(caminho, opcoes) {
    opcoes = opcoes || {};
    var cfg = { method: opcoes.method || "GET", headers: {}, credentials: "same-origin" };
    if (opcoes.corpo !== undefined) {
      cfg.headers["Content-Type"] = "application/json";
      cfg.body = JSON.stringify(opcoes.corpo);
    }
    if (cfg.method !== "GET" && cfg.method !== "HEAD" && estado.csrf) cfg.headers["X-Console-CSRF"] = estado.csrf;
    return fetch(caminho, cfg).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (corpo) {
        if (r.status === 401 && estado.operador && caminho !== "/api/sessao/elevar") mostrarEntrada("Sua sessão terminou. Entre novamente.");
        return { status: r.status, ok: r.ok, corpo: corpo || {} };
      });
    }, function () {
      return { status: 0, ok: false, corpo: { erro: "sem conexão com o console" } };
    });
  }

  // --- Toasts ---------------------------------------------------------------------------------

  function toast(texto, nivel) {
    var pilha = $("toasts");
    var mapa = { erro: "i-circulo-x", alerta: "i-aviso", ok: "i-circulo-check", info: "i-info" };
    var t = el("p", { classe: "toast " + (nivel || "ok"), attrs: { role: nivel === "erro" ? "alert" : "status" } }, [icone(mapa[nivel] || "i-circulo-check"), el("span", { texto: texto })]);
    t.addEventListener("click", function () { t.remove(); });
    pilha.appendChild(t);
    while (pilha.children.length > 3) pilha.removeChild(pilha.firstChild);
    setTimeout(function () { t.remove(); }, nivel === "erro" ? 9000 : 5000);
  }

  // --- Accessibility ----------------------------------------------------------------------------

  var A11Y_CHAVE = "remoteifes_console_a11y";
  var ESCALAS = [0.85, 0.9, 1, 1.1, 1.2, 1.3, 1.45, 1.6, 1.75, 1.9, 2];
  var ESPACAMENTOS = [0, 0.02, 0.04, 0.06, 0.09, 0.12];
  var ALTURAS = [1.3, 1.5, 1.7, 1.9, 2.1, 2.4, 2.8];
  var A11Y_PADRAO = { escala: 2, espacamento: 0, altura: 1, fonte: "padrao", contraste: false, links: false, semAnimacao: false };
  var a11y = lerA11y();

  function lerA11y() {
    var salvo = null;
    try { salvo = JSON.parse(window.localStorage.getItem(A11Y_CHAVE) || "null"); } catch (e) {}
    var v = {};
    Object.keys(A11Y_PADRAO).forEach(function (k) { v[k] = salvo && typeof salvo[k] === typeof A11Y_PADRAO[k] ? salvo[k] : A11Y_PADRAO[k]; });
    v.escala = Math.min(ESCALAS.length - 1, Math.max(0, v.escala | 0));
    v.espacamento = Math.min(ESPACAMENTOS.length - 1, Math.max(0, v.espacamento | 0));
    v.altura = Math.min(ALTURAS.length - 1, Math.max(0, v.altura | 0));
    if (["padrao", "serif", "sans", "dislexia"].indexOf(v.fonte) < 0) v.fonte = "padrao";
    return v;
  }

  function salvarA11y() {
    try { window.localStorage.setItem(A11Y_CHAVE, JSON.stringify(a11y)); } catch (e) {}
  }

  function aplicarA11y() {
    var raiz = document.documentElement.style;
    raiz.setProperty("--a11y-escala", ESCALAS[a11y.escala]);
    raiz.setProperty("--a11y-espacamento", ESPACAMENTOS[a11y.espacamento] + "em");
    raiz.setProperty("--a11y-altura", ALTURAS[a11y.altura]);
    var b = document.body.classList;
    ["serif", "sans", "dislexia"].forEach(function (f) { b.toggle("a11y-fonte-" + f, a11y.fonte === f); });
    b.toggle("a11y-contraste", a11y.contraste);
    b.toggle("a11y-links", a11y.links);
    b.toggle("a11y-sem-animacao", a11y.semAnimacao);
    $("a11yEscala").value = a11y.escala;
    $("a11yEscalaValor").textContent = Math.round(ESCALAS[a11y.escala] * 100) + "%";
    $("a11yEspacamento").value = a11y.espacamento;
    $("a11yEspacamentoValor").textContent = String(ESPACAMENTOS[a11y.espacamento]).replace(".", ",");
    $("a11yAltura").value = a11y.altura;
    $("a11yAlturaValor").textContent = String(ALTURAS[a11y.altura]).replace(".", ",");
    document.querySelectorAll("[data-a11y-fonte]").forEach(function (bt) { bt.setAttribute("aria-pressed", String(bt.getAttribute("data-a11y-fonte") === a11y.fonte)); });
    document.querySelectorAll("[data-a11y-alternar]").forEach(function (bt) { bt.setAttribute("aria-pressed", String(!!a11y[bt.getAttribute("data-a11y-alternar")])); });
  }

  function mudarA11y(chave, valor) {
    a11y[chave] = valor;
    salvarA11y();
    aplicarA11y();
  }

  function ligarA11y() {
    var limites = { escala: ESCALAS.length - 1, espacamento: ESPACAMENTOS.length - 1, altura: ALTURAS.length - 1 };
    var campos = { escala: "a11yEscala", espacamento: "a11yEspacamento", altura: "a11yAltura" };
    Object.keys(campos).forEach(function (k) {
      $(campos[k]).addEventListener("input", function (ev) { mudarA11y(k, Number(ev.target.value)); });
    });
    document.querySelectorAll("[data-a11y-passo]").forEach(function (bt) {
      bt.addEventListener("click", function () {
        var k = bt.getAttribute("data-a11y-passo");
        mudarA11y(k, Math.min(limites[k], Math.max(0, a11y[k] + Number(bt.getAttribute("data-delta")))));
      });
    });
    document.querySelectorAll("[data-a11y-fonte]").forEach(function (bt) {
      bt.addEventListener("click", function () { mudarA11y("fonte", bt.getAttribute("data-a11y-fonte")); });
    });
    document.querySelectorAll("[data-a11y-alternar]").forEach(function (bt) {
      bt.addEventListener("click", function () { var k = bt.getAttribute("data-a11y-alternar"); mudarA11y(k, !a11y[k]); });
    });
    $("a11yRedefinir").addEventListener("click", function () {
      a11y = JSON.parse(JSON.stringify(A11Y_PADRAO));
      salvarA11y();
      aplicarA11y();
      toast("Preferências de acessibilidade redefinidas.", "ok");
    });
  }

  // --- Floating panels --------------------------------------------------------------------------

  var PAINEIS = { painelAjuda: "btnAjuda", painelA11y: "btnA11y" };

  function alternarPainel(id, abrir) {
    var painel = $(id);
    var aberto = abrir === undefined ? painel.hidden : abrir;
    Object.keys(PAINEIS).forEach(function (outro) {
      if (outro !== id || !aberto) {
        $(outro).hidden = true;
        $(PAINEIS[outro]).setAttribute("aria-expanded", "false");
      }
    });
    if (aberto) {
      painel.hidden = false;
      $(PAINEIS[id]).setAttribute("aria-expanded", "true");
      if (id === "painelAjuda") prepararAjuda();
      var foco = painel.querySelector("button, input");
      if (foco) foco.focus();
    }
  }

  function fecharMenus() {
    $("menuConta").hidden = true;
    $("btnConta").setAttribute("aria-expanded", "false");
  }

  // --- Help and manual ----------------------------------------------------------------------------

  var AJUDA_AREA = {
    inicio: { secao: "o-que-e", contexto: "O Início mostra primeiro o que precisa de atenção e as tarefas mais frequentes.", links: ["acesso", "sessao", "problemas"] },
    servico: { secao: "servico", contexto: "Serviço e registros controla o RemoteIFES no host e mostra o journal.", links: ["problemas", "terminal"] },
    atualizacoes: { secao: "atualizacoes-remoteifes", contexto: "RemoteIFES e Console de Operações são atualizados e revertidos separadamente.", links: ["atualizacoes-console", "dados"] },
    dados: { secao: "dados", contexto: "Backups do banco, restauração e recuperação da conta do superadministrador.", links: ["terminal", "problemas"] },
    rede: { secao: "rede", contexto: "Modo de teste, faixas autorizadas e diagnóstico de domínio e certificado.", links: ["web"] },
    aplicativos: { secao: "web", contexto: "Site e PWA, Android, iOS e builds no GitHub Actions, com a credencial que exigem.", links: ["android", "ios", "ci", "credencial"] },
    console: { secao: "console", contexto: "O programa do console: versão, plataforma, instalação e desinstalação.", links: ["desinstalar", "atualizacoes-console"] },
    seguranca: { secao: "seguranca", contexto: "Sessão, elevação, histórico de operações, auditoria e Terminal Expert.", links: ["sessao"] },
  };
  var AJUDA_SUB = { "aplicativos/android": "android", "aplicativos/ios": "ios", "aplicativos/ci": "ci", "aplicativos/credenciais": "credencial", "atualizacoes/console": "atualizacoes-console" };

  function secaoManual(id) {
    for (var i = 0; i < MANUAL_CONSOLE.length; i++) if (MANUAL_CONSOLE[i].id === id) return MANUAL_CONSOLE[i];
    return null;
  }

  function prepararAjuda() {
    var info = AJUDA_AREA[estado.area] || AJUDA_AREA.inicio;
    var secao = AJUDA_SUB[estado.area + "/" + (estado.sub[estado.area] || "")] || info.secao;
    $("ajudaContexto").textContent = info.contexto;
    $("btnAjudaArea").onclick = function () { alternarPainel("painelAjuda", false); abrirManual(secao); };
    var ul = limpar($("ajudaLinks"));
    var ids = [secao].concat(info.links, ["problemas", "acessibilidade"]).filter(function (id, i, todos) { return todos.indexOf(id) === i; }).slice(1);
    ids.forEach(function (id) {
      var s = secaoManual(id);
      if (!s) return;
      ul.appendChild(el("li", {}, [el("button", { classe: "btn link", texto: s.titulo, attrs: { type: "button" }, on: { click: function () { alternarPainel("painelAjuda", false); abrirManual(id); } } })]));
    });
  }

  var manualFocoAnterior = null;

  function normalizar(t) { return String(t).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase(); }

  function textoDaSecao(s) {
    return [s.titulo].concat(s.blocos.map(function (b) { return b.texto || (b.itens || []).join(" "); })).join(" ");
  }

  function destacar(texto, termo) {
    var frag = document.createDocumentFragment();
    if (!termo) { frag.appendChild(rico(texto)); return frag; }
    String(texto).split("**").forEach(function (parte, i) {
      var alvo = i % 2 ? el("strong") : frag;
      var baixo = parte.toLowerCase();
      var pos = 0;
      var achou = baixo.indexOf(termo, pos);
      while (achou >= 0 && termo) {
        alvo.appendChild(document.createTextNode(parte.slice(pos, achou)));
        alvo.appendChild(el("mark", { texto: parte.slice(achou, achou + termo.length) }));
        pos = achou + termo.length;
        achou = baixo.indexOf(termo, pos);
      }
      alvo.appendChild(document.createTextNode(parte.slice(pos)));
      if (i % 2) frag.appendChild(alvo);
    });
    return frag;
  }

  function renderBloco(b, termo) {
    if (b.t === "p") return el("p", {}, [destacar(b.texto, termo)]);
    if (b.t === "h") return el("h4", { texto: b.texto });
    if (b.t === "comando") return comando(b.texto);
    if (b.t === "aviso") return aviso(b.nivel || "info", null, b.texto);
    var lista = el(b.t === "passos" ? "ol" : "ul");
    b.itens.forEach(function (i) { lista.appendChild(el("li", {}, [destacar(i, termo)])); });
    return lista;
  }

  function renderManual(termo, alvo) {
    var busca = normalizar(termo || "").trim();
    var texto = limpar($("manualTexto"));
    var sumario = limpar($("manualSumario"));
    var grupoAtual = null;
    var ul = null;
    var encontrados = 0;
    MANUAL_CONSOLE.forEach(function (s) {
      var casa = !busca || normalizar(textoDaSecao(s)).indexOf(busca) >= 0;
      if (!casa) return;
      encontrados++;
      if (s.grupo !== grupoAtual) {
        grupoAtual = s.grupo;
        sumario.appendChild(el("p", { classe: "grupo", texto: s.grupo }));
        ul = el("ul");
        sumario.appendChild(ul);
      }
      ul.appendChild(el("li", {}, [el("button", { texto: s.titulo, attrs: { type: "button", "data-secao": s.id }, on: { click: function () { irParaSecao(s.id); } } })]));
      var sec = el("section", { classe: "manual-secao", attrs: { id: "manual-" + s.id, "aria-labelledby": "manual-titulo-" + s.id, tabindex: "-1" } }, [
        el("p", { classe: "grupo", texto: s.grupo }),
        el("h3", { texto: s.titulo, attrs: { id: "manual-titulo-" + s.id } }),
      ]);
      var termoSimples = (termo || "").trim().toLowerCase();
      s.blocos.forEach(function (b) { sec.appendChild(renderBloco(b, termoSimples)); });
      texto.appendChild(sec);
    });
    if (!encontrados) texto.appendChild(el("p", { classe: "manual-sem-resultado", texto: "Nenhuma seção do manual menciona esse termo." }));
    if (alvo) irParaSecao(alvo);
  }

  function irParaSecao(id) {
    var sec = $("manual-" + id);
    if (!sec) return;
    document.querySelectorAll("#manualSumario button").forEach(function (b) { b.setAttribute("aria-current", String(b.getAttribute("data-secao") === id)); });
    sec.scrollIntoView({ block: "start" });
    sec.focus({ preventScroll: true });
  }

  function abrirManual(secao) {
    manualFocoAnterior = document.activeElement;
    $("manualBusca").value = "";
    $("manual").hidden = false;
    var app = estado.operador ? $("telaConsole") : $("telaEntrada");
    app.inert = true;
    renderManual("", secao || null);
    if (!secao) $("manualBusca").focus();
  }

  function fecharManual() {
    $("manual").hidden = true;
    $("telaConsole").inert = false;
    $("telaEntrada").inert = false;
    if (manualFocoAnterior && manualFocoAnterior.focus) manualFocoAnterior.focus();
  }

  // --- Entry, session and elevation -----------------------------------------------------------

  function usarConvite(ativo) {
    $("paCampoSegredo").hidden = ativo;
    $("paSegredo").required = !ativo;
    $("paAvisoConvite").hidden = !ativo;
    $("paAvisoSegredo").hidden = ativo;
  }

  function mostrarEntrada(mensagem, nivel) {
    estado.operador = null;
    estado.csrf = null;
    estado.elevada = false;
    pararRun();
    fecharTerminalLocal();
    document.querySelectorAll("dialog[open]").forEach(function (d) { d.close(); });
    $("telaConsole").hidden = true;
    $("telaEncerrado").hidden = true;
    $("telaEntrada").hidden = false;
    var caixa = limpar($("entradaAviso"));
    if (mensagem) caixa.appendChild(aviso(nivel || "alerta", null, mensagem));
    api("/api/sessao").then(function (r) {
      var bootstrap = r.corpo && r.corpo.precisaBootstrap;
      $("formLogin").hidden = !!bootstrap;
      $("formPrimeiroAcesso").hidden = !bootstrap;
      $("entradaTitulo").textContent = bootstrap ? "Primeiro acesso ao console" : "Entrar no console";
      if (bootstrap) {
        usarConvite(!!conviteInicial);
        (conviteInicial ? $("paNome") : $("paSegredo")).focus();
      } else {
        $("loginNome").focus();
      }
    });
  }

  function entrarNoConsole(sessao) {
    estado.operador = sessao.operador;
    estado.csrf = sessao.csrf;
    definirElevacao(!!sessao.elevada, sessao.restanteElevacaoS || 0);
    $("telaEntrada").hidden = true;
    $("telaConsole").hidden = false;
    $("btnConta").textContent = sessao.operador.slice(0, 2).toUpperCase();
    $("btnConta").setAttribute("aria-label", "Conta de " + sessao.operador);
    $("menuContaNome").textContent = sessao.operador;
    api("/api/acoes").then(function (r) {
      if (r.ok) estado.acoes = r.corpo.acoes;
      rotear();
    });
    api("/api/programa").then(function (r) {
      if (!r.ok) return;
      estado.programa = r.corpo;
      if (r.corpo.aplicacao && r.corpo.aplicacao.url) {
        $("linkAplicacao").href = r.corpo.aplicacao.url;
        $("linkAplicacao").hidden = false;
      }
      marcarNavegacao();
      if (estado.area === "inicio" && estado.painel) renderInicio(estado.painel);
    });
    api("/api/atualizacao").then(function (r) {
      if (!r.ok) return;
      estado.atualizacao = r.corpo;
      marcarNavegacao();
      if (estado.area === "inicio" && estado.painel) renderInicio(estado.painel);
    });
  }

  var relogioElevacao = null;

  function definirElevacao(elevada, restanteS) {
    estado.elevada = elevada && restanteS > 0;
    estado.elevacaoAte = estado.elevada ? Date.now() + restanteS * 1000 : 0;
    if (relogioElevacao) clearInterval(relogioElevacao);
    relogioElevacao = null;
    pintarElevacao();
    if (estado.elevada) relogioElevacao = setInterval(pintarElevacao, 15000);
  }

  function pintarElevacao() {
    var restante = Math.max(0, Math.round((estado.elevacaoAte - Date.now()) / 1000));
    if (estado.elevada && restante <= 0) {
      estado.elevada = false;
      if (relogioElevacao) clearInterval(relogioElevacao);
    }
    var selo = $("seloElevacao");
    selo.hidden = !estado.elevada;
    $("seloElevacaoTexto").textContent = estado.elevada ? "Elevado · " + Math.max(1, Math.ceil(restante / 60)) + " min" : "";
    selo.setAttribute("aria-label", "Operações sensíveis liberadas por mais " + Math.max(1, Math.ceil(restante / 60)) + " min. Encerrar elevação.");
    if (estado.area === "seguranca") renderSessao();
  }

  function encerrarElevacao() {
    api("/api/sessao/elevar", { method: "DELETE" }).then(function () {
      definirElevacao(false, 0);
      toast("Elevação encerrada.", "ok");
      if (estado.area === "seguranca") carregarTerminal();
    });
  }

  var aoElevar = null;

  function pedirElevacao(depois) {
    aoElevar = depois || null;
    limpar($("elevErro"));
    $("elevSenha").value = "";
    $("elevUsuario").value = estado.operador || "";
    $("dlgElevacao").showModal();
    $("elevSenha").focus();
  }

  function enviarElevacao(ev) {
    ev.preventDefault();
    var senha = $("elevSenha").value;
    api("/api/sessao/elevar", { method: "POST", corpo: { senha: senha } }).then(function (r) {
      $("elevSenha").value = "";
      if (!r.ok) {
        limpar($("elevErro")).appendChild(aviso("erro", "Não liberado", r.corpo.erro || "senha incorreta"));
        $("elevSenha").focus();
        return;
      }
      definirElevacao(true, r.corpo.expiraEmS || 300);
      $("dlgElevacao").close();
      var depois = aoElevar;
      aoElevar = null;
      if (depois) depois();
      else toast("Operações sensíveis liberadas por alguns minutos.", "ok");
    });
  }

  // --- Routing ----------------------------------------------------------------------------------

  var AREAS = ["inicio", "servico", "atualizacoes", "dados", "rede", "aplicativos", "console", "seguranca"];
  var SUBS = { atualizacoes: ["remoteifes", "console"], aplicativos: ["web", "android", "ios", "ci", "credenciais"] };
  var NOMES = {
    inicio: "Início", servico: "Serviço e registros", atualizacoes: "Atualizações", dados: "Backups e recuperação",
    rede: "Rede e acesso", aplicativos: "Aplicativos e CI", console: "Console instalado", seguranca: "Segurança e auditoria",
  };

  function irPara(area, sub) {
    var alvo = "#/" + area + (sub ? "/" + sub : "");
    if (window.location.hash === alvo) rotear();
    else window.location.hash = alvo;
  }

  function rotear() {
    if (!estado.operador) return;
    var partes = (window.location.hash || "").replace(/^#\/?/, "").split("/");
    var area = AREAS.indexOf(partes[0]) >= 0 ? partes[0] : "inicio";
    if (SUBS[area]) estado.sub[area] = SUBS[area].indexOf(partes[1]) >= 0 ? partes[1] : estado.sub[area];
    var mudou = estado.area !== area;
    estado.area = area;
    document.querySelectorAll("[data-painel]").forEach(function (p) { p.hidden = p.getAttribute("data-painel") !== area; });
    document.querySelectorAll(".nav-item, .aba-inferior").forEach(function (b) {
      var a = b.getAttribute("data-area");
      var ativo = a === area || (a === "mais" && ["dados", "rede", "console", "seguranca"].indexOf(area) >= 0);
      if (ativo) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    });
    if (SUBS[area]) mostrarSub(area, estado.sub[area]);
    document.title = NOMES[area] + " — Console de Operações";
    if (area !== "aplicativos") pararRun();
    carregarArea(area);
    if (mudou) {
      window.scrollTo(0, 0);
      $("conteudo").focus({ preventScroll: true });
    }
  }

  function mostrarSub(area, sub) {
    var lista = document.querySelector('[data-subabas="' + area + '"]');
    lista.querySelectorAll("[role=tab]").forEach(function (t) {
      var ativo = t.getAttribute("data-sub") === sub;
      t.setAttribute("aria-selected", String(ativo));
      t.tabIndex = ativo ? 0 : -1;
    });
    document.querySelectorAll('[data-painel="' + area + '"] [data-subpainel]').forEach(function (p) { p.hidden = p.getAttribute("data-subpainel") !== sub; });
  }

  function carregarArea(area) {
    if (area === "inicio") carregarPainel();
    if (area === "servico") carregarPainel();
    if (area === "atualizacoes") (estado.sub.atualizacoes === "console" ? carregarAtualizacaoConsole : carregarAtualizacao)();
    if (area === "dados") carregarDados();
    if (area === "rede") carregarAcessoRede();
    if (area === "aplicativos") carregarAplicativos();
    if (area === "console") carregarConsole();
    if (area === "seguranca") carregarSeguranca();
  }

  function marcarNavegacao() {
    var p = estado.painel;
    var marcas = {};
    if (p) {
      var app = p.aplicacao || {};
      if (!app.respondeu || !app.ok) marcas.servico = "erro";
      else if (p.watchdog && p.watchdog.suportado && !p.watchdog.ativo) marcas.servico = "alerta";
      if (p.bancoQuarentenado > 0 || (p.manutencao && p.manutencao.residuo)) marcas.dados = "alerta";
      if (atencoes(p).length) marcas.inicio = atencoes(p).some(function (a) { return a.nivel === "erro"; }) ? "erro" : "alerta";
    }
    var subs = {};
    var a = estado.atualizacao;
    if (a && a.comparacao && a.comparacao.conhecido && a.comparacao.atrasado) { marcas.atualizacoes = "alerta"; subs.remoteifes = "alerta"; }
    var c = estado.programa && estado.programa.console;
    if (c && ((c.podeAtualizar && c.disponivel) || c.reversaoAutomatica || (c.divergenciaDeVersao && !c.divergenciaDeVersao.reinicioPendente))) { marcas.atualizacoes = "alerta"; subs.console = "alerta"; }
    if (c && c.reversaoAutomatica) marcas.console = "alerta";
    document.querySelectorAll("[data-marcador]").forEach(function (m) {
      var n = marcas[m.getAttribute("data-marcador")];
      m.hidden = !n;
      m.className = "marcador" + (n === "erro" ? " erro" : "");
    });
    var mob = estado.mobile;
    if (mob) {
      if (!mob.credencialGitHub.presente) subs.credenciais = "alerta";
      if (mob.release.destino && mob.release.destino.divergem) subs.android = "alerta";
    }
    var ci = estado.ci;
    if (ci && ci.disponivel && ci.ci && ci.ci[0] && ci.ci[0].conclusao === "failure") subs.ci = "erro";
    document.querySelectorAll("[data-marcador-sub]").forEach(function (m) {
      var n = subs[m.getAttribute("data-marcador-sub")];
      m.hidden = !n;
      m.className = "marcador" + (n === "erro" ? " erro" : "");
      m.setAttribute("aria-label", n === "erro" ? "falha" : "precisa de atenção");
      m.setAttribute("role", "img");
    });
  }

  // --- Actions ----------------------------------------------------------------------------------

  function acaoPorId(id) {
    for (var i = 0; i < estado.acoes.length; i++) if (estado.acoes[i].id === id) return estado.acoes[i];
    return null;
  }

  function executarAcao(id, argumentos, opcoes) {
    opcoes = opcoes || {};
    var acao = acaoPorId(id);
    if (!acao) { toast("Operação indisponível nesta versão do console.", "erro"); return; }
    api("/api/acoes/" + encodeURIComponent(id) + "/preparar", { method: "POST", corpo: { argumentos: argumentos || {} } }).then(function (r) {
      if (!r.ok) { toast(r.corpo.erro || "não foi possível preparar a operação", "erro"); return; }
      if (opcoes.direto && !r.corpo.impedimento && !r.corpo.acao.confirmacao && !(r.corpo.prontidao && (r.corpo.prontidao.bloqueios.length || r.corpo.prontidao.avisos.length))) {
        enviarAcao(acao, { argumentos: argumentos || {}, aceitarAvisos: true }, opcoes);
        return;
      }
      confirmarAcao(acao, argumentos || {}, r.corpo, opcoes);
    });
  }

  function confirmarAcao(acao, argumentos, preparo, opcoes) {
    var dlg = $("dlgAcao");
    $("dlgAcaoTitulo").textContent = opcoes.titulo || preparo.acao.rotulo;
    var corpo = limpar($("dlgAcaoCorpo"));
    if (opcoes.contexto) corpo.appendChild(el("p", {}, [el("strong", { texto: opcoes.contexto })]));
    corpo.appendChild(el("p", { texto: preparo.acao.proposito }));
    var destrutiva = !!preparo.acao.confirmacao;
    corpo.appendChild(aviso(destrutiva ? "erro" : "alerta", "Impacto", preparo.acao.impacto));
    var impedido = false;
    if (preparo.impedimento) {
      impedido = true;
      corpo.appendChild(aviso("erro", "Não é possível agora", preparo.impedimento));
    }
    var p = preparo.prontidao;
    if (p) {
      if (p.bloqueios.length) impedido = true;
      p.bloqueios.forEach(function (b) { corpo.appendChild(aviso("erro", b.titulo, b.detalhe)); });
      p.avisos.forEach(function (a) { corpo.appendChild(aviso("alerta", a.titulo, a.detalhe)); });
      if (p.informacoes.length) {
        corpo.appendChild(detalhes("Situação avaliada (" + p.informacoes.length + ")", p.informacoes.map(function (i) {
          return el("p", {}, [el("strong", { texto: i.titulo + ": " }), i.detalhe]);
        })));
      }
      corpo.appendChild(el("p", { classe: "fraco pequeno", texto: "Avaliado em " + quando(p.avaliadoEm) + ". A situação é avaliada de novo no instante da execução." }));
    }
    if (preparo.acao.exigeElevacao && !impedido) {
      corpo.appendChild(el("p", { classe: "fraco pequeno" }, [icone("i-cadeado", "tom-atencao"), " ", estado.elevada ? "Operações sensíveis estão liberadas nesta sessão." : "A senha do operador será pedida ao confirmar."]));
    }
    var campo = null;
    if (!impedido && destrutiva) {
      campo = el("input", { attrs: { type: "text", id: "campoConfirmacao", autocomplete: "off", autocapitalize: "none", spellcheck: "false" } });
      corpo.appendChild(el("div", { classe: "campo" }, [el("label", { texto: 'Para confirmar, digite "' + preparo.acao.confirmacao + '"', attrs: { for: "campoConfirmacao" } }), campo]));
    }
    var confirmar = $("dlgAcaoConfirmar");
    confirmar.disabled = impedido;
    confirmar.textContent = impedido ? "Indisponível" : opcoes.textoConfirmar || preparo.acao.rotulo;
    confirmar.className = "btn " + (destrutiva ? "perigo" : "primario");
    confirmar.onclick = function () {
      var carga = { argumentos: argumentos, aceitarAvisos: true };
      if (destrutiva) {
        carga.confirmacao = campo ? campo.value.trim() : "";
        if (carga.confirmacao.toLowerCase() !== preparo.acao.confirmacao) {
          toast('Digite exatamente "' + preparo.acao.confirmacao + '" para confirmar.', "erro");
          if (campo) campo.focus();
          return;
        }
      }
      dlg.close();
      enviarAcao(acao, carga, opcoes);
    };
    dlg.showModal();
    if (campo) campo.focus();
  }

  function enviarAcao(acao, carga, opcoes) {
    api("/api/acoes/" + encodeURIComponent(acao.id) + "/executar", { method: "POST", corpo: carga }).then(function (r) {
      if (r.status === 403 && r.corpo.precisaElevacao) {
        pedirElevacao(function () { enviarAcao(acao, carga, opcoes); });
        return;
      }
      if (!r.ok) {
        toast(r.corpo.erro || "a operação não pôde ser iniciada", "erro");
        return;
      }
      if (r.corpo.imediata) {
        var res = r.corpo.resultado || {};
        if (opcoes.aoConcluir) opcoes.aoConcluir(res);
        else toast(res.ok === false ? res.erro || "a operação não teve sucesso" : opcoes.mensagemOk || "Operação concluída.", res.ok === false ? "erro" : "ok");
        carregarPainel();
        return;
      }
      abrirTrabalho(r.corpo.trabalho.id, acao.id, opcoes.aoTerminar);
      carregarPainel();
    });
  }

  // --- Jobs ---------------------------------------------------------------------------------

  var ESTADOS_TRABALHO = {
    executando: ["info andamento", "em andamento", "i-circulo-reticencias", "tom-info"],
    concluido: ["ok", "concluída", "i-circulo-check", "tom-operacao"],
    falhou: ["erro", "falhou", "i-circulo-x", "tom-critico"],
    cancelado: ["alerta", "cancelada", "i-circulo-cortado", "tom-atencao"],
    desconhecido: ["alerta", "desfecho desconhecido", "i-circulo-exclamacao", "tom-atencao"],
  };

  function abrirTrabalho(id, acaoId, aoTerminar) {
    var dlg = $("dlgTrabalho");
    var saida = $("dlgTrabalhoSaida");
    var caixa = limpar($("dlgTrabalhoEstado"));
    saida.textContent = "";
    $("dlgTrabalhoTitulo").textContent = "Operação";
    if (!dlg.open) dlg.showModal();
    if (estado.fluxo) { estado.fluxo.close(); estado.fluxo = null; }
    var desinstalacao = acaoId === "console.desinstalar";
    var falhasDeConexao = 0;

    function pintar(t) {
      limpar(caixa);
      $("dlgTrabalhoTitulo").textContent = t.rotulo || t.acao;
      if (t.acao === "console.desinstalar") desinstalacao = true;
      var m = ESTADOS_TRABALHO[t.estado] || ["", t.estado, "i-info", ""];
      caixa.appendChild(el("div", { classe: "acoes" }, [chip(m[0], m[1]), t.fase ? el("span", { classe: "fraco", texto: "Fase: " + t.fase }) : null]));
      if (t.estado === "executando") caixa.appendChild(el("div", { classe: "barra" }, [el("i")]));
      if (t.irreversivel && t.estado === "executando") caixa.appendChild(aviso("alerta", "Ponto sem retorno", "A operação passou da fase em que podia ser interrompida com segurança."));
      if (t.erro) caixa.appendChild(aviso(t.estado === "desconhecido" ? "alerta" : "erro", "Resultado", t.erro));
      if (t.verificacao && t.verificacao.resumo) caixa.appendChild(aviso(t.verificacao.ok === true ? "ok" : "alerta", "Verificação", t.verificacao.resumo));
      if (t.estado === "desconhecido") caixa.appendChild(aviso("alerta", "Próximo passo", "Confira o estado atual no Início antes de repetir a operação: o efeito não pôde ser comprovado."));
      if (desinstalacao && t.estado === "executando") caixa.appendChild(aviso("info", "Esta página vai perder a conexão", "O desinstalador encerra o console. O RemoteIFES continua funcionando."));
      $("dlgTrabalhoCancelar").hidden = t.estado !== "executando" || t.cancelavel === false;
      $("dlgTrabalhoCancelar").disabled = !!t.irreversivel;
    }

    api("/api/trabalhos/" + encodeURIComponent(id)).then(function (r) {
      if (!r.ok) return;
      pintar(r.corpo);
      $("dlgTrabalhoCancelar").onclick = function () {
        api("/api/trabalhos/" + encodeURIComponent(id) + "/cancelar", { method: "POST" }).then(function (rc) {
          if (rc.status === 403 && rc.corpo.precisaElevacao) { pedirElevacao(function () { $("dlgTrabalhoCancelar").click(); }); return; }
          if (!rc.ok) toast(rc.corpo.erro || "não foi possível cancelar", "erro");
        });
      };
      if (r.corpo.estado !== "executando") {
        api("/api/trabalhos/" + encodeURIComponent(id) + "/saida").then(function (rs) { if (rs.ok) saida.textContent = rs.corpo.texto || ""; });
        return;
      }
      var fonte = new EventSource("/api/trabalhos/" + encodeURIComponent(id) + "/eventos");
      estado.fluxo = fonte;
      fonte.addEventListener("saida", function (ev) {
        falhasDeConexao = 0;
        try {
          var d = JSON.parse(ev.data);
          saida.textContent += d.texto;
          saida.scrollTop = saida.scrollHeight;
        } catch (e) {}
      });
      fonte.addEventListener("fim", function (ev) {
        var final = null;
        try { final = JSON.parse(ev.data); pintar(final); } catch (e) {}
        fonte.close();
        estado.fluxo = null;
        carregarPainel();
        if (estado.area === "rede") carregarAcessoRede();
        if (aoTerminar) aoTerminar(final);
      });
      fonte.onerror = function () {
        falhasDeConexao++;
        if (desinstalacao && falhasDeConexao >= 2) {
          fonte.close();
          estado.fluxo = null;
          mostrarEncerrado();
        }
      };
    });

    $("dlgTrabalhoFechar").onclick = $("dlgTrabalhoX").onclick = function () {
      if (estado.fluxo) { estado.fluxo.close(); estado.fluxo = null; }
      dlg.close();
      carregarArea(estado.area);
    };
  }

  function mostrarEncerrado() {
    estado.desinstalando = true;
    var d = estado.desinstalacao || {};
    var url = estado.programa && estado.programa.aplicacao ? estado.programa.aplicacao.url : null;
    document.querySelectorAll("dialog[open]").forEach(function (x) { x.close(); });
    $("telaConsole").hidden = true;
    var c = limpar($("encerradoConteudo"));
    c.appendChild(cartao({}, [
      bolha("i-pacote", "tom-admin", "grande"),
      el("h1", { texto: "O Console de Operações foi encerrado para a desinstalação" }),
      el("p", { texto: "A conexão com o console terminou, como esperado. O desinstalador continua no host até remover o programa." }),
      aviso("ok", "O RemoteIFES continua funcionando", "A aplicação, o serviço, o banco e os backups não fazem parte da desinstalação." + (url ? " Endereço: " + url : "")),
      aviso("info", "Operadores e auditoria preservados", "Ficaram em " + (d.estado || "no diretório de estado do console") + ". Uma reinstalação os encontra de novo."),
      el("h2", { texto: "Para conferir ou reinstalar" }),
      el("p", { texto: "No host, sem o console, o lançador mostra o estado; no checkout, ./console.sh reinstala e abre o console." }),
      comando("./console.sh --status"),
      url ? linkExterno("Abrir o RemoteIFES", url, "primario") : null,
    ]));
    $("telaEncerrado").hidden = false;
    c.focus();
  }

  // --- Dashboard ---------------------------------------------------------------------------------

  function carregarPainel(completo) {
    return api("/api/painel" + (completo ? "?completo=1" : "")).then(function (r) {
      if (!r.ok) return;
      estado.painel = r.corpo;
      renderFaixa(r.corpo.trabalhoAtivo);
      marcarNavegacao();
      if (estado.area === "inicio") renderInicio(r.corpo);
      if (estado.area === "servico") renderServico(r.corpo);
    });
  }

  function renderFaixa(trabalho) {
    var faixa = limpar($("faixaTrabalho"));
    if (!trabalho) return;
    faixa.appendChild(aviso("info", "Operação em andamento", trabalho.rotulo + " — fase: " + (trabalho.fase || "em curso") + ".", [
      botao("Acompanhar", { classe: "pequeno primario", aoClicar: function () { abrirTrabalho(trabalho.id, trabalho.acao); } }),
    ]));
  }

  function estadoDaAplicacao(p) {
    var app = p.aplicacao || {};
    if (!app.respondeu) {
      if (p.servico && p.servico.suportado && !p.servico.ativo) return { nivel: "alerta", texto: "parado" };
      return { nivel: "erro", texto: "sem resposta" };
    }
    return app.ok ? { nivel: "ok", texto: "saudável" } : { nivel: "erro", texto: "degradado" };
  }

  function atencoes(p) {
    var lista = [];
    var app = p.aplicacao || {};
    var irServico = function () { irPara("servico"); };
    if (p.manutencao && p.manutencao.ocupada) {
      lista.push({ nivel: "info", titulo: "Manutenção em andamento", texto: p.manutencao.descricao, acoes: p.trabalhoAtivo ? [botao("Acompanhar", { classe: "pequeno", aoClicar: function () { abrirTrabalho(p.trabalhoAtivo.id, p.trabalhoAtivo.acao); } })] : [] });
    } else if (p.manutencao && p.manutencao.residuo) {
      lista.push({ nivel: "alerta", titulo: "Trava de manutenção residual", texto: p.manutencao.descricao + " Ela impede novas operações até ser removida.", acoes: [botao("Remover a trava", { classe: "pequeno primario", aoClicar: function () { executarAcao("manutencao.remover-trava", {}); } })] });
    }
    if (!app.respondeu) {
      if (p.servico && p.servico.suportado && !p.servico.ativo) {
        lista.push({ nivel: "alerta", titulo: "RemoteIFES parado", texto: "O serviço não está ativo e o watchdog não o religa. Se a parada não foi intencional, inicie a aplicação.", acoes: [botao("Iniciar o RemoteIFES", { classe: "pequeno primario", icone: "i-power", aoClicar: function () { executarAcao("servico.iniciar", {}); } })] });
      } else {
        lista.push({ nivel: "erro", titulo: "RemoteIFES não responde", texto: "O /health não respondeu (" + (app.erro || "sem resposta") + "). Veja os registros antes de reiniciar.", acoes: [botao("Ver registros", { classe: "pequeno", aoClicar: irServico }), botao("Reiniciar", { classe: "pequeno primario", aoClicar: function () { executarAcao("servico.reiniciar", {}); } })] });
      }
    } else if (!app.ok) {
      lista.push({ nivel: "erro", titulo: "RemoteIFES degradado", texto: 'O processo respondeu, mas relatou o banco em estado "' + (app.banco || "desconhecido") + '".', acoes: [botao("Ver registros", { classe: "pequeno", aoClicar: irServico }), botao("Backups", { classe: "pequeno", aoClicar: function () { irPara("dados"); } })] });
    }
    if (p.bancoQuarentenado > 0) {
      lista.push({ nivel: "alerta", titulo: "Banco em quarentena", texto: contar(p.bancoQuarentenado, "arquivo preservado", "arquivos preservados") + " de uma recuperação anterior. Eles nunca são apagados automaticamente.", acoes: [botao("Ver backups", { classe: "pequeno", aoClicar: function () { irPara("dados"); } })] });
    }
    if (app.respondeu && p.watchdog && p.watchdog.suportado && !p.watchdog.ativo) {
      lista.push({ nivel: "alerta", titulo: "Watchdog desligado", texto: "A recuperação automática está suspensa: uma falha do /health não reinicia a aplicação sozinha.", acoes: [botao("Religar o watchdog", { classe: "pequeno primario", aoClicar: function () { executarAcao("servico.iniciar", {}); } })] });
    }
    if (p.watchdog && p.watchdog.falhasConsecutivas > 0) {
      lista.push({ nivel: "alerta", titulo: "Falhas de saúde registradas", texto: p.watchdog.falhasConsecutivas + " de " + p.watchdog.limite + " falhas seguidas; na " + p.watchdog.limite + "ª o watchdog reinicia o serviço.", acoes: [botao("Ver registros", { classe: "pequeno", aoClicar: irServico })] });
    }
    if (p.host && p.host.memoria && p.host.memoria.disponivelBytes < 80 * 1048576) {
      lista.push({ nivel: "alerta", titulo: "Pouca memória disponível", texto: bytes(p.host.memoria.disponivelBytes) + " livres de " + bytes(p.host.memoria.totalBytes) + "." });
    }
    var a = estado.atualizacao;
    if (a && a.divergenciaProcessoCheckout && a.divergenciaProcessoCheckout.ha) {
      lista.push({ nivel: "alerta", titulo: "Código em disco diferente do processo", texto: a.divergenciaProcessoCheckout.explicacao, acoes: [botao("Ver atualizações", { classe: "pequeno", aoClicar: function () { irPara("atualizacoes", "remoteifes"); } })] });
    }
    var c = estado.programa && estado.programa.console;
    if (c && c.reversaoAutomatica) {
      lista.push({ nivel: "alerta", titulo: "Atualização do console revertida", texto: "A versão " + c.reversaoAutomatica.de + " não se manteve no ar e o console voltou para " + c.reversaoAutomatica.para + ".", acoes: [botao("Ver detalhes", { classe: "pequeno", aoClicar: function () { irPara("atualizacoes", "console"); } })] });
    }
    return lista;
  }

  function renderInicio(p) {
    var app = p.aplicacao || {};
    var e = estadoDaAplicacao(p);
    var lista = atencoes(p);
    $("tituloInicio").textContent = "Olá, " + estado.operador;
    $("inicioResumo").textContent = lista.length
      ? lista.length + (lista.length > 1 ? " itens precisam" : " item precisa") + " de atenção."
      : "Tudo em ordem: o RemoteIFES está " + e.texto + (app.uptimeSegundos ? " e no ar há " + duracao(app.uptimeSegundos) : "") + ".";
    var chips = limpar($("inicioChips"));
    chips.appendChild(chip(e.nivel, "RemoteIFES " + e.texto));
    if (p.watchdog && p.watchdog.suportado) chips.appendChild(chip(p.watchdog.ativo ? "ok" : "alerta", p.watchdog.ativo ? "watchdog ativo" : "watchdog desligado"));
    if (p.backups && p.backups.ultimo) chips.appendChild(chip("ok", "backup " + haQuanto(p.backups.ultimo.modificadoEm)));

    var at = limpar($("inicioAtencao"));
    if (lista.length) {
      at.appendChild(el("h2", { classe: "rotulo-secao", texto: "Precisa de atenção" }));
      lista.forEach(function (i) { at.appendChild(aviso(i.nivel, i.titulo, i.texto, i.acoes)); });
    }

    var s = limpar($("inicioSituacao"));
    s.appendChild(resumo("i-status", "tom-operacao", "RemoteIFES", chip(e.nivel, e.texto), [
      ["Commit em execução", app.respondeu ? curto(app.commit) || "não informado" : null, "mono"],
      ["No ar há", app.respondeu ? duracao(app.uptimeSegundos) : null],
    ], botao("Serviço e registros", { classe: "pequeno contorno", aoClicar: function () { irPara("servico"); } })));

    var memOk = p.host && p.host.memoria && p.host.memoria.disponivelBytes > 80 * 1048576;
    s.appendChild(resumo("i-dispositivo", "tom-dispositivo", "Host", chip(memOk ? "ok" : "alerta", memOk ? "normal" : "atenção"), [
      ["Memória disponível", p.host && p.host.memoria ? bytes(p.host.memoria.disponivelBytes) + " de " + bytes(p.host.memoria.totalBytes) : null],
      ["Temperatura", p.host && p.host.temperaturaC !== null && p.host.temperaturaC !== undefined ? p.host.temperaturaC + " °C" : "não medida"],
    ], null, p.host ? p.host.modelo : null));

    var b = p.backups || {};
    s.appendChild(resumo("i-banco", "tom-dispositivo", "Backups", chip(b.ultimo ? "ok" : "alerta", b.ultimo ? b.total + " disponíveis" : "nenhum"), [
      ["Último backup", b.ultimo ? quando(b.ultimo.modificadoEm) : b.disponivel ? "nenhum ainda" : b.motivo],
    ], botao("Criar backup", { classe: "pequeno primario", icone: "i-banco", aoClicar: function () { executarAcao("backup.criar", { rotulo: "console" }); } })));

    var atu = estado.atualizacao;
    var cons = estado.programa && estado.programa.console;
    var textoApp = !atu || !atu.remoto ? "não verificado" : atu.comparacao && atu.comparacao.atrasado ? contar(atu.comparacao.commitsSoRemotos, "commit novo", "commits novos") : atu.comparacao && atu.comparacao.igual ? "em dia" : "verificar";
    var textoConsole = !cons ? null : cons.podeAtualizar && cons.disponivel ? "versão " + cons.disponivel + " disponível" : cons.versaoEmExecucao;
    var precisa = (atu && atu.comparacao && atu.comparacao.atrasado) || (cons && cons.podeAtualizar && cons.disponivel);
    s.appendChild(resumo("i-ciclo", "tom-atencao", "Atualizações", chip(precisa ? "info" : textoApp === "em dia" ? "ok" : "", precisa ? "disponível" : textoApp === "em dia" ? "em dia" : "verificar"), [
      ["RemoteIFES", textoApp],
      ["Console de Operações", textoConsole],
    ], botao("Ver atualizações", { classe: "pequeno contorno", aoClicar: function () { irPara("atualizacoes"); } })));

    var t = limpar($("inicioTarefas"));
    [
      ["i-power", "tom-operacao", "Reiniciar o RemoteIFES", "Aplica configuração ou código já presentes no disco.", function () { executarAcao("servico.reiniciar", {}); }],
      ["i-banco", "tom-dispositivo", "Criar backup", "Snapshot verificado do banco, com a aplicação no ar.", function () { executarAcao("backup.criar", { rotulo: "console" }); }],
      ["i-ciclo", "tom-atencao", "Procurar atualizações", "Compara o que está em execução com o GitHub.", function () { irPara("atualizacoes", "remoteifes"); setTimeout(procurarAtualizacoes, 0); }],
      ["i-logs", "tom-info", "Ver registros", "Journal da aplicação, do watchdog e do console.", function () { irPara("servico"); }],
      ["i-celular", "tom-info", "Aplicativos e CI", "PWA, APK, builds e execuções do GitHub Actions.", function () { irPara("aplicativos"); }],
      ["i-cadeado", "tom-atencao", "Acesso de rede", "Modo de teste e faixas autorizadas da aplicação.", function () { irPara("rede"); }],
      ["i-manual", "tom-info", "Manual do console", "Guia de cada área, com busca e recuperação.", function () { abrirManual(); }],
    ].forEach(function (x) {
      t.appendChild(el("button", { classe: "acao-cartao", attrs: { type: "button" }, on: { click: x[4] } }, [bolha(x[0], x[1]), el("strong", { texto: x[2] }), el("span", { classe: "desc", texto: x[3] })]));
    });

    $("inicioColeta").textContent = "Coletado " + (haQuanto(p.coletadoEm) || "agora") + ".";
  }

  function resumo(nome, tom, titulo, estadoChip, pares, acao, subtitulo) {
    return el("div", { classe: "cartao resumo" }, [
      el("div", { classe: "resumo-topo" }, [bolha(nome, tom), el("h2", { texto: titulo }), estadoChip]),
      subtitulo ? el("p", { classe: "fraco pequeno", texto: subtitulo }) : null,
      fatos(pares),
      acao ? el("div", { classe: "acoes" }, [acao]) : null,
    ]);
  }

  // --- Service ------------------------------------------------------------------------------

  function renderServico(p) {
    var caixa = limpar($("servicoConteudo"));
    var e = estadoDaAplicacao(p);
    var sv = p.servico || {};
    var acoes = [botao("Verificar saúde", { classe: "contorno", icone: "i-status", aoClicar: verificarSaude })];
    if (sv.suportado) {
      acoes.push(botao("Reiniciar", { classe: "primario", icone: "i-ciclo", aoClicar: function () { executarAcao("servico.reiniciar", {}); } }));
      if (sv.ativo) acoes.push(botao("Parar", { classe: "contorno-perigo", icone: "i-power", aoClicar: function () { executarAcao("servico.parar", {}); } }));
      else acoes.push(botao("Iniciar", { classe: "primario", icone: "i-power", aoClicar: function () { executarAcao("servico.iniciar", {}); } }));
    }
    caixa.appendChild(cartao({ titulo: "RemoteIFES no host", descricao: sv.suportado ? "remoteifes.service" : null, icone: "i-servidor", lado: chip(e.nivel, e.texto) }, [
      sv.suportado
        ? fatos([
            ["Estado do serviço", sv.estadoAtivo + " / " + sv.subEstado],
            ["Ativo desde", quando(sv.desde) || sv.desde],
            ["Reinícios", sv.reinicios],
            ["Memória", bytes(sv.memoriaBytes)],
            ["PID principal", sv.pid],
            ["Partida com o sistema", sv.arquivoUnidade],
            ["Último resultado", sv.resultadoUltimaExecucao],
          ])
        : aviso("info", "Controle do serviço indisponível", sv.motivo || "o gerenciador de serviços deste sistema não é consultável pelo console"),
      fatos([
        ["Commit em execução", p.aplicacao && p.aplicacao.respondeu ? curto(p.aplicacao.commit) || "não informado" : null, "mono"],
        ["Banco", p.aplicacao && p.aplicacao.respondeu ? p.aplicacao.banco : null],
        ["Ambiente", p.aplicacao && p.aplicacao.respondeu ? p.aplicacao.ambiente : null],
      ]),
      el("div", { classe: "acoes" }, acoes),
    ]));
    var w = p.watchdog || {};
    caixa.appendChild(cartao({ titulo: "Recuperação automática", descricao: "O watchdog consulta o /health e reinicia a aplicação depois de falhas seguidas.", icone: "i-auditoria", tom: "tom-admin", lado: w.suportado ? chip(w.ativo ? "ok" : "alerta", w.ativo ? "ativo" : "desligado") : chip("", "não consultável") }, [
      w.suportado
        ? fatos([["Intervalo", w.intervaloMinutos ? "a cada " + w.intervaloMinutos + " min" : null], ["Falhas seguidas", w.falhasConsecutivas + " de " + w.limite]])
        : el("p", { classe: "fraco", texto: w.motivo || "O watchdog não é consultável neste sistema." }),
      w.suportado && !w.ativo ? aviso("alerta", "Recuperação suspensa", "Parar o RemoteIFES desliga o watchdog junto; Iniciar religa os dois.") : null,
    ]));
  }

  function verificarSaude() {
    executarAcao("saude.verificar", {}, {
      direto: true,
      aoConcluir: function (res) {
        var s = res.saude || {};
        if (s.respondeu && s.ok) toast("Saudável: banco " + s.banco + ", commit " + (curto(s.commit) || "não informado") + ", no ar há " + duracao(s.uptimeSegundos) + ".", "ok");
        else toast("O /health " + (s.respondeu ? "respondeu com o banco em " + s.banco : "não respondeu" + (s.erro ? " (" + s.erro + ")" : "")) + ".", "erro");
      },
    });
  }

  function carregarLog() {
    var saida = $("logSaida");
    saida.hidden = false;
    saida.textContent = "carregando…";
    var url = "/api/logs?unidade=" + encodeURIComponent($("logUnidade").value) + "&linhas=" + encodeURIComponent($("logLinhas").value) + ($("logSoErros").checked ? "&prioridade=4" : "");
    api(url).then(function (r) {
      saida.textContent = r.ok && r.corpo.ok ? r.corpo.texto || "(sem linhas)" : r.corpo.erro || r.corpo.motivo || "não foi possível ler o registro";
      saida.scrollTop = saida.scrollHeight;
    });
  }

  // --- RemoteIFES updates --------------------------------------------------------------------

  function carregarAtualizacao() {
    return api("/api/atualizacao").then(function (r) {
      if (!r.ok) return;
      estado.atualizacao = r.corpo;
      marcarNavegacao();
      renderAtualizacao(r.corpo);
    });
  }

  function procurarAtualizacoes() {
    var alvo = document.querySelector('[data-subpainel="remoteifes"]');
    var b = alvo.querySelector("[data-procurar]");
    if (b) { b.disabled = true; b.lastChild.textContent = "Procurando…"; }
    api("/api/atualizacao/buscar", { method: "POST" }).then(function (r) {
      if (r.ok) {
        estado.atualizacao = r.corpo.situacao;
        marcarNavegacao();
        renderAtualizacao(r.corpo.situacao);
        var c = r.corpo.situacao.comparacao;
        toast(c && c.atrasado ? contar(c.commitsSoRemotos, "commit novo disponível.", "commits novos disponíveis.") : "Nenhuma atualização nova do RemoteIFES.", c && c.atrasado ? "info" : "ok");
      } else {
        toast((r.corpo && r.corpo.erro) || "falha ao consultar o GitHub", "erro");
        if (b) { b.disabled = false; b.lastChild.textContent = "Procurar atualizações"; }
      }
    });
  }

  function renderAtualizacao(a) {
    var caixa = limpar(document.querySelector('[data-subpainel="remoteifes"]'));
    if (!a.checkout.repositorio) {
      caixa.appendChild(cartao({}, [vazio("i-ramo", "tom-critico", "Checkout do RemoteIFES não encontrado", a.checkout.motivo)]));
      return;
    }
    var avisos = [];
    if (a.divergenciaProcessoCheckout && a.divergenciaProcessoCheckout.ha) avisos.push(aviso("alerta", "Código em disco diferente do processo em execução", a.divergenciaProcessoCheckout.explicacao));
    if (!a.checkout.limpo) avisos.push(aviso("alerta", "Alterações locais no checkout", contar(a.checkout.totalModificados, "arquivo modificado", "arquivos modificados") + " e " + contar(a.checkout.totalNaoRastreados, "não rastreado.", "não rastreados.") + " A atualização recusa prosseguir; o console nunca usa --force."));
    if (a.checkout.destacado) avisos.push(aviso("info", "HEAD destacado", "O checkout não está num ramo, como acontece depois de implantar uma etiqueta ou commit específico."));
    if (a.consultaAgora) avisos.push(aviso("erro", "Não foi possível consultar o GitHub", a.consultaAgora.mensagem || a.consultaAgora.erro || "falha desconhecida"));
    if (a.remoto && a.remoto.ressalva) avisos.push(aviso("alerta", "Observação antiga", a.remoto.ressalva));
    if (a.remoto && a.remoto.urlAnterior) avisos.push(aviso("alerta", "Remoto alterado", "O endereço de origin mudou de " + a.remoto.urlAnterior + " para " + a.remoto.url + "."));

    var comp = a.comparacao;
    var situacao;
    if (!a.remoto) situacao = { nivel: "", texto: "não verificado", titulo: "Ainda não comparado com o GitHub", desc: "Procure atualizações para saber se há uma versão nova do RemoteIFES." };
    else if (comp && comp.conhecido && comp.atrasado) situacao = { nivel: "info", texto: "atualização disponível", titulo: contar(comp.commitsSoRemotos, "commit novo", "commits novos") + " em origin/main", desc: "Revise o que muda e atualize quando a interrupção curta for aceitável." };
    else if (comp && comp.conhecido && comp.igual) situacao = { nivel: "ok", texto: "em dia", titulo: "O RemoteIFES está em dia", desc: "O checkout está no último commit observado em origin/main." };
    else if (comp && comp.conhecido && comp.adiantado) situacao = { nivel: "alerta", texto: "adiantado", titulo: contar(comp.commitsSoLocais, "commit local não enviado", "commits locais não enviados"), desc: "O checkout tem commits que origin/main não tem." };
    else if (comp && comp.conhecido) situacao = { nivel: "alerta", texto: "divergente", titulo: "Checkout e origin/main divergiram", desc: contar(comp.commitsSoLocais, "commit local", "commits locais") + " e " + contar(comp.commitsSoRemotos, "remoto", "remotos") + "." };
    else situacao = { nivel: "alerta", texto: "sem comparação", titulo: "Não foi possível comparar", desc: comp ? comp.motivo : "" };

    var alvo = a.remoto ? a.remoto.commit : null;
    var acoes = [];
    var podeAtualizar = alvo && comp && comp.conhecido && comp.atrasado;
    acoes.push(el("button", { classe: "btn " + (podeAtualizar ? "contorno" : "primario"), attrs: { type: "button", "data-procurar": "1" }, on: { click: procurarAtualizacoes } }, [icone("i-ciclo"), el("span", { texto: "Procurar atualizações" })]));
    if (podeAtualizar) {
      acoes.push(botao("Atualizar para " + curto(alvo), { classe: "primario", icone: "i-download", aoClicar: function () { executarAcao("atualizacao.aplicar", { commit: alvo }, { contexto: "RemoteIFES: " + curto(a.emExecucao.commit || a.checkout.head) + " → " + curto(alvo) }); } }));
    }
    if (a.versoesRegistradas && a.versoesRegistradas.anterior) {
      acoes.push(botao("Reverter para " + curto(a.versoesRegistradas.anterior), { classe: "contorno-perigo", icone: "i-desfazer", aoClicar: function () { executarAcao("atualizacao.reverter", {}, { contexto: "RemoteIFES: voltar para " + curto(a.versoesRegistradas.anterior) }); } }));
    }

    caixa.appendChild(cartao({ titulo: situacao.titulo, descricao: situacao.desc, icone: "i-servidor", lado: chip(situacao.nivel, situacao.texto) }, avisos.concat([
      fatos([
        ["Em execução", a.emExecucao.commit ? curto(a.emExecucao.commit) : a.emExecucao.motivoDesconhecido, a.emExecucao.commit ? "mono" : null],
        ["Disponível em origin/main", a.remoto ? curto(a.remoto.commit) : "não verificado", a.remoto ? "mono" : null],
        a.remoto ? ["Verificado", haQuanto(a.remoto.observadoEm)] : null,
        ["Última implantação verificada", a.ultimaImplantacaoVerificada ? quando(a.ultimaImplantacaoVerificada.em) + " → " + curto(a.ultimaImplantacaoVerificada.para) : "nenhuma registrada"],
      ]),
      el("div", { classe: "acoes" }, acoes),
    ])));

    var mudancas = el("div");
    caixa.appendChild(cartao({ titulo: "O que muda", icone: "i-logs", tom: "tom-info" }, [mudancas]));
    carregarMudancas(a, mudancas);

    var hist = el("ul", { classe: "linhas" });
    (a.historico || []).forEach(function (h) {
      hist.appendChild(el("li", { classe: "linha-item" }, [
        icone(h.sucesso ? "i-circulo-check" : "i-circulo-x", "estado-icone " + (h.sucesso ? "tom-operacao" : "tom-critico")),
        el("div", { classe: "principal" }, [el("strong", { texto: (h.tipo || "implantação") + ": " + (curto(h.de) || "?") + " → " + (curto(h.para) || "?") }), el("span", { texto: quando(h.em) || h.bruto || "" })]),
        chip(h.sucesso ? "ok" : "erro", h.sucesso ? "verificada" : "falhou"),
      ]));
    });
    caixa.appendChild(cartao({ titulo: "Histórico de implantações", icone: "i-relogio", tom: "tom-admin" }, [
      (a.historico || []).length ? hist : vazio("i-relogio", "tom-admin", "Nenhuma implantação registrada", "As atualizações e reversões feitas pelo console ou pelo terminal aparecem aqui."),
    ]));

    caixa.appendChild(detalhes("Detalhes técnicos do checkout", [
      fatos([
        ["HEAD do checkout", curto(a.checkout.head), "mono"],
        ["Descrição do HEAD", a.checkout.descricaoHead, "mono"],
        ["Ramo local", a.checkout.destacado ? "(destacado)" : a.checkout.ramo],
        ["Upstream", a.checkout.upstream],
        ["Estado do checkout", a.checkout.limpo ? "limpo" : a.checkout.totalModificados + " modificados, " + a.checkout.totalNaoRastreados + " não rastreados"],
        ["Remoto origin", a.checkout.remotoOrigin, "mono"],
        ["Versão anterior registrada", curto(a.versoesRegistradas && a.versoesRegistradas.anterior), "mono"],
        ["Histórico", a.checkout.raso ? "raso (shallow)" : "completo"],
      ]),
      el("div", { classe: "acoes" }, [botao("Só consultar origin, sem baixar", { classe: "pequeno contorno", aoClicar: function () {
        api("/api/atualizacao/verificar", { method: "POST" }).then(function (r) {
          if (r.ok) { estado.atualizacao = r.corpo; renderAtualizacao(r.corpo); toast("origin consultado.", "ok"); } else toast(r.corpo.erro || "falha ao consultar origin", "erro");
        });
      } })]),
    ]));
  }

  function carregarMudancas(a, caixa) {
    var de = a.emExecucao.commit || a.checkout.head;
    var para = a.remoto ? a.remoto.commit : null;
    if (!de || !para || de === para) {
      caixa.appendChild(el("p", { classe: "fraco", texto: para ? "Nada novo: a versão em execução é a última observada em origin/main." : "Procure atualizações para ver os commits novos." }));
      return;
    }
    caixa.appendChild(el("p", { classe: "fraco", texto: "comparando…" }));
    api("/api/atualizacao/mudancas?de=" + encodeURIComponent(de) + "&para=" + encodeURIComponent(para)).then(function (r) {
      limpar(caixa);
      if (!r.ok || !r.corpo.disponivel) { caixa.appendChild(el("p", { classe: "fraco", texto: (r.corpo && r.corpo.motivo) || "não foi possível comparar" })); return; }
      var m = r.corpo;
      caixa.appendChild(el("p", { texto: contar(m.total, "commit", "commits") + " e " + contar(m.arquivosAlterados, "arquivo", "arquivos") + " entre " + curto(de) + " e " + curto(para) + (m.truncado ? " (lista limitada)" : "") + "." }));
      if (m.componentes.length) {
        var chipsC = el("div", { classe: "chips" });
        m.componentes.forEach(function (c) { chipsC.appendChild(chip("info", c.rotulo + ": " + c.arquivos, "sem-ponto")); });
        caixa.appendChild(chipsC);
      }
      var ul = el("ul", { classe: "linhas" });
      m.commits.forEach(function (c) {
        ul.appendChild(el("li", { classe: "linha-item" }, [el("code", { texto: c.curto }), el("div", { classe: "principal" }, [el("strong", { texto: c.assunto }), el("span", { texto: c.autor })])]));
      });
      caixa.appendChild(ul);
    });
  }

  // --- Console updates -----------------------------------------------------------------------

  function carregarAtualizacaoConsole(comRede) {
    var caixa = document.querySelector('[data-subpainel="console"]');
    if (comRede) {
      var b = caixa.querySelector("[data-verificar-console]");
      if (b) { b.disabled = true; b.lastChild.textContent = "Verificando…"; }
    }
    return api("/api/programa" + (comRede ? "?rede=1" : "")).then(function (r) {
      if (!r.ok) return;
      estado.programa = r.corpo;
      marcarNavegacao();
      renderAtualizacaoConsole(r.corpo, comRede);
    });
  }

  function renderAtualizacaoConsole(prog, consultou) {
    var caixa = limpar(document.querySelector('[data-subpainel="console"]'));
    var c = prog.console;
    var avisos = [];
    if (c.transacaoPendente && c.transacaoPendente.etapa !== "concluida") avisos.push(aviso("alerta", "Atualização interrompida", 'Uma atualização do console parou em "' + c.transacaoPendente.etapa + '". A versão ativa continua a que funcionava; o resto é limpo na próxima partida.'));
    if (c.divergenciaDeVersao) avisos.push(aviso(c.divergenciaDeVersao.reinicioPendente ? "info" : "erro", c.divergenciaDeVersao.reinicioPendente ? "Reinício pendente" : "A versão em execução não é a versão ativa", c.divergenciaDeVersao.motivo));
    if (c.reversaoAutomatica) avisos.push(aviso("erro", "Atualização revertida automaticamente", "A versão " + c.reversaoAutomatica.de + " não se manteve no ar em " + c.reversaoAutomatica.partidas + " partidas seguidas e o console voltou para " + c.reversaoAutomatica.para + " (" + quando(c.reversaoAutomatica.em) + "). Consulte os registros do console antes de tentar de novo."));
    if (c.ativacaoPendente) avisos.push(aviso("info", "Versão nova em observação", "A versão " + c.ativacaoPendente.versao + " ainda não confirmou que se mantém no ar. Se falhar repetidamente ao iniciar, o console volta sozinho para " + c.ativacaoPendente.anterior + "."));
    if (c.consultaAgora && c.consultaAgora.motivo) avisos.push(aviso("alerta", "Publicação não consultada", c.consultaAgora.motivo));

    var situacao;
    if (!c.gerenciadoLadoALado) situacao = { nivel: "", texto: "código-fonte", titulo: "Console " + c.versaoEmExecucao + " executado do código-fonte", desc: "Sem instalação lado a lado, a atualização do programa não se aplica: o console segue o checkout." };
    else if (c.podeAtualizar && c.disponivel) situacao = { nivel: "info", texto: "atualização disponível", titulo: "Console " + c.disponivel + " disponível", desc: "Em execução: " + c.versaoEmExecucao + ". A versão nova é verificada antes de ser instalada." };
    else if (c.disponivel) situacao = { nivel: "ok", texto: "em dia", titulo: "Console " + c.versaoEmExecucao + " em dia", desc: c.motivoNaoAtualizar || "Nenhuma versão mais nova foi publicada." };
    else situacao = { nivel: "", texto: "não verificado", titulo: "Console " + c.versaoEmExecucao, desc: "Nenhuma publicação observada ainda. O console verifica sozinho duas vezes por dia." };

    var acoes = [];
    if (c.gerenciadoLadoALado) {
      acoes.push(el("button", { classe: "btn " + (c.podeAtualizar && c.disponivel ? "contorno" : "primario"), attrs: { type: "button", "data-verificar-console": "1" }, on: { click: function () { carregarAtualizacaoConsole(true); } } }, [icone("i-ciclo"), el("span", { texto: "Verificar publicação" })]));
      if (c.podeAtualizar && c.disponivel) {
        var versao = c.disponivel;
        acoes.push(botao("Atualizar o Console para " + versao, { classe: "primario", icone: "i-download", aoClicar: function () {
          executarAcao("console.atualizar", { versao: versao }, { contexto: "Console de Operações: " + c.versaoEmExecucao + " → " + versao + ". O RemoteIFES não é afetado.", aoTerminar: aguardarReconexao });
        } }));
      }
      if (c.versaoAnterior) {
        acoes.push(botao("Reverter o Console para " + c.versaoAnterior, { classe: "contorno-perigo", icone: "i-desfazer", aoClicar: function () {
          executarAcao("console.reverter", {}, { contexto: "Console de Operações: voltar para " + c.versaoAnterior + ". O RemoteIFES não é afetado.", aoTerminar: aguardarReconexao });
        } }));
      }
    }
    var va = c.verificacaoAutomatica;
    var auto = null;
    if (va && va.ultimaTentativa) {
      var t = va.ultimaTentativa;
      auto = quando(t.em) + ": " + (t.motivo || t.tipo) + (va.proximaEm && t.tipo !== "atualizado" ? " · próxima por volta de " + quando(va.proximaEm) : "");
    }
    caixa.appendChild(cartao({ titulo: situacao.titulo, descricao: situacao.desc, icone: "i-pacote", tom: "tom-admin", lado: chip(situacao.nivel, situacao.texto) }, avisos.concat([
      fatos([
        ["Em execução", c.versaoEmExecucao, "mono"],
        c.gerenciadoLadoALado ? ["Versão anterior guardada", c.versaoAnterior || "nenhuma", "mono"] : null,
        ["Publicação observada", c.ultimaObservacao ? c.ultimaObservacao.versao + " (" + (c.ultimaObservacao.canal || "estável") + "), " + haQuanto(c.ultimaObservacao.observadoEm) : "nenhuma", c.ultimaObservacao ? "mono" : null],
        ["Verificação automática", auto || "ainda não rodou"],
      ]),
      el("div", { classe: "acoes" }, acoes),
    ])));
    caixa.appendChild(aviso("info", "Independente do RemoteIFES", "Esta é a versão do programa console. Atualizar ou reverter o console não muda o commit do RemoteIFES, e vice-versa.", [
      botao("Atualizações do RemoteIFES", { classe: "pequeno", aoClicar: function () { irPara("atualizacoes", "remoteifes"); } }),
      botao("Console instalado", { classe: "pequeno", aoClicar: function () { irPara("console"); } }),
    ]));
    if (consultou) toast(c.podeAtualizar && c.disponivel ? "Versão " + c.disponivel + " do console disponível." : c.consultaAgora ? "A publicação não pôde ser consultada agora." : "O console está em dia.", c.consultaAgora ? "alerta" : "ok");
  }

  function aguardarReconexao(final) {
    if (!final || final.estado !== "concluido") return;
    toast("O console está reiniciando; a página reconecta sozinha.", "info");
    var tentativas = 0;
    var relogio = setInterval(function () {
      tentativas++;
      api("/api/sessao").then(function (r) {
        if (r.ok && r.corpo.autenticado) {
          clearInterval(relogio);
          entrarNoConsole(r.corpo);
          toast("Console reconectado.", "ok");
        } else if (r.ok && !r.corpo.autenticado) {
          clearInterval(relogio);
          mostrarEntrada("O console reiniciou. Entre novamente.", "info");
        }
      });
      if (tentativas > 40) clearInterval(relogio);
    }, 3000);
  }

  // --- Data -----------------------------------------------------------------------------------------

  function carregarDados() {
    var caixa = $("dadosConteudo");
    api("/api/backups").then(function (r) {
      if (!r.ok) return;
      renderDados(r.corpo);
    });
    if (!caixa.firstChild) caixa.appendChild(el("p", { classe: "fraco", texto: "carregando…" }));
  }

  function renderDados(b) {
    var caixa = limpar($("dadosConteudo"));
    var ultimo = b.itens && b.itens[0];
    var p = estado.painel;
    caixa.appendChild(cartao({
      titulo: ultimo ? "Último backup " + haQuanto(ultimo.modificadoEm) : "Nenhum backup ainda",
      descricao: b.escopo,
      icone: "i-banco",
      tom: "tom-dispositivo",
      lado: chip(ultimo ? "ok" : "alerta", (b.itens || []).length + " disponíveis"),
    }, [
      !b.disponivel ? aviso("alerta", "Pasta de backups indisponível", b.motivo || "pasta não encontrada") : null,
      b.bancoQuarentenado && b.bancoQuarentenado.length ? aviso("alerta", "Banco em quarentena", b.bancoQuarentenado.join(", ") + " — preservados para análise; nada é apagado automaticamente.") : null,
      el("div", { classe: "acoes" }, [botao("Criar backup agora", { classe: "primario", icone: "i-banco", aoClicar: function () { executarAcao("backup.criar", { rotulo: "console" }, { aoTerminar: function () { carregarDados(); } }); } })]),
    ]));

    var lista = el("ul", { classe: "linhas" });
    (b.itens || []).forEach(function (item) {
      lista.appendChild(el("li", { classe: "linha-item" }, [
        icone("i-banco", "estado-icone tom-dispositivo"),
        el("div", { classe: "principal" }, [el("strong", { classe: "mono", texto: item.nome }), el("span", { texto: quando(item.modificadoEm) + " · " + bytes(item.bytes) })]),
        el("div", { classe: "lado" }, [botao("Restaurar", { classe: "pequeno contorno-perigo", icone: "i-desfazer", rotulo: "Restaurar " + item.nome, aoClicar: function () {
          executarAcao("backup.restaurar", { backup: item.nome }, { contexto: "Restaurar " + item.nome + " (" + quando(item.modificadoEm) + ")" });
        } })]),
      ]));
    });
    caixa.appendChild(cartao({ titulo: "Backups disponíveis", descricao: "Restaurar troca o banco atual pelo backup, com a aplicação parada. O banco atual é guardado antes.", icone: "i-relogio", tom: "tom-admin" }, [
      (b.itens || []).length ? lista : vazio("i-banco", "tom-dispositivo", "Nenhum backup encontrado", "Crie o primeiro backup agora; o RemoteIFES também faz backups automáticos em produção."),
    ]));

    var senha = el("input", { attrs: { type: "password", id: "novaSenhaSuper", autocomplete: "new-password", minlength: "8", maxlength: "128" } });
    var senha2 = el("input", { attrs: { type: "password", id: "novaSenhaSuper2", autocomplete: "new-password" } });
    var form = el("form", { classe: "limitado" }, [
      el("div", { classe: "campo" }, [el("label", { texto: "Nova senha do superadministrador", attrs: { for: "novaSenhaSuper" } }), senha, el("p", { classe: "ajuda", texto: "8 a 128 caracteres. Vai ao processo por stdin; não aparece em log nem em auditoria." })]),
      el("div", { classe: "campo" }, [el("label", { texto: "Repita a senha", attrs: { for: "novaSenhaSuper2" } }), senha2]),
      el("div", { classe: "acoes" }, [el("button", { classe: "btn contorno-perigo", attrs: { type: "submit" } }, [icone("i-chave"), el("span", { texto: "Redefinir a senha" })])]),
    ]);
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (senha.value.length < 8) { toast("A senha precisa ter ao menos 8 caracteres.", "erro"); senha.focus(); return; }
      if (senha.value !== senha2.value) { toast("As duas senhas não conferem.", "erro"); senha2.focus(); return; }
      var valor = senha.value;
      senha.value = "";
      senha2.value = "";
      executarAcao("conta.recuperar-superadmin", { senha: valor });
    });
    caixa.appendChild(cartao({ titulo: "Recuperar o acesso ao RemoteIFES", descricao: "Quando ninguém consegue mais entrar como superadministrador.", icone: "i-chave", tom: "tom-atencao" }, [form]));

    var trava = p && p.manutencao;
    caixa.appendChild(cartao({ titulo: "Trava de manutenção", icone: "i-cadeado", tom: "tom-atencao", lado: chip(trava && trava.residuo ? "alerta" : trava && trava.ocupada ? "info" : "ok", trava && trava.residuo ? "residual" : trava && trava.ocupada ? "em uso" : "livre") }, [
      trava && trava.residuo
        ? aviso("alerta", "Trava residual", trava.descricao, [botao("Remover a trava", { classe: "pequeno primario", aoClicar: function () { executarAcao("manutencao.remover-trava", {}, { aoConcluir: function (res) { toast(res && res.ok !== false ? "Trava removida." : (res && res.erro) || "a trava não foi removida", res && res.ok !== false ? "ok" : "erro"); carregarPainel().then(carregarDados); } }); } })])
        : el("p", { classe: "fraco", texto: trava && trava.ocupada ? trava.descricao : "Nenhuma operação de manutenção está em andamento." }),
    ]));

    caixa.appendChild(detalhes("Banco de dados e disco", [el("p", { classe: "fraco", texto: "carregando…" })], function (corpo) {
      api("/api/host").then(function (r) {
        limpar(corpo);
        if (!r.ok) { corpo.appendChild(el("p", { classe: "fraco", texto: "não foi possível ler" })); return; }
        var db = r.corpo.banco;
        var pa = r.corpo.prontidaoAplicacao;
        var pacotes = r.corpo.host.pacotes;
        var pares = [
          ["Arquivo do banco", db.existe ? "presente" : "ausente"],
          ["Tamanho", bytes(db.bytes)],
          ["Modificado", quando(db.modificadoEm)],
          ["WAL", db.wal ? "presente" : "ausente"],
        ];
        if (db.lido) pares = pares.concat([["Usuários", db.usuarios], ["Salas (com MAC)", db.salas + " (" + db.salasComMac + ")"], ["Agendamentos ativos", db.agendamentosAtivos], ["Sessões sem logout", db.sessoesAbertas]]);
        else pares.push(["Leitura", db.erro || "não lido (a aplicação precisa estar no ar)"]);
        pares.push(["ESP32 com canal de comando", pa && pa.disponivel ? pa.dispositivos.canaisDeComando + " de " + pa.dispositivos.conectados : (pa && pa.motivo) || "desconhecido"]);
        pares.push(["OTA em andamento", pa && pa.disponivel ? pa.ota.ativos : null]);
        pares.push(["Pacotes do sistema pendentes", pacotes && pacotes.suportado ? pacotes.pendentes + " no cache local" : (pacotes && pacotes.motivo) || "não consultável"]);
        (r.corpo.host.disco || []).filter(function (d) { return d.suportado; }).forEach(function (d) {
          pares.push(["Disco " + d.caminho, bytes(d.livreBytes) + " livres de " + bytes(d.totalBytes) + " (" + d.usoPercentual + "% usado)"]);
        });
        corpo.appendChild(fatos(pares));
      });
    }));
  }

  // --- Network -------------------------------------------------------------------------------------

  function carregarAcessoRede() {
    var situacao = limpar($("acessoSituacao"));
    api("/api/rede/acesso").then(function (r) {
      limpar(situacao);
      var a = r.ok ? r.corpo : null;
      if (!a || !a.lido) {
        situacao.appendChild(aviso("alerta", "Valores atuais não lidos", (a && a.erro) || "não foi possível ler o banco da aplicação"));
        return;
      }
      var modoTeste = a.modoTeste === null ? !!a.modoTestePadrao : a.modoTeste;
      situacao.appendChild(el("div", { classe: "chips" }, [
        chip(modoTeste ? "alerta" : "ok", modoTeste ? "modo de teste ligado: qualquer rede" : "restrito às faixas autorizadas"),
        chip("info", contar(a.redesAutorizadas.length, "faixa", "faixas"), "sem-ponto"),
      ]));
      if (!modoTeste && !a.redesAutorizadas.length) situacao.appendChild(aviso("alerta", "Nenhuma faixa autorizada", "Com o modo de teste desligado e nenhuma faixa, só o próprio host (localhost) abre a aplicação."));
      $("acessoModoTeste").checked = modoTeste;
      $("acessoRedes").value = a.redesAutorizadas.join("\n");
    });
  }

  function linhaSonda(rotulo, ok, texto) {
    return el("li", { classe: "linha-item" }, [
      icone(ok === null ? "i-circulo-vazio" : ok ? "i-circulo-check" : "i-circulo-x", "estado-icone " + (ok === null ? "" : ok ? "tom-operacao" : "tom-critico")),
      el("div", { classe: "principal" }, [el("strong", { texto: rotulo }), el("span", { texto: texto })]),
    ]);
  }

  function carregarRede() {
    var caixa = limpar($("redeConteudo"));
    caixa.appendChild(el("p", { classe: "fraco", texto: "coletando…" }));
    api("/api/rede").then(function (r) {
      limpar(caixa);
      if (!r.ok) { caixa.appendChild(aviso("erro", "Falha", (r.corpo && r.corpo.erro) || "não foi possível coletar")); return; }
      var n = r.corpo;
      var ul = el("ul", { classe: "linhas" });
      ul.appendChild(linhaSonda("Domínio", n.dominio.configurado ? true : null, n.dominio.configurado || "nenhum domínio configurado"));
      if (n.dominio.dns) ul.appendChild(linhaSonda("DNS", n.dominio.dns.apontaParaEsteHost === null ? null : n.dominio.dns.apontaParaEsteHost, ((n.dominio.dns.a || []).join(", ") || n.dominio.dns.erro || "") + (n.dominio.dns.apontaParaEsteHost === false ? " · não aponta para este host" : "")));
      if (n.dominio.certificado) {
        var cert = n.dominio.certificado;
        ul.appendChild(linhaSonda("Certificado TLS", cert.alcancou ? !!cert.autorizado : false, cert.alcancou ? (cert.autorizado ? "válido, expira em " + contar(cert.diasParaExpirar, "dia", "dias") + " (" + quando(cert.validoAte) + "), emissor " + cert.emissor : "cadeia não validada: " + cert.erroAutorizacao) : "não alcançou: " + cert.erro));
      }
      ul.appendChild(linhaSonda("Renovação (Certbot)", n.dominio.renovacao.certbot ? !!n.dominio.renovacao.timerInstalado : null, n.dominio.renovacao.certbot ? (n.dominio.renovacao.dominios || []).join(", ") + (n.dominio.renovacao.timerInstalado ? " · timer instalado" : " · sem timer") : "não instalado"));
      ul.appendChild(linhaSonda("Proxy Nginx", n.proxy.instalado ? !!n.proxy.siteRemoteifes : null, n.proxy.instalado ? (n.proxy.siteRemoteifes ? "site RemoteIFES ativo" : "instalado, sem o site RemoteIFES") : "não instalado"));
      ul.appendChild(linhaSonda("Aplicação local (/health)", !!n.sondas.aplicacaoLocal.alcancou, n.sondas.aplicacaoLocal.alcancou ? "HTTP " + n.sondas.aplicacaoLocal.status : n.sondas.aplicacaoLocal.erro));
      ul.appendChild(linhaSonda("Porta 80 local", n.sondas.proxyLocal.alcancou ? true : null, n.sondas.proxyLocal.alcancou ? "HTTP " + n.sondas.proxyLocal.status : n.sondas.proxyLocal.erro));
      caixa.appendChild(aviso("info", null, n.pontoDeVista));
      caixa.appendChild(ul);
      if (n.proxy.observacao) caixa.appendChild(aviso("alerta", "Nginx", n.proxy.observacao));
      caixa.appendChild(aviso("info", "Mudanças de rede", n.operacoesConsequentes.observacao));
      caixa.appendChild(detalhes("Exposição da aplicação e do console", [
        fatos([
          ["Porta da aplicação", n.exposicaoAplicacao.porta],
          ["Bind", n.exposicaoAplicacao.bind],
          ["Ambiente", n.exposicaoAplicacao.ambiente],
          ["CORS_ORIGIN", n.exposicaoAplicacao.corsOrigin.join(", ") || "(vazio)"],
          ["TRUST_PROXY", n.exposicaoAplicacao.trustProxy],
          ["Console escuta em", n.exposicaoConsole.endereco + ":" + n.exposicaoConsole.porta, "mono"],
          ["Hosts aceitos pelo console", n.exposicaoConsole.hostsAceitos.join(", "), "mono"],
        ]),
        aviso("info", "Acesso remoto ao console", n.exposicaoConsole.orientacao),
        aviso("info", "TRUST_PROXY", n.exposicaoAplicacao.observacao),
      ]));
      var linhas = [];
      n.interfaces.forEach(function (i) { linhas.push(i.interface + "  " + i.familia + "  " + i.endereco + "/" + i.mascara); });
      if (n.rotas.suportado) linhas = linhas.concat([""], n.rotas.linhas);
      if (n.escutas.suportado) linhas = linhas.concat([""], n.escutas.linhas);
      caixa.appendChild(detalhes("Interfaces, rotas e portas em escuta", [el("pre", { classe: "saida", texto: linhas.join("\n") })]));
    });
  }

  // --- Apps and CI ------------------------------------------------------------------------------

  var ESTADOS_RUN = {
    queued: ["info andamento", "na fila", "i-circulo-reticencias", "tom-info"],
    waiting: ["info andamento", "aguardando", "i-circulo-reticencias", "tom-info"],
    pending: ["info andamento", "pendente", "i-circulo-reticencias", "tom-info"],
    requested: ["info andamento", "pedida", "i-circulo-reticencias", "tom-info"],
    in_progress: ["info andamento", "em andamento", "i-circulo-reticencias", "tom-info"],
    success: ["ok", "sucesso", "i-circulo-check", "tom-operacao"],
    failure: ["erro", "falhou", "i-circulo-x", "tom-critico"],
    timed_out: ["erro", "tempo esgotado", "i-circulo-x", "tom-critico"],
    startup_failure: ["erro", "não iniciou", "i-circulo-x", "tom-critico"],
    cancelled: ["alerta", "cancelada", "i-circulo-cortado", "tom-atencao"],
    skipped: ["", "ignorada", "i-circulo-vazio", ""],
    neutral: ["", "neutra", "i-circulo-vazio", ""],
    action_required: ["alerta", "requer ação", "i-circulo-exclamacao", "tom-atencao"],
  };

  function estadoRun(r) {
    return ESTADOS_RUN[r.status === "completed" ? r.conclusao || "neutral" : r.status] || ["", r.conclusao || r.status, "i-circulo-vazio", ""];
  }

  function carregarAplicativos(forcarCi) {
    var sub = estado.sub.aplicativos;
    var precisaCi = ["web", "android", "ios", "ci"].indexOf(sub) >= 0;
    var p1 = estado.mobile && !forcarCi ? Promise.resolve() : api("/api/mobile").then(function (r) { if (r.ok) estado.mobile = r.corpo; });
    p1.then(function () {
      renderAplicativos();
      if (precisaCi && estado.mobile && estado.mobile.credencialGitHub.presente && (forcarCi || !estado.ci || Date.now() - estado.ciEm > 60000)) carregarCI();
    });
  }

  function carregarCI() {
    document.querySelectorAll("[data-ci-carregando]").forEach(function (n) { n.hidden = false; });
    return api("/api/ci").then(function (r) {
      estado.ci = r.ok ? r.corpo : { disponivel: false, motivo: (r.corpo && r.corpo.erro) || "não foi possível consultar o GitHub" };
      estado.ciEm = Date.now();
      marcarNavegacao();
      renderAplicativos();
    });
  }

  function renderAplicativos() {
    var m = estado.mobile;
    if (!m) return;
    var sub = estado.sub.aplicativos;
    var caixa = limpar(document.querySelector('[data-subpainel="' + sub + '"]'));
    ({ web: renderWeb, android: renderAndroid, ios: renderIos, ci: renderCiArea, credenciais: renderCredenciais })[sub](caixa, m);
    marcarNavegacao();
  }

  function semCredencial(texto) {
    return vazio("i-chave", "tom-atencao", "Credencial do GitHub não configurada", texto || "Grave um token do GitHub para acompanhar e acionar os workflows. O RemoteIFES funciona normalmente sem ele.", [
      botao("Configurar credencial", { classe: "primario", icone: "i-chave", aoClicar: function () { irPara("aplicativos", "credenciais"); } }),
    ]);
  }

  function listaDeRuns(runs, opcoes) {
    opcoes = opcoes || {};
    var ci = estado.ci;
    if (!estado.mobile.credencialGitHub.presente) return semCredencial();
    if (!ci) return el("p", { classe: "fraco", texto: "consultando o GitHub…" });
    if (!ci.disponivel) return aviso("alerta", "GitHub indisponível agora", ci.motivo || "falha na consulta", [botao("Tentar de novo", { classe: "pequeno", aoClicar: carregarCI })]);
    if (!runs || !runs.length) return vazio("i-ramo", "tom-operacao", opcoes.vazioTitulo || "Nenhuma execução recente", opcoes.vazioTexto || "Quando houver execuções deste workflow no ramo main, elas aparecem aqui.");
    var ul = el("ul", { classe: "linhas" });
    runs.forEach(function (run) {
      var e = estadoRun(run);
      ul.appendChild(el("li", { classe: "linha-item" }, [
        icone(e[2], "estado-icone " + e[3]),
        el("div", { classe: "principal" }, [
          el("strong", { texto: (run.nome || run.workflow) + " #" + run.numero + (run.titulo && run.titulo !== run.nome ? " · " + run.titulo : "") }),
          el("span", { texto: (curto(run.commit) || "") + " · " + (run.evento || "") + " · " + (haQuanto(run.criadoEm) || "") }),
        ]),
        el("div", { classe: "lado" }, [chip(e[0], e[1]), botao("Acompanhar", { classe: "pequeno contorno", rotulo: "Acompanhar a execução " + run.numero + " de " + (run.nome || run.workflow), aoClicar: function () { abrirRun(run.id); } })]),
      ]));
    });
    return ul;
  }

  function botaoAtualizarCi() {
    return botao("Atualizar", { classe: "pequeno contorno", icone: "i-ciclo", aoClicar: function () { carregarCI(); } });
  }

  function dispararWorkflow(workflow, argumentos, contexto) {
    var args = { workflow: workflow };
    Object.keys(argumentos || {}).forEach(function (k) { args[k] = argumentos[k]; });
    executarAcao("ci.disparar", args, {
      titulo: "Iniciar " + contexto,
      contexto: contexto + " · ramo main",
      textoConfirmar: "Iniciar no GitHub Actions",
      aoConcluir: function (res) {
        if (res.ok && res.run && res.run.id) {
          toast("Execução iniciada no GitHub Actions; acompanhando.", "ok");
          carregarCI();
          abrirRun(res.run.id);
        } else if (res.indeterminado) {
          toast(res.erro.charAt(0).toUpperCase() + res.erro.slice(1), "alerta");
          carregarCI();
          setTimeout(carregarCI, 10000);
        } else {
          toast(res.erro || "o GitHub recusou o disparo", "erro");
        }
      },
    });
  }

  function renderWeb(caixa, m) {
    var w = m.web;
    var acoesApp = [];
    if (w.url) acoesApp.push(linkExterno("Abrir o RemoteIFES", w.url, "primario"));
    if (w.paginaAplicativo) acoesApp.push(linkExterno("Página Aplicativo", w.paginaAplicativo, "contorno"));
    if (w.url) acoesApp.push(botao("Copiar endereço", { classe: "contorno", icone: "i-copiar", aoClicar: function () { copiar(w.url); } }));
    caixa.appendChild(cartao({ titulo: "RemoteIFES na web", descricao: "Servido por este servidor, na mesma origem da API.", icone: "i-globo", tom: "tom-info", lado: chip("info", "frontend " + (w.versao || "?"), "sem-ponto") }, [
      fatos([["Endereço", w.url, "mono"], ["Versão do frontend", w.versao, "mono"]]),
      el("div", { classe: "acoes" }, acoesApp),
    ]));
    var conf = el("ul", { classe: "conferencias" }, [
      conferencia(w.https, "HTTPS", w.https ? "A origem é HTTPS: os navegadores oferecem instalar." : "A origem não é HTTPS: a PWA não é instalável, só o site no navegador."),
      conferencia(w.manifesto, "Manifesto do aplicativo", w.manifesto ? "manifest.webmanifest presente." : "manifest.webmanifest ausente no checkout."),
      conferencia(w.serviceWorker, "Funcionamento offline", w.serviceWorker ? "Service worker presente: o manual e a estrutura do app abrem sem rede." : "sw.js ausente no checkout."),
    ]);
    caixa.appendChild(cartao({ titulo: "Instalar como aplicativo (PWA)", icone: "i-celular", tom: "tom-info", lado: chip(w.https ? "ok" : "alerta", w.https ? "instalável" : "requer HTTPS") }, [
      conf,
      el("p", { texto: w.instalacao }),
      !w.https ? el("div", { classe: "acoes" }, [botao("Diagnóstico de rede", { classe: "pequeno contorno", aoClicar: function () { irPara("rede"); } })]) : null,
    ]));
    var runs = estado.ci && estado.ci.pages;
    caixa.appendChild(cartao({
      titulo: "Demonstração no GitHub Pages",
      descricao: "Vitrine opcional do site. A produção é sempre a deste servidor.",
      icone: "i-externo",
      tom: "tom-info",
      lado: m.credencialGitHub.presente ? el("div", { classe: "acoes" }, [botaoAtualizarCi(), botao("Publicar demonstração", { classe: "pequeno primario", icone: "i-play", aoClicar: function () { dispararWorkflow("pages", {}, "a publicação no GitHub Pages"); } })]) : null,
    }, [listaDeRuns(runs, { vazioTitulo: "Nenhuma publicação recente", vazioTexto: "O Pages publica sozinho depois que a CI passa num push em main que altera o site." })]));
  }

  function conferencia(ok, titulo, texto) {
    return el("li", {}, [icone(ok ? "i-circulo-check" : "i-circulo-x", ok ? "tom-operacao" : "tom-critico"), el("div", {}, [el("strong", { texto: titulo }), el("p", { classe: "fraco", texto: texto })])]);
  }

  function renderAndroid(caixa, m) {
    var rel = m.release;
    var conteudoApk;
    if (!rel.publicado) {
      conteudoApk = [vazio("i-celular", "tom-dispositivo", "Nenhum APK publicado neste servidor", "O RemoteIFES ainda não oferece o aplicativo Android na página Aplicativo (" + rel.motivo + ").", [
        botao("Como publicar", { classe: "primario", aoClicar: function () { var g = $("guiaPublicacao"); if (g) { g.scrollIntoView({ block: "start" }); g.focus(); } } }),
      ])];
    } else {
      var resultadoConferencia = el("div");
      conteudoApk = [
        fatos([
          ["Versão", rel.versao + " (build " + rel.build + ")"],
          ["Publicado", /^\d{4}-\d{2}-\d{2}$/.test(rel.publicadoEm || "") ? rel.publicadoEm.split("-").reverse().join("/") : quando(rel.publicadoEm)],
          ["Tamanho", rel.apkPresente ? bytes(rel.bytes) : "arquivo ausente"],
          ["Origem embutida", rel.serverOrigin, "mono"],
          ["SHA-256 do APK", rel.sha256, "mono"],
          ["Certificado (SHA-256)", rel.certificadoSha256, "mono"],
          ["Assinatura declarada", rel.assinadoDeclarado ? "sim (release.json)" : "não declarada"],
        ]),
        rel.impedimento ? aviso("erro", "O RemoteIFES não oferece este APK", rel.impedimento) : null,
        el("div", { classe: "acoes" }, [
          rel.baixavel ? el("a", { classe: "btn primario", attrs: { href: "/api/mobile/apk", download: "" } }, [icone("i-download"), el("span", { texto: "Baixar APK" })]) : null,
          rel.valido && rel.apkPresente ? botao("Conferir integridade", { classe: "contorno", icone: "i-auditoria", aoClicar: function () {
            limpar(resultadoConferencia).appendChild(el("p", { classe: "fraco", texto: "calculando o SHA-256…" }));
            api("/api/mobile/apk/conferir").then(function (r) {
              limpar(resultadoConferencia).appendChild(r.ok && r.corpo.ok
                ? aviso("ok", "Integridade conferida", "O SHA-256 do arquivo servido confere com release.json (" + bytes(r.corpo.bytes) + ").")
                : aviso("erro", "Integridade não confere", (r.corpo && r.corpo.erro) || "falha na conferência"));
            });
          } }) : null,
          m.web.paginaAplicativo ? linkExterno("Página Aplicativo", m.web.paginaAplicativo, "contorno") : null,
        ]),
        resultadoConferencia,
        detalhes("Sobre a assinatura", [el("p", { texto: rel.ressalvaAssinatura })]),
      ];
    }
    caixa.appendChild(cartao({ titulo: "APK publicado neste servidor", descricao: "O aplicativo de produção que o RemoteIFES oferece aos usuários.", icone: "i-celular", tom: "tom-dispositivo", lado: chip(rel.baixavel ? "ok" : rel.publicado ? "erro" : "alerta", rel.baixavel ? "versão " + rel.versao : rel.publicado ? "recusado" : "não publicado") }, conteudoApk));

    var runsAndroid = estado.ci && estado.ci.android;
    var matriz = el("input", { attrs: { type: "checkbox", id: "androidMatrizAmpla" } });
    caixa.appendChild(cartao({
      titulo: "Builds de validação",
      descricao: "APK debug, unsigned e assinado com chave descartável, inspecionados e testados em emulador no GitHub Actions. Nenhum é de produção.",
      icone: "i-ramo",
      tom: "tom-operacao",
      lado: m.credencialGitHub.presente ? botaoAtualizarCi() : null,
    }, [
      m.credencialGitHub.presente ? el("div", { classe: "acoes" }, [
        botao("Gerar build de validação", { classe: "primario", icone: "i-play", aoClicar: function () { dispararWorkflow("android", { matrizAmpla: matriz.checked }, "o build Android" + (matriz.checked ? " com APIs 24, 29, 34 e 36" : "")); } }),
        el("label", { classe: "checagem" }, [matriz, "Testar também nas APIs 24, 29 e 34"]),
      ]) : null,
      el("h3", { classe: "rotulo-secao", texto: "Execuções disparadas manualmente" }),
      listaDeRuns(runsAndroid, { vazioTitulo: "Nenhum build manual recente", vazioTexto: "Os builds Android disparados por mudanças no código rodam dentro da validação (CI); veja Builds e CI." }),
    ]));

    var destino = rel.destino;
    var passos = el("ol", { classe: "passos" });
    m.publicacao.passos.forEach(function (p) {
      passos.appendChild(el("li", {}, [el("strong", { texto: p.titulo }), el("span", { classe: "onde", texto: p.onde }), comando(p.comando), el("p", { classe: "fraco pequeno", texto: p.detalhe })]));
    });
    var guia = cartao({ titulo: "Publicar uma versão de produção", descricao: "A assinatura e a verificação exigem a chave de produção e o Android SDK, que não ficam neste host.", icone: "i-download", tom: "tom-atencao", id: "guiaPublicacao" }, [
      destino.divergem ? aviso("alerta", "Destinos divergentes", destino.observacao) : null,
      fatos([["Pasta servida por este servidor", destino.servidoPor, "mono"], ["Origem desta instalação", m.web.url, "mono"]]),
      passos,
      el("p", { classe: "fraco", texto: "Depois de copiar, volte aqui: o APK aparece em APK publicado e Conferir integridade recalcula o SHA-256." }),
    ]);
    guia.setAttribute("tabindex", "-1");
    caixa.appendChild(guia);

    caixa.appendChild(detalhes("Versões declaradas no checkout", [
      fatos([
        ["Android versionName", m.identidades.android && m.identidades.android.versionName],
        ["Android versionCode", m.identidades.android && m.identidades.android.versionCode],
        ["Pacote Cordova", m.identidades.pacoteCordova],
        ["Servidor", m.identidades.servidor],
        ["Frontend / PWA", m.identidades.frontendPwa],
        ["Firmware ESP32", m.identidades.firmware],
      ]),
      el("p", { classe: "fraco pequeno", texto: m.identidades.observacao }),
      el("p", { classe: "fraco pequeno", texto: m.build.politica }),
    ]));
  }

  function renderIos(caixa, m) {
    caixa.appendChild(cartao({
      titulo: "Build iOS em simulador",
      descricao: m.build.ios,
      icone: "i-celular",
      tom: "tom-admin",
      lado: m.credencialGitHub.presente ? botaoAtualizarCi() : null,
    }, [
      m.credencialGitHub.presente ? el("div", { classe: "acoes" }, [botao("Gerar build no simulador", { classe: "primario", icone: "i-play", aoClicar: function () { dispararWorkflow("ios", {}, "o build iOS no simulador"); } })]) : null,
      el("h3", { classe: "rotulo-secao", texto: "Execuções disparadas manualmente" }),
      listaDeRuns(estado.ci && estado.ci.ios, { vazioTitulo: "Nenhum build iOS manual recente", vazioTexto: "Os builds iOS disparados por mudanças no código rodam dentro da validação (CI)." }),
      aviso("info", "Sem distribuição iOS", "Não há IPA nem envio à App Store: em iPhone e iPad, use o RemoteIFES pelo navegador ou instalado como PWA."),
    ]));
  }

  function renderCiArea(caixa, m) {
    var ci = estado.ci;
    var execucao = estado.painel && estado.painel.aplicacao && estado.painel.aplicacao.commit;
    var matriz = el("input", { attrs: { type: "checkbox", id: "ciMatrizAmpla" } });
    var safari = el("input", { attrs: { type: "checkbox", id: "ciSafari" } });
    var ultima = ci && ci.disponivel && ci.ci && ci.ci[0];
    caixa.appendChild(cartao({
      titulo: "Validação do código (CI)",
      descricao: "Testes do servidor, do console, do site em vários navegadores, do firmware e dos aplicativos, no ramo main.",
      icone: "i-ramo",
      tom: "tom-operacao",
      lado: m.credencialGitHub.presente ? botaoAtualizarCi() : null,
    }, [
      ultima ? aviso(estadoRun(ultima)[0].indexOf("erro") === 0 ? "erro" : estadoRun(ultima)[0].indexOf("ok") === 0 ? "ok" : "info", "Última validação: " + estadoRun(ultima)[1], (ultima.titulo || "") + " · commit " + curto(ultima.commit)) : null,
      m.credencialGitHub.presente ? el("div", {}, [
        el("div", { classe: "acoes" }, [
          botao(execucao ? "Validar o commit em execução" : "Validar main agora", { classe: "primario", icone: "i-play", aoClicar: function () {
            var args = { matrizAmpla: matriz.checked, safariIos: safari.checked };
            if (execucao && /^[0-9a-f]{40}$/.test(execucao)) args.commit = execucao;
            dispararWorkflow("ci", args, "a validação completa" + (args.commit ? " exigindo o commit " + curto(execucao) : " do ramo main"));
          } }),
        ]),
        el("label", { classe: "checagem" }, [matriz, "Android em APIs 24, 29, 34 e 36"]),
        el("label", { classe: "checagem" }, [safari, "Safari em simulador iOS (diagnóstico)"]),
        execucao ? el("p", { classe: "fraco pequeno", texto: "A validação falha se o ramo main não estiver exatamente no commit " + curto(execucao) + ", o que o servidor executa agora." }) : null,
      ]) : null,
      el("h3", { classe: "rotulo-secao", texto: "Execuções recentes" }),
      listaDeRuns(ci && ci.ci),
      ci && ci.estadosDistintos ? el("p", { classe: "fraco pequeno", texto: ci.estadosDistintos }) : null,
    ]));
    caixa.appendChild(cartao({ titulo: "Release do Console de Operações", descricao: "Publicado a partir de uma etiqueta console-v<versão>; o console só acompanha.", icone: "i-pacote", tom: "tom-admin" }, [
      listaDeRuns(ci && ci.console, { vazioTitulo: "Nenhum release recente", vazioTexto: "Os releases do console aparecem aqui quando uma etiqueta console-v<versão> é enviada." }),
    ]));
    if (ci && ci.limite && ci.limite.restante !== null && ci.limite.restante !== undefined) caixa.appendChild(el("p", { classe: "fraco pequeno", texto: "Limite da API do GitHub: " + ci.limite.restante + " requisições restantes" + (ci.limite.reiniciaEm ? ", renova às " + quando(ci.limite.reiniciaEm) : "") + "." }));
  }

  function renderCredenciais(caixa, m) {
    var t = m.credencialGitHub;
    var resultado = el("div");
    var campo = el("input", { attrs: { type: "password", id: "githubToken", autocomplete: "off", spellcheck: "false", autocapitalize: "none", placeholder: "github_pat_…" } });
    var form = el("form", { classe: "limitado" }, [
      el("div", { classe: "campo" }, [el("label", { texto: t.presente ? "Substituir por um novo token" : "Token do GitHub", attrs: { for: "githubToken" } }), campo, el("p", { classe: "ajuda", texto: "Fine-grained, só para " + m.repositorio.dono + "/" + m.repositorio.repo + ", com Actions: leitura e escrita e Metadata: leitura." })]),
      el("div", { classe: "acoes" }, [el("button", { classe: "btn primario", attrs: { type: "submit" } }, [icone("i-chave"), el("span", { texto: "Gravar credencial" })])]),
    ]);
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var valor = campo.value.trim();
      if (valor.length < 20) { toast("O token parece curto demais.", "erro"); campo.focus(); return; }
      campo.value = "";
      executarAcao("github.credencial", { token: valor }, {
        aoConcluir: function (res) {
          if (res.ok === false) { toast(res.erro || "token recusado", "erro"); return; }
          var c = res.conferencia || {};
          toast(c.ok ? "Credencial gravada e acesso conferido." : "Credencial gravada, mas o acesso não foi confirmado: " + (c.erro || "?"), c.ok ? "ok" : "alerta");
          estado.ci = null;
          carregarAplicativos(true);
        },
      });
    });
    var acoes = [];
    if (t.presente) {
      acoes.push(botao("Conferir acesso", { classe: "contorno", icone: "i-auditoria", aoClicar: function () {
        limpar(resultado).appendChild(el("p", { classe: "fraco", texto: "consultando o GitHub…" }));
        api("/api/github/conferir").then(function (r) {
          var c = r.corpo || {};
          limpar(resultado).appendChild(c.ok
            ? aviso("ok", "Acesso confirmado", "O token lê " + c.repositorio + " e as execuções de Actions." + (c.escopos ? " Escopos: " + (c.escopos.join(", ") || "nenhum") + "." : "") + " " + c.observacao)
            : aviso("erro", "Acesso não confirmado", c.erro || "falha na consulta"));
        });
      } }));
      acoes.push(botao("Remover credencial", { classe: "contorno-perigo", icone: "i-lixeira", aoClicar: function () {
        executarAcao("github.remover-credencial", {}, { aoConcluir: function () { toast("Credencial removida.", "ok"); estado.ci = null; carregarAplicativos(true); } });
      } }));
    }
    caixa.appendChild(cartao({ titulo: "Credencial do GitHub", descricao: "Acompanha, dispara, repete e cancela execuções e baixa artefatos. O valor nunca volta por API, log ou auditoria.", icone: "i-chave", tom: "tom-atencao", lado: chip(t.presente ? "ok" : "alerta", t.presente ? "configurada" : "não configurada") }, [
      t.presente ? fatos([["Formato", t.formato], ["Gravada", quando(t.gravadoEm)], ["Repositório", m.repositorio.dono + "/" + m.repositorio.repo, "mono"]]) : el("p", { texto: "Sem credencial, o console e o RemoteIFES funcionam normalmente; só o acompanhamento e as ações da CI ficam indisponíveis." }),
      acoes.length ? el("div", { classe: "acoes" }, acoes) : null,
      resultado,
      form,
      detalhes("Como criar o token", [
        el("ol", {}, [
          el("li", { texto: "No GitHub: Settings > Developer settings > Personal access tokens > Fine-grained tokens > Generate new token." }),
          el("li", { texto: "Repository access: Only select repositories > " + m.repositorio.dono + "/" + m.repositorio.repo + "." }),
          el("li", { texto: "Permissions > Repository: Actions = Read and write; Metadata = Read-only." }),
          el("li", { texto: "Defina uma validade e cole o token acima. Ao expirar, grave um novo." }),
        ]),
      ]),
    ]));
    var d = m.release.destino;
    caixa.appendChild(cartao({ titulo: "Destino do APK", descricao: "Onde o publicador grava e de onde o servidor entrega o aplicativo Android.", icone: "i-celular", tom: "tom-dispositivo", lado: chip(d.divergem ? "alerta" : "ok", d.divergem ? "divergente" : "alinhado") }, [
      fatos([[d.variavelDoServidor + " (servido)", d.servidoPor, "mono"], [d.variavelDaPublicacao + " (publicação)", d.publicadoPara || "não definida", d.publicadoPara ? "mono" : null]]),
      el("p", { classe: d.divergem ? "" : "fraco", texto: d.observacao }),
    ]));
    caixa.appendChild(cartao({ titulo: "Chave de assinatura Android", icone: "i-cadeado", tom: "tom-critico" }, [
      el("p", { texto: "A chave de produção fica fora deste host e fora do Git, na máquina com o Android SDK, informada por REMOTEIFES_ANDROID_KEYSTORE e senhas próprias. Perdê-la impede atualizar os aplicativos instalados: guarde-a em cofre ou mídia cifrada." }),
    ]));
  }

  // --- Run follow-up --------------------------------------------------------------------------

  function pararRun() {
    if (estado.runRelogio) clearTimeout(estado.runRelogio);
    estado.runRelogio = null;
    estado.runAberto = null;
  }

  function abrirRun(id) {
    pararRun();
    estado.runAberto = id;
    var dlg = $("dlgRun");
    limpar($("dlgRunCorpo")).appendChild(el("p", { classe: "fraco", texto: "consultando o GitHub…" }));
    limpar($("dlgRunRodape"));
    $("dlgRunTitulo").textContent = "Execução";
    if (!dlg.open) dlg.showModal();
    atualizarRun(id);
  }

  function atualizarRun(id) {
    api("/api/ci/runs/" + encodeURIComponent(id)).then(function (r) {
      if (estado.runAberto !== id || !$("dlgRun").open) return;
      var corpo = limpar($("dlgRunCorpo"));
      var rodape = limpar($("dlgRunRodape"));
      if (!r.ok) {
        corpo.appendChild(aviso("erro", "Não foi possível consultar", r.corpo.erro || "falha"));
        rodape.appendChild(botao("Fechar", { classe: "primario", aoClicar: function () { $("dlgRun").close(); } }));
        return;
      }
      var d = r.corpo;
      var run = d.run;
      var e = estadoRun(run);
      var emAndamento = run.status !== "completed";
      $("dlgRunTitulo").textContent = (run.nome || run.workflow) + " #" + run.numero;
      corpo.appendChild(el("div", { classe: "acoes" }, [chip(e[0], e[1]), emAndamento ? el("span", { classe: "fraco pequeno", texto: "Atualiza sozinho a cada 10 s enquanto esta janela estiver aberta." }) : null]));
      if (emAndamento) corpo.appendChild(el("div", { classe: "barra" }, [el("i")]));
      corpo.appendChild(fatos([
        ["Commit", curto(run.commit), "mono"],
        ["Título", run.titulo],
        ["Evento", run.evento],
        ["Ramo", run.ramo],
        ["Iniciada", quando(run.iniciadoEm || run.criadoEm)],
        ["Tentativa", run.tentativa],
      ]));
      corpo.appendChild(el("h3", { classe: "rotulo-secao", texto: "Jobs (" + d.jobs.length + ")" }));
      if (d.erroJobs) corpo.appendChild(aviso("alerta", "Jobs não consultados", d.erroJobs));
      var falhos = d.jobs.filter(function (j) { return j.conclusao === "failure" || j.conclusao === "timed_out"; });
      d.jobs.forEach(function (j) {
        var ej = ESTADOS_RUN[j.status === "completed" ? j.conclusao || "neutral" : j.status] || ["", j.status, "i-circulo-vazio", ""];
        var etapas = el("ol");
        j.etapas.forEach(function (s) {
          var es = ESTADOS_RUN[s.status === "completed" ? s.conclusao || "neutral" : s.status] || ["", s.status, "i-circulo-vazio", ""];
          etapas.appendChild(el("li", {}, [icone(es[2], es[3]), " ", s.nome + (s.conclusao && s.conclusao !== "success" ? " — " + es[1] : "")]));
        });
        var det = el("details", { classe: "job" }, [el("summary", {}, [icone(ej[2], "estado-icone " + ej[3]), el("span", { classe: "nome", texto: j.nome }), chip(ej[0], ej[1])]), etapas]);
        if (falhos.indexOf(j) >= 0) det.open = true;
        corpo.appendChild(det);
      });
      corpo.appendChild(el("h3", { classe: "rotulo-secao", texto: "Artefatos (" + d.artefatos.length + ")" }));
      if (d.erroArtefatos) corpo.appendChild(aviso("alerta", "Artefatos não consultados", d.erroArtefatos));
      if (!d.artefatos.length) corpo.appendChild(el("p", { classe: "fraco", texto: emAndamento ? "Os artefatos aparecem quando os jobs que os geram terminam." : "Esta execução não gerou artefatos." }));
      var ul = el("ul", { classe: "linhas" });
      d.artefatos.forEach(function (a) {
        ul.appendChild(el("li", { classe: "linha-item" }, [
          icone("i-pacote", "estado-icone tom-admin"),
          el("div", { classe: "principal" }, [el("strong", { texto: a.nome }), el("span", { texto: bytes(a.bytes) + (a.expirado ? " · expirado" : " · disponível até " + quando(a.expiraEm)) + (a.digest ? " · " + a.digest : "") })]),
          a.expirado ? chip("", "expirado") : el("a", { classe: "btn pequeno contorno", attrs: { href: "/api/ci/runs/" + encodeURIComponent(run.id) + "/artefatos/" + encodeURIComponent(a.id), download: "", "aria-label": "Baixar " + a.nome } }, [icone("i-download"), el("span", { texto: "Baixar" })]),
        ]));
      });
      corpo.appendChild(ul);
      if (d.artefatos.length) corpo.appendChild(el("p", { classe: "fraco pequeno", texto: "O arquivo passa por este console direto para o seu navegador, sem ser gravado no host. O digest vem da mesma origem: confere o transporte, não a autoria." }));

      if (run.status === "completed" && ["failure", "cancelled", "timed_out", "startup_failure"].indexOf(run.conclusao) >= 0 && run.chave !== "console") {
        rodape.appendChild(botao("Repetir falhas", { classe: "primario", icone: "i-ciclo", aoClicar: function () { acaoRun("ci.reexecutar", { run: String(run.id) }, "Repetir os jobs com falha de " + run.nome + " #" + run.numero); } }));
      }
      if (run.status === "completed" && run.chave !== "console") {
        rodape.appendChild(botao("Repetir tudo", { classe: "contorno", aoClicar: function () { acaoRun("ci.reexecutar", { run: String(run.id), tudo: true }, "Repetir toda a execução " + run.nome + " #" + run.numero); } }));
      }
      if (emAndamento && run.chave !== "console") {
        rodape.appendChild(botao("Cancelar execução", { classe: "contorno-perigo", icone: "i-circulo-x", aoClicar: function () { acaoRun("ci.cancelar", { run: String(run.id) }, "Cancelar " + run.nome + " #" + run.numero); } }));
      }
      if (run.url) rodape.appendChild(linkExterno("Abrir no GitHub", run.url, "contorno"));
      rodape.appendChild(botao("Fechar", { classe: "contorno", aoClicar: function () { $("dlgRun").close(); } }));
      if (emAndamento) estado.runRelogio = setTimeout(function () { atualizarRun(id); }, 10000);
      else if (estado.ci && estado.ci.disponivel) carregarCI();
    });
  }

  function acaoRun(id, args, contexto) {
    executarAcao(id, args, {
      contexto: contexto,
      aoConcluir: function (res) {
        if (res.ok === false) { toast(res.erro || "o GitHub recusou a operação", "erro"); return; }
        toast(id === "ci.cancelar" ? "Cancelamento pedido ao GitHub." : "Execução repetida no GitHub; acompanhando.", "ok");
        setTimeout(function () { if (estado.runAberto) atualizarRun(estado.runAberto); }, 3000);
      },
    });
  }

  // --- Installed Console ---------------------------------------------------------------------

  var ROTULO_CAPACIDADE = {
    controleDeServico: "Controle do serviço do RemoteIFES",
    watchdog: "Watchdog de saúde",
    registrosDoSistema: "Registros do sistema",
    inicializacaoAutomatica: "Partida do console com o sistema",
    reinicioDoHost: "Reinício do host",
    terminal: "Terminal Expert",
  };
  var ROTULO_ESTADO = {
    suportado: ["ok", "disponível"],
    "nao-instalado": ["alerta", "não instalado"],
    "sem-permissao": ["alerta", "sem permissão"],
    indisponivel: ["erro", "indisponível"],
    "nao-aplicavel": ["", "não se aplica"],
    "nao-suportado": ["", "não suportado aqui"],
  };

  function carregarConsole() {
    Promise.all([api("/api/programa"), api("/api/desinstalacao")]).then(function (rs) {
      if (rs[0].ok) estado.programa = rs[0].corpo;
      if (rs[1].ok) estado.desinstalacao = rs[1].corpo;
      if (estado.programa) renderConsole(estado.programa, estado.desinstalacao);
    });
  }

  function renderConsole(prog, des) {
    var caixa = limpar($("consoleConteudo"));
    var c = prog.console;
    var pl = prog.plataforma;
    var escopos = { sistema: "instalação de sistema", usuario: "instalação de usuário" };
    caixa.appendChild(cartao({ titulo: "Console de Operações " + c.versaoEmExecucao, descricao: c.gerenciadoLadoALado ? "Programa instalado, com versões lado a lado." : "Executado a partir do código-fonte do checkout.", icone: "i-pacote", tom: "tom-admin", lado: el("div", { classe: "chips" }, [chip("info", pl.rotulo, "sem-ponto"), prog.instalacao.escopo ? chip("info", escopos[prog.instalacao.escopo] || prog.instalacao.escopo, "sem-ponto") : null]) }, [
      !pl.runtime.atende ? aviso("erro", "Node abaixo do exigido", pl.runtime.motivo || "") : null,
      el("div", { classe: "acoes" }, [botao("Atualizações do Console", { classe: "contorno", icone: "i-ciclo", aoClicar: function () { irPara("atualizacoes", "console"); } })]),
    ]));

    var caps = el("ul", { classe: "linhas" });
    Object.keys(pl.recursos).forEach(function (k) {
      var r = pl.recursos[k];
      var par = ROTULO_ESTADO[r.estado] || ["", r.estado];
      caps.appendChild(el("li", { classe: "linha-item" }, [
        icone(par[0] === "ok" ? "i-circulo-check" : par[0] === "erro" ? "i-circulo-x" : par[0] === "alerta" ? "i-circulo-exclamacao" : "i-circulo-vazio", "estado-icone " + (par[0] === "ok" ? "tom-operacao" : par[0] === "erro" ? "tom-critico" : par[0] === "alerta" ? "tom-atencao" : "")),
        el("div", { classe: "principal" }, [el("strong", { texto: ROTULO_CAPACIDADE[k] || k }), r.motivo ? el("span", { texto: r.motivo }) : null]),
        chip(par[0], par[1]),
      ]));
    });
    var a = pl.arquitetura || {};
    caixa.appendChild(cartao({ titulo: "Plataforma e capacidades", descricao: "Um recurso indisponível diz por quê, e o console recusa a operação de verdade, não só apaga o botão.", icone: "i-dispositivo", tom: "tom-dispositivo" }, [
      caps,
      detalhes("Sistema, arquitetura e ferramentas", [
        fatos([
          ["Sistema", pl.rotulo],
          ["Node", pl.runtime.versao + " (mínimo " + pl.runtime.minimoExigido + ")", "mono"],
          ["Runtime", a.runtime, "mono"],
          ["Kernel", a.kernel, "mono"],
          ["Userland", a.userland ? a.userland + (a.fonteUserland ? " (" + a.fonteUserland + ")" : "") : null, "mono"],
          ["Hardware", a.hardware, "mono"],
        ].concat(Object.keys(pl.ferramentas || {}).map(function (nome) { var f = pl.ferramentas[nome]; return [nome, f.disponivel ? f.versao || "presente" : f.motivo || "ausente", f.disponivel ? "mono" : null]; }))),
        a.ressalva ? aviso("info", "Arquitetura", a.ressalva) : null,
      ]),
    ]));

    var inst = prog.instalacao;
    caixa.appendChild(detalhes("Onde está instalado", [
      fatos([
        ["Programa", inst.raiz, "mono"],
        inst.payloadEmExecucao !== inst.raiz ? ["Versão em execução", inst.payloadEmExecucao, "mono"] : null,
        ["Estado (operadores, auditoria)", inst.estado, "mono"],
        ["Checkout administrado", inst.checkout, "mono"],
        ["Modo de execução", inst.modoDeExecucao],
        inst.protecaoDoContrato && inst.protecaoDoContrato.presente ? ["Contrato de identidade", (inst.protecaoDoContrato.restrito ? "restrito" : inst.protecaoDoContrato.verificavel ? "LEGÍVEL POR OUTROS" : "não verificável") + " · " + inst.protecaoDoContrato.mecanismo] : null,
      ]),
    ]));

    caixa.appendChild(renderDesinstalacao(des));
  }

  function renderDesinstalacao(d) {
    if (!d) return cartao({ titulo: "Desinstalar o Console", icone: "i-lixeira", tom: "tom-critico", classe: "perigo" }, [el("p", { classe: "fraco", texto: "consultando…" })]);
    var corpo = [
      el("p", {}, [rico("Remove **apenas o Console de Operações** deste computador. O RemoteIFES continua funcionando.")]),
      el("div", { classe: "grade-2" }, [
        el("div", {}, [el("h3", { texto: "Fica preservado" }), el("ul", {}, d.preservado.map(function (x) { return el("li", { texto: x }); })), el("p", { classe: "fraco pequeno", texto: "em " + d.estado })]),
        el("div", {}, [el("h3", { texto: "Não é tocado" }), el("ul", {}, d.naoTocado.map(function (x) { return el("li", { texto: x }); }))]),
      ]),
    ];
    var acoes = [];
    if (d.simulavel) acoes.push(botao("Simular desinstalação", { classe: "contorno", icone: "i-play", aoClicar: function () { executarAcao("console.simular-desinstalacao", {}, { direto: true }); } }));
    if (d.modo === "console") {
      acoes.push(botao("Desinstalar o Console…", { classe: "perigo", icone: "i-lixeira", aoClicar: function () {
        executarAcao("console.desinstalar", {}, { contexto: "Remover o Console de Operações deste computador. O RemoteIFES não é removido." });
      } }));
    } else if (d.modo === "terminal") {
      corpo.push(aviso("info", "Desinstalação fora do console", d.motivo));
      corpo.push(comando(d.comando));
    } else {
      corpo.push(aviso("info", "Nada a desinstalar", d.motivo));
    }
    if (acoes.length) corpo.push(el("div", { classe: "acoes" }, acoes));
    corpo.push(el("p", { classe: "fraco pequeno", texto: d.apagarEstado }));
    return cartao({ titulo: "Desinstalar o Console", descricao: "Use a simulação para ver exatamente o que sairia, sem mudar nada.", icone: "i-lixeira", tom: "tom-critico", variante: "erro", classe: "perigo" }, corpo);
  }

  // --- Security and audit -------------------------------------------------------------------

  var EVENTOS = {
    "sessao-iniciada": "Entrada no console", "sessao-encerrada": "Saída do console", "login-falhou": "Senha incorreta na entrada",
    "elevacao-concedida": "Operações sensíveis liberadas", "elevacao-encerrada": "Elevação encerrada", "operador-senha-trocada": "Senha do operador trocada",
    "operador-criado": "Operador criado", "trabalho-iniciado": "Operação iniciada", "trabalho-terminado": "Operação terminada",
    "trabalho-cancelado": "Operação cancelada", "trabalho-desfecho-desconhecido": "Operação com desfecho desconhecido", "acao-imediata": "Operação imediata",
    "workflow-disparado": "Workflow iniciado no GitHub", "workflow-reexecutado": "Workflow repetido no GitHub", "workflow-cancelado": "Workflow cancelado no GitHub",
    "github-token-gravado": "Credencial do GitHub gravada", "github-token-removido": "Credencial do GitHub removida", "github-token-conferido": "Credencial do GitHub conferida",
    "artefato-baixado": "Artefato da CI baixado", "apk-baixado": "APK publicado baixado", "atualizacao-verificada": "origin consultado",
    "objetos-buscados": "Atualizações buscadas", "terminal-aberto": "Terminal aberto", "terminal-encerrado": "Terminal encerrado",
    "csrf-recusado": "Requisição sem token recusada", "origem-recusada": "Origem recusada", "atualizacao-console-aplicada": "Console atualizado",
    "atualizacao-console-revertida": "Console revertido", "console-saiu-por-ociosidade": "Console encerrado por ociosidade", "erro-interno": "Erro interno do console",
  };

  function carregarSeguranca() {
    renderSessao();
    carregarTerminal();
    var caixa = $("segurancaConteudo");
    Promise.all([api("/api/trabalhos"), api("/api/auditoria?limite=60")]).then(function (rs) {
      var hist = $("cartaoHistorico");
      var aud = $("cartaoAuditoria");
      if (hist) hist.remove();
      if (aud) aud.remove();
      var trabalhos = rs[0].ok ? rs[0].corpo.trabalhos : [];
      var ul = el("ul", { classe: "linhas" });
      trabalhos.forEach(function (t) {
        var m = ESTADOS_TRABALHO[t.estado] || ["", t.estado, "i-info", ""];
        ul.appendChild(el("li", { classe: "linha-item" }, [
          icone(m[2], "estado-icone " + m[3]),
          el("div", { classe: "principal" }, [el("strong", { texto: t.rotulo || t.acao }), el("span", { texto: quando(t.iniciadoEm) + (t.operador ? " · " + t.operador : "") })]),
          el("div", { classe: "lado" }, [chip(m[0], m[1]), botao("Ver", { classe: "pequeno contorno", rotulo: "Ver " + (t.rotulo || t.acao), aoClicar: function () { abrirTrabalho(t.id, t.acao); } })]),
        ]));
      });
      caixa.appendChild(cartao({ id: "cartaoHistorico", titulo: "Histórico de operações", descricao: "Operações longas, com saída e desfecho verificados.", icone: "i-relogio", tom: "tom-admin" }, [trabalhos.length ? ul : vazio("i-relogio", "tom-admin", "Nenhuma operação ainda", "Reinícios, backups, atualizações e restaurações aparecem aqui.")]));

      var itens = rs[1].ok ? rs[1].corpo.itens : [];
      var ula = el("ul", { classe: "linhas" });
      itens.forEach(function (item) {
        var resto = {};
        Object.keys(item).forEach(function (k) { if (k !== "em" && k !== "evento") resto[k] = item[k]; });
        var partes = Object.keys(resto).map(function (k) { return k + ": " + (typeof resto[k] === "object" ? JSON.stringify(resto[k]) : resto[k]); });
        ula.appendChild(el("li", { classe: "linha-item" }, [
          el("div", { classe: "principal" }, [el("strong", { texto: EVENTOS[item.evento] || String(item.evento).replace(/-/g, " ") }), el("span", { texto: quando(item.em) + (partes.length ? " · " + partes.join(" · ") : "") })]),
        ]));
      });
      caixa.appendChild(cartao({ id: "cartaoAuditoria", titulo: "Registro de auditoria", descricao: "Metadados das operações. Nunca contém senhas, tokens nem transcrição de terminal.", icone: "i-auditoria", tom: "tom-admin" }, [itens.length ? ula : vazio("i-auditoria", "tom-admin", "Nenhum evento registrado", null)]));

      var host = $("cartaoHost");
      if (host) host.remove();
      caixa.appendChild(cartao({ id: "cartaoHost", titulo: "Ações de exceção no host", icone: "i-ferramenta", tom: "tom-critico", classe: "perigo" }, [
        el("p", { texto: "Reiniciar o host derruba tudo: RemoteIFES, console e esta conexão. A volta depende do boot; se algo impedir a subida, só acesso físico ou SSH resolve." }),
        el("div", { classe: "acoes" }, [botao("Reiniciar o host…", { classe: "perigo", icone: "i-power", aoClicar: function () { executarAcao("host.reiniciar", {}); } })]),
      ]));
    });
  }

  function renderSessao() {
    var caixa = $("segurancaConteudo");
    var existente = $("cartaoSessao");
    var restante = Math.max(0, Math.round((estado.elevacaoAte - Date.now()) / 1000));
    var atual = el("input", { attrs: { type: "password", id: "senhaAtual", autocomplete: "current-password" } });
    var nova = el("input", { attrs: { type: "password", id: "senhaNova", autocomplete: "new-password", minlength: "12" } });
    var nova2 = el("input", { attrs: { type: "password", id: "senhaNova2", autocomplete: "new-password" } });
    var form = el("form", { classe: "limitado" }, [
      el("input", { attrs: { type: "text", name: "username", autocomplete: "username", value: estado.operador || "", hidden: "hidden" } }),
      el("div", { classe: "campo" }, [el("label", { texto: "Senha atual", attrs: { for: "senhaAtual" } }), atual]),
      el("div", { classe: "campo" }, [el("label", { texto: "Nova senha", attrs: { for: "senhaNova" } }), nova, el("p", { classe: "ajuda", texto: "Mínimo de 12 caracteres. A sessão é encerrada depois da troca." })]),
      el("div", { classe: "campo" }, [el("label", { texto: "Repita a nova senha", attrs: { for: "senhaNova2" } }), nova2]),
      el("div", { classe: "acoes" }, [el("button", { classe: "btn contorno", attrs: { type: "submit" } }, [icone("i-chave"), el("span", { texto: "Trocar minha senha" })])]),
    ]);
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (nova.value !== nova2.value) { toast("As duas senhas novas não conferem.", "erro"); nova2.focus(); return; }
      api("/api/sessao/senha", { method: "POST", corpo: { atual: atual.value, nova: nova.value } }).then(function (r) {
        atual.value = nova.value = nova2.value = "";
        if (!r.ok) { toast(r.corpo.erro || "a senha não foi trocada", "erro"); return; }
        reaplicarA11yDepois(function () { mostrarEntrada("Senha trocada. Entre com a senha nova.", "ok"); });
      });
    });
    var novo = cartao({ id: "cartaoSessao", titulo: "Sua sessão", descricao: "Operador " + estado.operador + ".", icone: "i-usuario", tom: "tom-admin", lado: chip(estado.elevada ? "alerta" : "ok", estado.elevada ? "elevada · " + Math.max(1, Math.ceil(restante / 60)) + " min" : "normal") }, [
      el("p", { texto: "Operações sensíveis pedem a senha de novo. A liberação vale por poucos minutos e termina ao sair, ao trocar a senha ou quando você a encerra." }),
      el("div", { classe: "acoes" }, [
        estado.elevada
          ? botao("Encerrar elevação", { classe: "contorno", icone: "i-cadeado", aoClicar: encerrarElevacao })
          : botao("Liberar operações sensíveis", { classe: "contorno", icone: "i-cadeado", aoClicar: function () { pedirElevacao(); } }),
      ]),
      detalhes("Trocar minha senha", [form]),
    ]);
    if (existente) existente.replaceWith(novo);
    else caixa.insertBefore(novo, caixa.firstChild);
  }

  // --- Terminal -----------------------------------------------------------------------------------

  var terminalAtual = null;
  var terminalPos = 0;
  var terminalRelogio = null;

  function carregarTerminal() {
    var caixa = limpar($("terminalEstado"));
    api("/api/terminal").then(function (r) {
      if (!r.ok) return;
      var t = r.corpo;
      if (!t.disponivel) {
        caixa.appendChild(aviso("info", "Terminal indisponível", t.motivo));
        caixa.appendChild(el("p", { classe: "fraco", texto: t.explicacao }));
        caixa.appendChild(detalhes("Como habilitar", [el("pre", { classe: "saida", texto: (t.instalacao || []).join("\n") }), el("p", { classe: "fraco", texto: t.alternativa })]));
        $("terminalArea").hidden = true;
        return;
      }
      caixa.appendChild(aviso("alerta", "Alto risco", t.politica));
      caixa.appendChild(aviso("alerta", "Sem redação de saída", t.redacao));
      caixa.appendChild(fatos([["Shell", t.shell, "mono"], ["Implementação", t.implementacao], ["Sessões simultâneas", t.limites.maxSessoes], ["Relock por ociosidade", duracao(t.limites.ociosoSegundos)], ["Duração máxima", duracao(t.limites.maximoSegundos)]]));
      if (!terminalAtual) caixa.appendChild(el("div", { classe: "acoes" }, [botao("Destravar e abrir o terminal", { classe: "perigo", icone: "i-terminal", aoClicar: abrirTerminal })]));
    });
  }

  function abrirTerminal() {
    api("/api/terminal/sessoes", { method: "POST", corpo: { colunas: 100, linhas: 30 } }).then(function (r) {
      if (r.status === 403 && r.corpo.precisaElevacao) { pedirElevacao(abrirTerminal); return; }
      if (!r.ok) { toast(r.corpo.erro || "não foi possível abrir o terminal", "erro"); return; }
      terminalAtual = r.corpo.id;
      terminalPos = 0;
      $("terminalTela").textContent = "";
      $("terminalArea").hidden = false;
      $("terminalEntrada").focus();
      terminalRelogio = setInterval(lerTerminal, 700);
      carregarTerminal();
    });
  }

  function lerTerminal() {
    if (!terminalAtual) return;
    api("/api/terminal/sessoes/" + encodeURIComponent(terminalAtual) + "/saida?desde=" + terminalPos).then(function (r) {
      if (r.status === 404) { fecharTerminal(true); return; }
      if (!r.ok) return;
      if (r.corpo.texto) {
        var tela = $("terminalTela");
        tela.textContent += r.corpo.texto;
        tela.scrollTop = tela.scrollHeight;
      }
      terminalPos = r.corpo.posicao;
    });
  }

  function fecharTerminalLocal() {
    if (terminalRelogio) { clearInterval(terminalRelogio); terminalRelogio = null; }
    terminalAtual = null;
    $("terminalArea").hidden = true;
  }

  function fecharTerminal(jaMorreu) {
    var id = terminalAtual;
    fecharTerminalLocal();
    if (id && !jaMorreu) api("/api/terminal/sessoes/" + encodeURIComponent(id), { method: "DELETE" });
    carregarTerminal();
  }

  // --- Session end -------------------------------------------------------------------------------

  // The logout answer carries Clear-Site-Data, which also wipes this origin's localStorage; the
  // accessibility preferences are written back afterwards because they are not session data.
  function reaplicarA11yDepois(fn) {
    var guardado = JSON.parse(JSON.stringify(a11y));
    fn();
    setTimeout(function () { a11y = guardado; salvarA11y(); }, 0);
  }

  function sair() {
    api("/api/sessao", { method: "DELETE" }).then(function () {
      reaplicarA11yDepois(function () { mostrarEntrada(); });
    });
  }

  // --- Wiring ----------------------------------------------------------------------------------------

  function ligarEventos() {
    window.addEventListener("hashchange", rotear);
    document.querySelectorAll("[data-area]").forEach(function (b) {
      b.addEventListener("click", function () {
        var a = b.getAttribute("data-area");
        if (a === "mais") { abrirMais(); return; }
        irPara(a, SUBS[a] ? estado.sub[a] : null);
      });
    });
    document.querySelectorAll("[data-subabas]").forEach(function (lista) {
      var area = lista.getAttribute("data-subabas");
      lista.addEventListener("click", function (ev) {
        var t = ev.target.closest("[role=tab]");
        if (t) irPara(area, t.getAttribute("data-sub"));
      });
      lista.addEventListener("keydown", function (ev) {
        if (["ArrowRight", "ArrowLeft", "Home", "End"].indexOf(ev.key) < 0) return;
        ev.preventDefault();
        var subs = SUBS[area];
        var i = subs.indexOf(estado.sub[area]);
        var n = ev.key === "Home" ? 0 : ev.key === "End" ? subs.length - 1 : (i + (ev.key === "ArrowRight" ? 1 : -1) + subs.length) % subs.length;
        irPara(area, subs[n]);
        lista.querySelector('[data-sub="' + subs[n] + '"]').focus();
      });
    });

    $("btnMarca").addEventListener("click", function () { irPara("inicio"); });
    $("btnConta").addEventListener("click", function (ev) {
      ev.stopPropagation();
      var menu = $("menuConta");
      menu.hidden = !menu.hidden;
      $("btnConta").setAttribute("aria-expanded", String(!menu.hidden));
      if (!menu.hidden) menu.querySelector("button").focus();
    });
    $("menuConta").addEventListener("click", function (ev) {
      var b = ev.target.closest("[data-menu]");
      if (!b) return;
      fecharMenus();
      var acao = b.getAttribute("data-menu");
      if (acao === "elevar") pedirElevacao();
      if (acao === "seguranca") irPara("seguranca");
      if (acao === "manual") abrirManual();
      if (acao === "sair") sair();
    });
    document.addEventListener("click", function (ev) {
      if (!ev.target.closest(".menu-conta")) fecharMenus();
      if (!ev.target.closest(".painel-flutuante") && !ev.target.closest(".fab")) {
        Object.keys(PAINEIS).forEach(function (p) { if (!$(p).hidden) alternarPainel(p, false); });
      }
    });
    document.addEventListener("keydown", function (ev) {
      if (ev.key !== "Escape") return;
      if (!$("manual").hidden) { fecharManual(); return; }
      if (!$("menuConta").hidden) { fecharMenus(); $("btnConta").focus(); return; }
      Object.keys(PAINEIS).forEach(function (p) { if (!$(p).hidden) { alternarPainel(p, false); $(PAINEIS[p]).focus(); } });
    });
    $("seloElevacao").addEventListener("click", encerrarElevacao);
    $("btnAjuda").addEventListener("click", function () { alternarPainel("painelAjuda"); });
    $("btnA11y").addEventListener("click", function () { alternarPainel("painelA11y"); });
    document.querySelectorAll("[data-fechar]").forEach(function (b) {
      b.addEventListener("click", function () { var id = b.getAttribute("data-fechar"); alternarPainel(id, false); $(PAINEIS[id]).focus(); });
    });
    $("btnAjudaManual").addEventListener("click", function () { alternarPainel("painelAjuda", false); abrirManual(); });
    $("manualFechar").addEventListener("click", fecharManual);
    $("manualVoltar").addEventListener("click", fecharManual);
    $("manualBusca").addEventListener("input", function (ev) { renderManual(ev.target.value); });
    document.querySelectorAll("[data-fechar-dlg]").forEach(function (b) {
      b.addEventListener("click", function () { $(b.getAttribute("data-fechar-dlg")).close(); });
    });
    $("dlgRun").addEventListener("close", pararRun);
    $("formElevacao").addEventListener("submit", enviarElevacao);
    $("dlgElevacao").addEventListener("close", function () { aoElevar = null; });

    $("formLogin").addEventListener("submit", function (ev) {
      ev.preventDefault();
      api("/api/sessao", { method: "POST", corpo: { nome: $("loginNome").value.trim(), senha: $("loginSenha").value } }).then(function (r) {
        $("loginSenha").value = "";
        if (!r.ok) {
          limpar($("entradaAviso")).appendChild(aviso("erro", "Não foi possível entrar", r.corpo.erro || "credenciais inválidas"));
          $("loginSenha").focus();
          return;
        }
        api("/api/sessao").then(function (s) { if (s.ok && s.corpo.autenticado) entrarNoConsole(s.corpo); });
      });
    });

    $("formPrimeiroAcesso").addEventListener("submit", function (ev) {
      ev.preventDefault();
      var corpo = { nome: $("paNome").value.trim(), senha: $("paSenha").value };
      if (conviteInicial) corpo.convite = conviteInicial;
      else corpo.segredo = $("paSegredo").value;
      api("/api/bootstrap", { method: "POST", corpo: corpo }).then(function (r) {
        if (!r.ok) {
          limpar($("entradaAviso")).appendChild(aviso("erro", "Não foi possível criar o operador", r.corpo.erro || "falha"));
          if (conviteInicial && r.status === 403) {
            conviteInicial = null;
            usarConvite(false);
          }
          return;
        }
        conviteInicial = null;
        $("paSegredo").value = "";
        $("paSenha").value = "";
        mostrarEntrada("Operador criado. Entre com as credenciais que acabou de definir.", "ok");
      });
    });

    $("btnAtualizarPainel").addEventListener("click", function () { carregarPainel(true).then(function () { toast("Painel atualizado.", "ok"); }); });
    $("btnCarregarLog").addEventListener("click", carregarLog);
    $("btnCarregarRede").addEventListener("click", carregarRede);
    $("formAcesso").addEventListener("submit", function (ev) {
      ev.preventDefault();
      executarAcao("rede.acesso-aplicacao", { modoTeste: $("acessoModoTeste").checked, redesAutorizadas: $("acessoRedes").value.trim() });
    });
    $("btnTerminalFechar").addEventListener("click", function () { fecharTerminal(false); });
    $("terminalEntrada").addEventListener("keydown", function (ev) {
      if (ev.key !== "Enter" || !terminalAtual) return;
      ev.preventDefault();
      var texto = ev.target.value + "\n";
      ev.target.value = "";
      api("/api/terminal/sessoes/" + encodeURIComponent(terminalAtual) + "/entrada", { method: "POST", corpo: { dados: texto } }).then(function (r) {
        if (r.status === 403) { fecharTerminal(true); toast("A elevação expirou e o terminal foi encerrado.", "alerta"); }
      });
    });
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden && estado.operador && (estado.area === "inicio" || estado.area === "servico")) carregarPainel();
    });
    ligarA11y();
  }

  function abrirMais() {
    var ul = limpar($("maisLista"));
    var itens = [
      ["dados", "i-banco", "tom-dispositivo"], ["rede", "i-globo", "tom-info"], ["console", "i-pacote", "tom-admin"], ["seguranca", "i-auditoria", "tom-admin"],
      ["inicio", "i-casa", "tom-operacao"], ["servico", "i-status", "tom-operacao"], ["atualizacoes", "i-ciclo", "tom-atencao"], ["aplicativos", "i-celular", "tom-info"],
    ];
    itens.forEach(function (x) {
      ul.appendChild(el("li", {}, [el("button", { classe: "nav-item", attrs: { type: "button", "aria-current": estado.area === x[0] ? "page" : null }, on: { click: function () { $("dlgMais").close(); irPara(x[0], SUBS[x[0]] ? estado.sub[x[0]] : null); } } }, [bolha(x[1], x[2], "pequena"), NOMES[x[0]]])]));
    });
    ul.appendChild(el("li", {}, [el("button", { classe: "nav-item", attrs: { type: "button" }, on: { click: function () { $("dlgMais").close(); abrirManual(); } } }, [bolha("i-manual", "tom-info", "pequena"), "Manual do console"])]));
    $("dlgMais").showModal();
  }

  function iniciar() {
    ligarEventos();
    aplicarA11y();
    api("/api/sessao").then(function (r) {
      if (r.ok && r.corpo.autenticado) entrarNoConsole(r.corpo);
      else mostrarEntrada();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", iniciar);
  else iniciar();
})();

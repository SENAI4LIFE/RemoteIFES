(function () {
  const CHAVE_FONTE = "remoteifes_font_scale";
  const CHAVE_ESPACAMENTO = "remoteifes_letter_spacing";
  const CHAVE_ALTURA = "remoteifes_line_height";
  const CHAVE_DISLEXIA = "remoteifes_dyslexic_font";
  const CHAVE_LINKS = "remoteifes_link_highlight";
  const CHAVE_CONTRASTE = "remoteifes_high_contrast";

  const FONTE_MIN = 0.85;
  const FONTE_MAX = 1.3;
  const FONTE_PASSO = 0.075;

  const ESPACAMENTO_MIN = 0;
  const ESPACAMENTO_MAX = 0.15;
  const ESPACAMENTO_PASSO = 0.03;
  const ESPACAMENTO_PADRAO = 0;

  const ALTURA_MIN = 1.2;
  const ALTURA_MAX = 2.2;
  const ALTURA_PASSO = 0.2;
  const ALTURA_PADRAO = 1.2;

  function lerNumero(chave, padrao) {
    const salvo = parseFloat(localStorage.getItem(chave));
    return Number.isFinite(salvo) ? salvo : padrao;
  }

  function lerBooleano(chave) {
    return localStorage.getItem(chave) === "1";
  }

  function salvar(chave, valor) {
    localStorage.setItem(chave, String(valor));
  }

  function aplicarFonte(escala) {
    document.documentElement.style.setProperty("--a11y-zoom", escala);
  }

  function aplicarEspacamento(valor) {
    document.documentElement.style.setProperty("--a11y-letter-spacing", `${valor}em`);
  }

  function aplicarAltura(valor) {
    document.documentElement.style.setProperty("--a11y-line-height", valor);
  }

  function aplicarDislexia(ativo) {
    document.body.classList.toggle("a11y-dyslexic-font", ativo);
  }

  function aplicarDestaqueLinks(ativo) {
    document.body.classList.toggle("a11y-link-highlight", ativo);
  }

  function aplicarContraste(ativo) {
    document.body.classList.toggle("a11y-high-contrast", ativo);
  }

  let escalaFonte = lerNumero(CHAVE_FONTE, FONTE_MIN);
  let espacamento = lerNumero(CHAVE_ESPACAMENTO, ESPACAMENTO_PADRAO);
  let altura = lerNumero(CHAVE_ALTURA, ALTURA_PADRAO);
  let dislexiaAtiva = lerBooleano(CHAVE_DISLEXIA);
  let linksAtivo = lerBooleano(CHAVE_LINKS);
  let contrasteAtivo = lerBooleano(CHAVE_CONTRASTE);

  aplicarFonte(escalaFonte);
  aplicarEspacamento(espacamento);
  aplicarAltura(altura);
  aplicarDislexia(dislexiaAtiva);
  aplicarDestaqueLinks(linksAtivo);
  aplicarContraste(contrasteAtivo);

  document.addEventListener("DOMContentLoaded", () => {
    const toggleBtn = document.getElementById("a11yToggleBtn");
    const panel = document.getElementById("a11yPanel");
    const closeBtn = document.getElementById("a11yCloseBtn");
    if (!toggleBtn || !panel) return;

    const fontDecreaseBtn = document.getElementById("a11yFontDecreaseBtn");
    const fontIncreaseBtn = document.getElementById("a11yFontIncreaseBtn");
    const fontResetBtn = document.getElementById("a11yFontResetBtn");

    const spacingDecreaseBtn = document.getElementById("a11ySpacingDecreaseBtn");
    const spacingIncreaseBtn = document.getElementById("a11ySpacingIncreaseBtn");
    const spacingResetBtn = document.getElementById("a11ySpacingResetBtn");

    const lineDecreaseBtn = document.getElementById("a11yLineDecreaseBtn");
    const lineIncreaseBtn = document.getElementById("a11yLineIncreaseBtn");
    const lineResetBtn = document.getElementById("a11yLineResetBtn");

    const dyslexicBtn = document.getElementById("a11yDyslexicToggleBtn");
    const linkHighlightBtn = document.getElementById("a11yLinkHighlightToggleBtn");
    const contrastBtn = document.getElementById("a11yContrastToggleBtn");
    const resetAllBtn = document.getElementById("a11yResetAllBtn");

    function atualizarBotaoToggle(btn, ativo) {
      btn.setAttribute("aria-pressed", String(ativo));
      btn.textContent = ativo ? "Desativar" : "Ativar";
      btn.classList.toggle("is-active", ativo);
    }

    atualizarBotaoToggle(dyslexicBtn, dislexiaAtiva);
    atualizarBotaoToggle(linkHighlightBtn, linksAtivo);
    atualizarBotaoToggle(contrastBtn, contrasteAtivo);

    function abrirPainel() {
      panel.classList.remove("hidden");
      toggleBtn.setAttribute("aria-expanded", "true");
    }

    function fecharPainel() {
      panel.classList.add("hidden");
      toggleBtn.setAttribute("aria-expanded", "false");
    }

    toggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (panel.classList.contains("hidden")) abrirPainel();
      else fecharPainel();
    });

    if (closeBtn) closeBtn.addEventListener("click", fecharPainel);

    document.addEventListener("click", (e) => {
      if (!panel.contains(e.target) && e.target !== toggleBtn && !toggleBtn.contains(e.target)) {
        fecharPainel();
      }
    });

    fontDecreaseBtn.addEventListener("click", () => {
      escalaFonte = Math.min(FONTE_MAX, Math.max(FONTE_MIN, +(escalaFonte - FONTE_PASSO).toFixed(3)));
      aplicarFonte(escalaFonte);
      salvar(CHAVE_FONTE, escalaFonte);
    });
    fontIncreaseBtn.addEventListener("click", () => {
      escalaFonte = Math.min(FONTE_MAX, Math.max(FONTE_MIN, +(escalaFonte + FONTE_PASSO).toFixed(3)));
      aplicarFonte(escalaFonte);
      salvar(CHAVE_FONTE, escalaFonte);
    });
    fontResetBtn.addEventListener("click", () => {
      escalaFonte = FONTE_MIN;
      aplicarFonte(escalaFonte);
      salvar(CHAVE_FONTE, escalaFonte);
    });

    spacingDecreaseBtn.addEventListener("click", () => {
      espacamento = Math.min(ESPACAMENTO_MAX, Math.max(ESPACAMENTO_MIN, +(espacamento - ESPACAMENTO_PASSO).toFixed(3)));
      aplicarEspacamento(espacamento);
      salvar(CHAVE_ESPACAMENTO, espacamento);
    });
    spacingIncreaseBtn.addEventListener("click", () => {
      espacamento = Math.min(ESPACAMENTO_MAX, Math.max(ESPACAMENTO_MIN, +(espacamento + ESPACAMENTO_PASSO).toFixed(3)));
      aplicarEspacamento(espacamento);
      salvar(CHAVE_ESPACAMENTO, espacamento);
    });
    spacingResetBtn.addEventListener("click", () => {
      espacamento = ESPACAMENTO_PADRAO;
      aplicarEspacamento(espacamento);
      salvar(CHAVE_ESPACAMENTO, espacamento);
    });

    lineDecreaseBtn.addEventListener("click", () => {
      altura = Math.min(ALTURA_MAX, Math.max(ALTURA_MIN, +(altura - ALTURA_PASSO).toFixed(2)));
      aplicarAltura(altura);
      salvar(CHAVE_ALTURA, altura);
    });
    lineIncreaseBtn.addEventListener("click", () => {
      altura = Math.min(ALTURA_MAX, Math.max(ALTURA_MIN, +(altura + ALTURA_PASSO).toFixed(2)));
      aplicarAltura(altura);
      salvar(CHAVE_ALTURA, altura);
    });
    lineResetBtn.addEventListener("click", () => {
      altura = ALTURA_PADRAO;
      aplicarAltura(altura);
      salvar(CHAVE_ALTURA, altura);
    });

    dyslexicBtn.addEventListener("click", () => {
      dislexiaAtiva = !dislexiaAtiva;
      aplicarDislexia(dislexiaAtiva);
      salvar(CHAVE_DISLEXIA, dislexiaAtiva ? 1 : 0);
      atualizarBotaoToggle(dyslexicBtn, dislexiaAtiva);
    });

    linkHighlightBtn.addEventListener("click", () => {
      linksAtivo = !linksAtivo;
      aplicarDestaqueLinks(linksAtivo);
      salvar(CHAVE_LINKS, linksAtivo ? 1 : 0);
      atualizarBotaoToggle(linkHighlightBtn, linksAtivo);
    });

    contrastBtn.addEventListener("click", () => {
      contrasteAtivo = !contrasteAtivo;
      aplicarContraste(contrasteAtivo);
      salvar(CHAVE_CONTRASTE, contrasteAtivo ? 1 : 0);
      atualizarBotaoToggle(contrastBtn, contrasteAtivo);
    });

    resetAllBtn.addEventListener("click", () => {
      escalaFonte = FONTE_MIN;
      espacamento = ESPACAMENTO_PADRAO;
      altura = ALTURA_PADRAO;
      dislexiaAtiva = false;
      linksAtivo = false;
      contrasteAtivo = false;

      aplicarFonte(escalaFonte);
      aplicarEspacamento(espacamento);
      aplicarAltura(altura);
      aplicarDislexia(dislexiaAtiva);
      aplicarDestaqueLinks(linksAtivo);
      aplicarContraste(contrasteAtivo);

      salvar(CHAVE_FONTE, escalaFonte);
      salvar(CHAVE_ESPACAMENTO, espacamento);
      salvar(CHAVE_ALTURA, altura);
      salvar(CHAVE_DISLEXIA, 0);
      salvar(CHAVE_LINKS, 0);
      salvar(CHAVE_CONTRASTE, 0);

      atualizarBotaoToggle(dyslexicBtn, false);
      atualizarBotaoToggle(linkHighlightBtn, false);
      atualizarBotaoToggle(contrastBtn, false);
    });

    // Widget de ajuda geral (bolha "?" fixa no canto inferior direito).
    const helpFabToggle = document.getElementById("helpFabToggleBtn");
    const helpFabPanel = document.getElementById("helpFabPanel");
    const helpFabClose = document.getElementById("helpFabCloseBtn");
    if (helpFabToggle && helpFabPanel) {
      helpFabToggle.addEventListener("click", (e) => {
        e.stopPropagation();
        helpFabPanel.classList.toggle("hidden");
      });
      if (helpFabClose) {
        helpFabClose.addEventListener("click", () => helpFabPanel.classList.add("hidden"));
      }
      document.addEventListener("click", (e) => {
        if (!helpFabPanel.contains(e.target) && e.target !== helpFabToggle && !helpFabToggle.contains(e.target)) {
          helpFabPanel.classList.add("hidden");
        }
      });
    }
  });
})();

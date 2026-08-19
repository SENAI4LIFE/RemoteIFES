(function () {
  const CHAVE_FONTE = "remoteifes_font_scale";
  const CHAVE_ESPACAMENTO = "remoteifes_letter_spacing";
  const CHAVE_ALTURA = "remoteifes_line_height";
  const CHAVE_DISLEXIA = "remoteifes_dyslexic_font";
  const CHAVE_LINKS = "remoteifes_link_highlight";
  const CHAVE_CONTRASTE = "remoteifes_high_contrast";
  const CHAVE_FONT_TYPE = "remoteifes_font_type";
  const CHAVE_IMAGEM_OCULTA = "remoteifes_hide_images";
  const CHAVE_FONT_COLOR = "remoteifes_font_color";
  const CHAVE_TEXT_COLOR = "remoteifes_text_color";
  const CHAVE_PARAGRAFO = "remoteifes_paragraph_width";
  const CHAVE_ALINHAMENTO = "remoteifes_text_align";

  const FONTE_MIN = 0.85;
  const FONTE_MAX = 1.3;
  const FONTE_PASSO = 0.075;
  const FONTE_PADRAO = 1;

  const ESPACAMENTO_MIN = 0;
  const ESPACAMENTO_MAX = 0.15;
  const ESPACAMENTO_PASSO = 0.01;
  const ESPACAMENTO_PADRAO = 0;

  const ALTURA_MIN = 1.2;
  const ALTURA_MAX = 2.2;
  const ALTURA_PASSO = 0.1;
  const ALTURA_PADRAO = 1.2;

  const LARGURA_PARAGRAFO_PASSOS = ["none", "70ch", "60ch", "52ch", "44ch"];
  const LARGURA_PARAGRAFO_ROTULOS = ["Padrão", "70ch", "60ch", "52ch", "44ch"];
  const LARGURA_PARAGRAFO_PADRAO = 0;

  const COR_PADRAO = "#1f2b23";

  function lerNumero(chave, padrao) {
    const salvo = parseFloat(localStorage.getItem(chave));
    return Number.isFinite(salvo) ? salvo : padrao;
  }

  function lerInteiro(chave, padrao) {
    const salvo = parseInt(localStorage.getItem(chave), 10);
    return Number.isFinite(salvo) ? salvo : padrao;
  }

  function lerBooleano(chave) {
    return localStorage.getItem(chave) === "1";
  }

  function lerTexto(chave, padrao) {
    const salvo = localStorage.getItem(chave);
    return salvo === null ? padrao : salvo;
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

  function aplicarDestaqueLinks(ativo) {
    document.body.classList.toggle("a11y-link-highlight", ativo);
  }

  function aplicarContraste(ativo) {
    document.body.classList.toggle("a11y-high-contrast", ativo);
  }

  function aplicarTipoFonte(tipo) {
    document.body.classList.remove("a11y-dyslexic-font", "a11y-font-serif", "a11y-font-sans");
    if (tipo === "dyslexic") document.body.classList.add("a11y-dyslexic-font");
    else if (tipo === "serif") document.body.classList.add("a11y-font-serif");
    else if (tipo === "sans") document.body.classList.add("a11y-font-sans");
  }

  function aplicarOcultarImagens(ativo) {
    document.body.classList.toggle("a11y-hide-images", ativo);
  }

  function aplicarCorFonte(cor) {
    if (cor) {
      document.documentElement.style.setProperty("--a11y-custom-font-color", cor);
      document.body.classList.add("a11y-font-color-on");
    } else {
      document.body.classList.remove("a11y-font-color-on");
      document.documentElement.style.removeProperty("--a11y-custom-font-color");
    }
  }

  function aplicarCorTexto(cor) {
    if (cor) {
      document.documentElement.style.setProperty("--a11y-custom-text-color", cor);
    } else {
      document.documentElement.style.removeProperty("--a11y-custom-text-color");
    }
  }

  function aplicarLarguraParagrafo(indice) {
    const valor = LARGURA_PARAGRAFO_PASSOS[indice] || "none";
    document.documentElement.style.setProperty("--a11y-paragraph-width", valor);
  }

  function aplicarAlinhamento(alinhamento) {
    document.body.classList.remove("a11y-align-left", "a11y-align-center", "a11y-align-right", "a11y-align-justify");
    if (alinhamento && alinhamento !== "default") {
      document.body.classList.add(`a11y-align-${alinhamento}`);
    }
  }

  let escalaFonte = lerNumero(CHAVE_FONTE, FONTE_PADRAO);
  let espacamento = lerNumero(CHAVE_ESPACAMENTO, ESPACAMENTO_PADRAO);
  let altura = lerNumero(CHAVE_ALTURA, ALTURA_PADRAO);
  let linksAtivo = lerBooleano(CHAVE_LINKS);
  let contrasteAtivo = lerBooleano(CHAVE_CONTRASTE);
  let tipoFonte = lerTexto(CHAVE_FONT_TYPE, "default");
  let imagensOcultas = lerBooleano(CHAVE_IMAGEM_OCULTA);
  let corFonte = lerTexto(CHAVE_FONT_COLOR, "");
  let corTexto = lerTexto(CHAVE_TEXT_COLOR, "");
  let larguraParagrafo = lerInteiro(CHAVE_PARAGRAFO, LARGURA_PARAGRAFO_PADRAO);
  let alinhamento = lerTexto(CHAVE_ALINHAMENTO, "left");

  aplicarFonte(escalaFonte);
  aplicarEspacamento(espacamento);
  aplicarAltura(altura);
  aplicarTipoFonte(tipoFonte);
  aplicarDestaqueLinks(linksAtivo);
  aplicarContraste(contrasteAtivo);
  aplicarOcultarImagens(imagensOcultas);
  aplicarCorFonte(corFonte);
  aplicarCorTexto(corTexto);
  aplicarLarguraParagrafo(larguraParagrafo);
  aplicarAlinhamento(alinhamento);

  document.addEventListener("DOMContentLoaded", () => {
    const toggleBtn = document.getElementById("a11yToggleBtn");
    const panel = document.getElementById("a11yPanel");
    const closeBtn = document.getElementById("a11yCloseBtn");
    if (!toggleBtn || !panel) return;

    const fontSlider = document.getElementById("a11yFontSlider");
    const fontValue = document.getElementById("a11yFontValue");
    const fontDecreaseBtn = document.getElementById("a11yFontDecreaseBtn");
    const fontIncreaseBtn = document.getElementById("a11yFontIncreaseBtn");
    const fontResetBtn = document.getElementById("a11yFontResetBtn");

    const spacingSlider = document.getElementById("a11ySpacingSlider");
    const spacingValue = document.getElementById("a11ySpacingValue");
    const spacingDecreaseBtn = document.getElementById("a11ySpacingDecreaseBtn");
    const spacingIncreaseBtn = document.getElementById("a11ySpacingIncreaseBtn");
    const spacingResetBtn = document.getElementById("a11ySpacingResetBtn");

    const lineSlider = document.getElementById("a11yLineSlider");
    const lineValue = document.getElementById("a11yLineValue");
    const lineDecreaseBtn = document.getElementById("a11yLineDecreaseBtn");
    const lineIncreaseBtn = document.getElementById("a11yLineIncreaseBtn");
    const lineResetBtn = document.getElementById("a11yLineResetBtn");

    const imageHideBtn = document.getElementById("a11yImageHideToggleBtn");

    const paragraphSlider = document.getElementById("a11yParagraphSlider");
    const paragraphValue = document.getElementById("a11yParagraphValue");
    const paragraphDecreaseBtn = document.getElementById("a11yParagraphDecreaseBtn");
    const paragraphIncreaseBtn = document.getElementById("a11yParagraphIncreaseBtn");
    const paragraphResetBtn = document.getElementById("a11yParagraphResetBtn");

    const linkHighlightBtn = document.getElementById("a11yLinkHighlightToggleBtn");
    const contrastBtn = document.getElementById("a11yContrastToggleBtn");
    const resetAllBtn = document.getElementById("a11yResetAllBtn");

    const fontTypeBtns = Array.from(document.querySelectorAll("#a11yPanel .a11y-font-type-row [data-font-type]"));

    const fontColorInput = document.getElementById("a11yFontColorInput");
    const fontColorResetBtn = document.getElementById("a11yFontColorResetBtn");
    const textColorInput = document.getElementById("a11yTextColorInput");
    const textColorResetBtn = document.getElementById("a11yTextColorResetBtn");

    const alignBtns = Array.from(document.querySelectorAll("#a11yPanel .a11y-align-row [data-align]"));

    function atualizarBotaoToggle(btn, ativo) {
      btn.setAttribute("aria-pressed", String(ativo));
      btn.textContent = ativo ? "Desativar" : "Ativar";
      btn.classList.toggle("is-active", ativo);
    }

    function atualizarGrupoExclusivo(botoes, valorAtivo, dataAttr) {
      botoes.forEach((btn) => {
        btn.classList.toggle("is-active", btn.dataset[dataAttr] === valorAtivo);
      });
    }

    function atualizarPreenchimentoSlider(input) {
      if (!input) return;
      const min = parseFloat(input.min) || 0;
      const max = parseFloat(input.max) || 100;
      const valor = parseFloat(input.value);
      const percentual = max > min ? ((valor - min) / (max - min)) * 100 : 0;
      input.style.setProperty("--a11y-slider-fill", `${percentual}%`);
    }

    function atualizarBotaoOcultarImagens() {
      if (!imageHideBtn) return;
      imageHideBtn.setAttribute("aria-pressed", String(imagensOcultas));
      imageHideBtn.textContent = imagensOcultas ? "Mostrar Imagens" : "Ocultar Imagens";
      imageHideBtn.classList.toggle("is-active", imagensOcultas);
    }

    function atualizarFontUI() {
      if (fontSlider) {
        fontSlider.value = escalaFonte;
        atualizarPreenchimentoSlider(fontSlider);
      }
      if (fontValue) fontValue.textContent = `${Math.round(escalaFonte * 100)}%`;
    }

    function atualizarSpacingUI() {
      if (spacingSlider) {
        spacingSlider.value = espacamento;
        atualizarPreenchimentoSlider(spacingSlider);
      }
      if (spacingValue) spacingValue.textContent = espacamento.toFixed(2).replace(/\.?0+$/, "") || "0";
    }

    function atualizarLineUI() {
      if (lineSlider) {
        lineSlider.value = altura;
        atualizarPreenchimentoSlider(lineSlider);
      }
      if (lineValue) lineValue.textContent = altura.toFixed(1);
    }

    function atualizarParagraphUI() {
      if (paragraphSlider) {
        paragraphSlider.value = larguraParagrafo;
        atualizarPreenchimentoSlider(paragraphSlider);
      }
      if (paragraphValue) paragraphValue.textContent = LARGURA_PARAGRAFO_ROTULOS[larguraParagrafo] || "Padrão";
    }

    atualizarBotaoToggle(linkHighlightBtn, linksAtivo);
    atualizarBotaoToggle(contrastBtn, contrasteAtivo);
    atualizarBotaoOcultarImagens();
    atualizarGrupoExclusivo(fontTypeBtns, tipoFonte, "fontType");
    atualizarGrupoExclusivo(alignBtns, alinhamento, "align");
    atualizarFontUI();
    atualizarSpacingUI();
    atualizarLineUI();
    atualizarParagraphUI();

    if (fontColorInput) fontColorInput.value = corFonte || COR_PADRAO;
    if (textColorInput) textColorInput.value = corTexto || COR_PADRAO;

    function abrirPainel() {
      panel.classList.remove("hidden");
      toggleBtn.setAttribute("aria-expanded", "true");
      const helpFabPanel = document.getElementById("helpFabPanel");
      if (helpFabPanel) helpFabPanel.classList.add("hidden");
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

    function definirFonte(valor) {
      escalaFonte = Math.min(FONTE_MAX, Math.max(FONTE_MIN, +valor.toFixed(3)));
      aplicarFonte(escalaFonte);
      salvar(CHAVE_FONTE, escalaFonte);
      atualizarFontUI();
    }
    if (fontSlider) {
      fontSlider.addEventListener("input", () => definirFonte(parseFloat(fontSlider.value)));
    }
    if (fontDecreaseBtn) fontDecreaseBtn.addEventListener("click", () => definirFonte(escalaFonte - FONTE_PASSO));
    if (fontIncreaseBtn) fontIncreaseBtn.addEventListener("click", () => definirFonte(escalaFonte + FONTE_PASSO));
    if (fontResetBtn) fontResetBtn.addEventListener("click", () => definirFonte(FONTE_PADRAO));

    function definirEspacamento(valor) {
      espacamento = Math.min(ESPACAMENTO_MAX, Math.max(ESPACAMENTO_MIN, +valor.toFixed(3)));
      aplicarEspacamento(espacamento);
      salvar(CHAVE_ESPACAMENTO, espacamento);
      atualizarSpacingUI();
    }
    if (spacingSlider) {
      spacingSlider.addEventListener("input", () => definirEspacamento(parseFloat(spacingSlider.value)));
    }
    if (spacingDecreaseBtn) spacingDecreaseBtn.addEventListener("click", () => definirEspacamento(espacamento - ESPACAMENTO_PASSO));
    if (spacingIncreaseBtn) spacingIncreaseBtn.addEventListener("click", () => definirEspacamento(espacamento + ESPACAMENTO_PASSO));
    if (spacingResetBtn) spacingResetBtn.addEventListener("click", () => definirEspacamento(ESPACAMENTO_PADRAO));

    function definirAltura(valor) {
      altura = Math.min(ALTURA_MAX, Math.max(ALTURA_MIN, +valor.toFixed(2)));
      aplicarAltura(altura);
      salvar(CHAVE_ALTURA, altura);
      atualizarLineUI();
    }
    if (lineSlider) {
      lineSlider.addEventListener("input", () => definirAltura(parseFloat(lineSlider.value)));
    }
    if (lineDecreaseBtn) lineDecreaseBtn.addEventListener("click", () => definirAltura(altura - ALTURA_PASSO));
    if (lineIncreaseBtn) lineIncreaseBtn.addEventListener("click", () => definirAltura(altura + ALTURA_PASSO));
    if (lineResetBtn) lineResetBtn.addEventListener("click", () => definirAltura(ALTURA_PADRAO));

    if (imageHideBtn) {
      imageHideBtn.addEventListener("click", () => {
        imagensOcultas = !imagensOcultas;
        aplicarOcultarImagens(imagensOcultas);
        salvar(CHAVE_IMAGEM_OCULTA, imagensOcultas ? 1 : 0);
        atualizarBotaoOcultarImagens();
      });
    }

    function definirLarguraParagrafo(indice) {
      larguraParagrafo = Math.min(LARGURA_PARAGRAFO_PASSOS.length - 1, Math.max(0, Math.round(indice)));
      aplicarLarguraParagrafo(larguraParagrafo);
      salvar(CHAVE_PARAGRAFO, larguraParagrafo);
      atualizarParagraphUI();
    }
    if (paragraphSlider) {
      paragraphSlider.addEventListener("input", () => definirLarguraParagrafo(parseInt(paragraphSlider.value, 10)));
    }
    if (paragraphDecreaseBtn) paragraphDecreaseBtn.addEventListener("click", () => definirLarguraParagrafo(larguraParagrafo - 1));
    if (paragraphIncreaseBtn) paragraphIncreaseBtn.addEventListener("click", () => definirLarguraParagrafo(larguraParagrafo + 1));
    if (paragraphResetBtn) paragraphResetBtn.addEventListener("click", () => definirLarguraParagrafo(LARGURA_PARAGRAFO_PADRAO));

    fontTypeBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        tipoFonte = btn.dataset.fontType;
        aplicarTipoFonte(tipoFonte);
        salvar(CHAVE_FONT_TYPE, tipoFonte);
        salvar(CHAVE_DISLEXIA, tipoFonte === "dyslexic" ? 1 : 0);
        atualizarGrupoExclusivo(fontTypeBtns, tipoFonte, "fontType");
      });
    });

    if (fontColorInput) {
      fontColorInput.addEventListener("input", () => {
        corFonte = fontColorInput.value;
        aplicarCorFonte(corFonte);
        salvar(CHAVE_FONT_COLOR, corFonte);
      });
    }
    if (fontColorResetBtn) {
      fontColorResetBtn.addEventListener("click", () => {
        corFonte = "";
        aplicarCorFonte(corFonte);
        salvar(CHAVE_FONT_COLOR, "");
        if (fontColorInput) fontColorInput.value = COR_PADRAO;
      });
    }

    if (textColorInput) {
      textColorInput.addEventListener("input", () => {
        corTexto = textColorInput.value;
        aplicarCorTexto(corTexto);
        salvar(CHAVE_TEXT_COLOR, corTexto);
      });
    }
    if (textColorResetBtn) {
      textColorResetBtn.addEventListener("click", () => {
        corTexto = "";
        aplicarCorTexto(corTexto);
        salvar(CHAVE_TEXT_COLOR, "");
        if (textColorInput) textColorInput.value = COR_PADRAO;
      });
    }

    alignBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        alinhamento = btn.dataset.align;
        aplicarAlinhamento(alinhamento);
        salvar(CHAVE_ALINHAMENTO, alinhamento);
        atualizarGrupoExclusivo(alignBtns, alinhamento, "align");
      });
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
      escalaFonte = FONTE_PADRAO;
      espacamento = ESPACAMENTO_PADRAO;
      altura = ALTURA_PADRAO;
      linksAtivo = false;
      contrasteAtivo = false;
      tipoFonte = "default";
      imagensOcultas = false;
      corFonte = "";
      corTexto = "";
      larguraParagrafo = LARGURA_PARAGRAFO_PADRAO;
      alinhamento = "left";

      aplicarFonte(escalaFonte);
      aplicarEspacamento(espacamento);
      aplicarAltura(altura);
      aplicarTipoFonte(tipoFonte);
      aplicarDestaqueLinks(linksAtivo);
      aplicarContraste(contrasteAtivo);
      aplicarOcultarImagens(imagensOcultas);
      aplicarCorFonte(corFonte);
      aplicarCorTexto(corTexto);
      aplicarLarguraParagrafo(larguraParagrafo);
      aplicarAlinhamento(alinhamento);

      salvar(CHAVE_FONTE, escalaFonte);
      salvar(CHAVE_ESPACAMENTO, espacamento);
      salvar(CHAVE_ALTURA, altura);
      salvar(CHAVE_DISLEXIA, 0);
      salvar(CHAVE_LINKS, 0);
      salvar(CHAVE_CONTRASTE, 0);
      salvar(CHAVE_FONT_TYPE, tipoFonte);
      salvar(CHAVE_IMAGEM_OCULTA, 0);
      salvar(CHAVE_FONT_COLOR, "");
      salvar(CHAVE_TEXT_COLOR, "");
      salvar(CHAVE_PARAGRAFO, larguraParagrafo);
      salvar(CHAVE_ALINHAMENTO, alinhamento);

      atualizarBotaoToggle(linkHighlightBtn, false);
      atualizarBotaoToggle(contrastBtn, false);
      atualizarBotaoOcultarImagens();
      atualizarGrupoExclusivo(fontTypeBtns, tipoFonte, "fontType");
      atualizarGrupoExclusivo(alignBtns, alinhamento, "align");
      atualizarFontUI();
      atualizarSpacingUI();
      atualizarLineUI();
      atualizarParagraphUI();
      if (fontColorInput) fontColorInput.value = COR_PADRAO;
      if (textColorInput) textColorInput.value = COR_PADRAO;
    });

    const helpFabToggle = document.getElementById("helpFabToggleBtn");
    const helpFabPanel = document.getElementById("helpFabPanel");
    const helpFabClose = document.getElementById("helpFabCloseBtn");
    if (helpFabToggle && helpFabPanel) {
      helpFabToggle.addEventListener("click", (e) => {
        e.stopPropagation();
        const abrindo = helpFabPanel.classList.contains("hidden");
        if (abrindo) fecharPainel();
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

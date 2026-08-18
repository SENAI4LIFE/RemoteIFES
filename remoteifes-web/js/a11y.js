(function () {
  const CHAVE_FONTE = "remoteifes_font_scale";
  const CHAVE_ESPACAMENTO = "remoteifes_letter_spacing";
  const CHAVE_ALTURA = "remoteifes_line_height";
  const CHAVE_DISLEXIA = "remoteifes_dyslexic_font";
  const CHAVE_LINKS = "remoteifes_link_highlight";
  const CHAVE_CONTRASTE = "remoteifes_high_contrast";
  const CHAVE_FONT_TYPE = "remoteifes_font_type";
  const CHAVE_KERNING = "remoteifes_kerning_off";
  const CHAVE_IMAGEM_OPACIDADE = "remoteifes_image_opacity";
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

  const IMAGEM_OPACIDADE_MIN = 0;
  const IMAGEM_OPACIDADE_MAX = 100;
  const IMAGEM_OPACIDADE_PASSO = 10;
  const IMAGEM_OPACIDADE_PADRAO = 100;

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

  function aplicarKerning(desligado) {
    document.body.classList.toggle("a11y-kerning-off", desligado);
  }

  function aplicarOpacidadeImagem(valor) {
    document.documentElement.style.setProperty("--a11y-image-opacity", valor / 100);
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
  let kerningDesligado = lerBooleano(CHAVE_KERNING);
  let opacidadeImagem = lerInteiro(CHAVE_IMAGEM_OPACIDADE, IMAGEM_OPACIDADE_PADRAO);
  let corFonte = lerTexto(CHAVE_FONT_COLOR, "");
  let corTexto = lerTexto(CHAVE_TEXT_COLOR, "");
  let larguraParagrafo = lerInteiro(CHAVE_PARAGRAFO, LARGURA_PARAGRAFO_PADRAO);
  let alinhamento = lerTexto(CHAVE_ALINHAMENTO, "default");

  aplicarFonte(escalaFonte);
  aplicarEspacamento(espacamento);
  aplicarAltura(altura);
  aplicarTipoFonte(tipoFonte);
  aplicarDestaqueLinks(linksAtivo);
  aplicarContraste(contrasteAtivo);
  aplicarKerning(kerningDesligado);
  aplicarOpacidadeImagem(opacidadeImagem);
  aplicarCorFonte(corFonte);
  aplicarCorTexto(corTexto);
  aplicarLarguraParagrafo(larguraParagrafo);
  aplicarAlinhamento(alinhamento);

  document.addEventListener("DOMContentLoaded", () => {
    const toggleBtn = document.getElementById("a11yToggleBtn");
    const panel = document.getElementById("a11yPanel");
    const closeBtn = document.getElementById("a11yCloseBtn");
    if (!toggleBtn || !panel) return;

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

    const imageOpacitySlider = document.getElementById("a11yImageOpacitySlider");
    const imageOpacityValue = document.getElementById("a11yImageOpacityValue");
    const imageOpacityDecreaseBtn = document.getElementById("a11yImageOpacityDecreaseBtn");
    const imageOpacityIncreaseBtn = document.getElementById("a11yImageOpacityIncreaseBtn");
    const imageOpacityResetBtn = document.getElementById("a11yImageOpacityResetBtn");

    const paragraphSlider = document.getElementById("a11yParagraphSlider");
    const paragraphValue = document.getElementById("a11yParagraphValue");
    const paragraphDecreaseBtn = document.getElementById("a11yParagraphDecreaseBtn");
    const paragraphIncreaseBtn = document.getElementById("a11yParagraphIncreaseBtn");
    const paragraphResetBtn = document.getElementById("a11yParagraphResetBtn");

    const linkHighlightBtn = document.getElementById("a11yLinkHighlightToggleBtn");
    const contrastBtn = document.getElementById("a11yContrastToggleBtn");
    const resetAllBtn = document.getElementById("a11yResetAllBtn");

    const fontTypeBtns = Array.from(document.querySelectorAll("#a11yPanel .a11y-font-type-row [data-font-type]"));
    const kerningBtn = document.getElementById("a11yKerningToggleBtn");

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

    function atualizarSpacingUI() {
      if (spacingSlider) spacingSlider.value = espacamento;
      if (spacingValue) spacingValue.textContent = espacamento.toFixed(2).replace(/\.?0+$/, "") || "0";
    }

    function atualizarLineUI() {
      if (lineSlider) lineSlider.value = altura;
      if (lineValue) lineValue.textContent = altura.toFixed(1);
    }

    function atualizarImageOpacityUI() {
      if (imageOpacitySlider) imageOpacitySlider.value = opacidadeImagem;
      if (imageOpacityValue) imageOpacityValue.textContent = String(opacidadeImagem);
    }

    function atualizarParagraphUI() {
      if (paragraphSlider) paragraphSlider.value = larguraParagrafo;
      if (paragraphValue) paragraphValue.textContent = LARGURA_PARAGRAFO_ROTULOS[larguraParagrafo] || "Padrão";
    }

    atualizarBotaoToggle(linkHighlightBtn, linksAtivo);
    atualizarBotaoToggle(contrastBtn, contrasteAtivo);
    atualizarGrupoExclusivo(fontTypeBtns, tipoFonte, "fontType");
    atualizarGrupoExclusivo(alignBtns, alinhamento, "align");
    atualizarSpacingUI();
    atualizarLineUI();
    atualizarImageOpacityUI();
    atualizarParagraphUI();

    if (kerningBtn) {
      kerningBtn.setAttribute("aria-pressed", String(kerningDesligado));
      kerningBtn.textContent = kerningDesligado ? "Ligar" : "Desligar";
      kerningBtn.classList.toggle("is-active", kerningDesligado);
    }
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
      escalaFonte = FONTE_PADRAO;
      aplicarFonte(escalaFonte);
      salvar(CHAVE_FONTE, escalaFonte);
    });

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

    function definirOpacidadeImagem(valor) {
      opacidadeImagem = Math.min(IMAGEM_OPACIDADE_MAX, Math.max(IMAGEM_OPACIDADE_MIN, Math.round(valor)));
      aplicarOpacidadeImagem(opacidadeImagem);
      salvar(CHAVE_IMAGEM_OPACIDADE, opacidadeImagem);
      atualizarImageOpacityUI();
    }
    if (imageOpacitySlider) {
      imageOpacitySlider.addEventListener("input", () => definirOpacidadeImagem(parseFloat(imageOpacitySlider.value)));
    }
    if (imageOpacityDecreaseBtn) imageOpacityDecreaseBtn.addEventListener("click", () => definirOpacidadeImagem(opacidadeImagem - IMAGEM_OPACIDADE_PASSO));
    if (imageOpacityIncreaseBtn) imageOpacityIncreaseBtn.addEventListener("click", () => definirOpacidadeImagem(opacidadeImagem + IMAGEM_OPACIDADE_PASSO));
    if (imageOpacityResetBtn) imageOpacityResetBtn.addEventListener("click", () => definirOpacidadeImagem(IMAGEM_OPACIDADE_PADRAO));

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

    if (kerningBtn) {
      kerningBtn.addEventListener("click", () => {
        kerningDesligado = !kerningDesligado;
        aplicarKerning(kerningDesligado);
        salvar(CHAVE_KERNING, kerningDesligado ? 1 : 0);
        kerningBtn.setAttribute("aria-pressed", String(kerningDesligado));
        kerningBtn.textContent = kerningDesligado ? "Ligar" : "Desligar";
        kerningBtn.classList.toggle("is-active", kerningDesligado);
      });
    }

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
      kerningDesligado = false;
      opacidadeImagem = IMAGEM_OPACIDADE_PADRAO;
      corFonte = "";
      corTexto = "";
      larguraParagrafo = LARGURA_PARAGRAFO_PADRAO;
      alinhamento = "default";

      aplicarFonte(escalaFonte);
      aplicarEspacamento(espacamento);
      aplicarAltura(altura);
      aplicarTipoFonte(tipoFonte);
      aplicarDestaqueLinks(linksAtivo);
      aplicarContraste(contrasteAtivo);
      aplicarKerning(kerningDesligado);
      aplicarOpacidadeImagem(opacidadeImagem);
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
      salvar(CHAVE_KERNING, 0);
      salvar(CHAVE_IMAGEM_OPACIDADE, opacidadeImagem);
      salvar(CHAVE_FONT_COLOR, "");
      salvar(CHAVE_TEXT_COLOR, "");
      salvar(CHAVE_PARAGRAFO, larguraParagrafo);
      salvar(CHAVE_ALINHAMENTO, alinhamento);

      atualizarBotaoToggle(linkHighlightBtn, false);
      atualizarBotaoToggle(contrastBtn, false);
      atualizarGrupoExclusivo(fontTypeBtns, tipoFonte, "fontType");
      atualizarGrupoExclusivo(alignBtns, alinhamento, "align");
      atualizarSpacingUI();
      atualizarLineUI();
      atualizarImageOpacityUI();
      atualizarParagraphUI();
      if (kerningBtn) {
        kerningBtn.setAttribute("aria-pressed", "false");
        kerningBtn.textContent = "Desligar";
        kerningBtn.classList.remove("is-active");
      }
      if (fontColorInput) fontColorInput.value = COR_PADRAO;
      if (textColorInput) textColorInput.value = COR_PADRAO;
    });

    // Widget de ajuda geral (bolha "?" fixa no canto inferior direito).
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

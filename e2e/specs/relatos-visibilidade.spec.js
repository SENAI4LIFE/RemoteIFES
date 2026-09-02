const { test, expect, API_URL, tokenDe, VIEWPORTS } = require("../harness/fixtures");

// Regressão do relato ilegível: a cor do texto precisa contrastar com a superfície em que ele
// é realmente desenhado, em qualquer combinação de acessibilidade. Existir no DOM não basta.
function contrastes() {
  const canal = (valor) => {
    const c = valor / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const componentes = (cor) => (String(cor).match(/-?[\d.]+/g) || []).slice(0, 3).map(Number);
  const luminancia = ([r, g, b]) => 0.2126 * canal(r) + 0.7152 * canal(g) + 0.0722 * canal(b);
  const fundoPintado = (el) => {
    let no = el;
    while (no && no !== document.documentElement) {
      const cor = getComputedStyle(no).backgroundColor;
      const alfa = (String(cor).match(/-?[\d.]+/g) || [])[3];
      const rgb = componentes(cor);
      if (rgb.length === 3 && (alfa === undefined || Number(alfa) > 0.5)) return rgb;
      no = no.parentElement;
    }
    return [255, 255, 255];
  };
  const alvos = {
    "erro do formulário": ".app-dialog-error",
    "título do relato": "#relatosPanel .relato-item-title > span:first-child",
    "descrição enviada": "#relatosPanel .relato-item-descricao",
    "resposta da equipe": "#relatosPanel .relato-item-resposta-texto",
  };
  const saida = {};
  for (const [nome, seletor] of Object.entries(alvos)) {
    const el = document.querySelector(seletor);
    if (!el) { saida[nome] = null; continue; }
    const estilo = getComputedStyle(el);
    const frente = luminancia(componentes(estilo.color));
    const fundo = luminancia(fundoPintado(el));
    saida[nome] = {
      razao: (Math.max(frente, fundo) + 0.05) / (Math.min(frente, fundo) + 0.05),
      opacidade: Number(estilo.opacity),
      texto: (el.textContent || "").trim(),
    };
  }
  return saida;
}

const ESTADOS = {
  "ajuste padrão": {},
  "cor de texto clara": { remoteifes_text_color: "#f2f2f2" },
  "alto contraste": { remoteifes_high_contrast: "1" },
  "alto contraste com cor de texto escura": { remoteifes_high_contrast: "1", remoteifes_text_color: "#1f2b23" },
};

for (const [rotulo, ajustes] of Object.entries(ESTADOS)) {
  for (const viewport of ["mobile-portrait", "desktop"]) {
    test(`relato enviado, resposta e erro continuam legíveis com ${rotulo} em ${viewport}`, async ({ page, context, sessaoComo, request }) => {
      await page.setViewportSize(VIEWPORTS[viewport]);

      const criado = await request.post(`${API_URL}/relatos`, {
        headers: { Authorization: `Bearer ${tokenDe("user")}` },
        data: {
          titulo: `Visibilidade ${rotulo} ${viewport} ${Date.now()}`,
          descricao: "Descrição enviada pelo usuário para conferir a legibilidade do corpo do relato.",
          categoria: "interface",
        },
      });
      expect(criado.ok()).toBeTruthy();
      const { relato } = await criado.json();
      const respondido = await request.patch(`${API_URL}/superadmin/relatos/${relato.id}`, {
        headers: { Authorization: `Bearer ${tokenDe("superadmin")}` },
        data: { resposta: "Resposta da equipe que o autor precisa conseguir ler." },
      });
      expect(respondido.ok()).toBeTruthy();

      await context.addInitScript((chaves) => {
        for (const [chave, valor] of Object.entries(chaves)) localStorage.setItem(chave, valor);
      }, ajustes);
      await sessaoComo("user");

      await page.locator("#bugReportBtn").click();
      await expect(page.locator("#relatosPanel")).toBeVisible();
      await page.locator("#relatosPanel .relato-lista li").first().click();
      await expect(page.locator("#relatosPanel .relato-item-resposta").first()).toBeVisible();

      await page.locator(".relatos-novo-btn").click();
      await expect(page.locator(".app-dialog-card")).toBeVisible();
      await page.locator("#relatoTitulo").fill("no");
      await page.locator("#relatoDescricao").fill("curta");
      await page.locator(".app-dialog-actions .btn-on").click();
      await expect(page.locator(".app-dialog-error")).toBeVisible();

      const medidos = await page.evaluate(contrastes);
      for (const [nome, medida] of Object.entries(medidos)) {
        expect(medida, `${nome} não foi encontrado na tela`).not.toBeNull();
        expect(medida.texto.length, `${nome} está sem conteúdo`).toBeGreaterThan(0);
        expect(medida.opacidade, `${nome} está transparente`).toBeGreaterThan(0.5);
        expect(medida.razao, `${nome} ficou ilegível (contraste ${medida.razao.toFixed(2)}:1)`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
}

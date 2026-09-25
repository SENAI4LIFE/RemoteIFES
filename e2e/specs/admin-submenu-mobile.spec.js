const { test, expect, injetarSessao, semRolagemHorizontal } = require("../harness/fixtures");

// The Administration submenu selectors (Usuários, Cadastro, Logs...) must be readable on phones:
// labels in the 13-14 px range at default text, scaled with the accessibility font setting. Only the
// selector labels change: group headings, inner tabs and icons keep their size, tap targets and the
// active state are preserved, the selector row scrolls inside itself and the page never scrolls
// horizontally.

const LARGURAS_CELULAR = [
  ["320", { width: 320, height: 640 }],
  ["360", { width: 360, height: 800 }],
  ["390", { width: 390, height: 844 }],
  ["393", { width: 393, height: 852 }],
  ["430", { width: 430, height: 932 }],
];

const TEXTO_MAXIMO = {
  remoteifes_font_scale: "2",
  remoteifes_line_height: "3",
  remoteifes_letter_spacing: "0.25",
};

async function abrirAdmin(page, context, tamanho, ajustes = {}) {
  await injetarSessao(context, "superadmin");
  await context.addInitScript((chaves) => {
    try {
      Object.entries(chaves).forEach(([k, v]) => window.localStorage.setItem(k, v));
    } catch (e) {}
  }, ajustes);
  await page.setViewportSize(tamanho);
  await page.goto("/#/admin/usuarios");
  await expect(page.locator("#screen-admin")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.admin-subtab-btn[data-sub="config"]')).toBeVisible({ timeout: 15_000 });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

function medirSeletores(page) {
  return page.evaluate(() => {
    const px = (el) => parseFloat(getComputedStyle(el).fontSize);
    const barra = document.querySelector(".admin-subtabs");
    const botoes = Array.from(barra.querySelectorAll(".admin-subtab-btn")).filter((b) => b.offsetParent !== null);
    const itens = botoes.map((btn) => {
      const rotulo = btn.querySelector(".admin-subtab-label");
      const icone = btn.querySelector(".admin-subtab-icon");
      const r = btn.getBoundingClientRect();
      return {
        sub: btn.dataset.sub,
        rotuloPx: px(rotulo),
        iconeLargura: icone.getBoundingClientRect().width,
        altura: r.height,
        esquerda: r.left,
        direita: r.right,
        rotuloCortado: rotulo.scrollWidth > rotulo.clientWidth + 1 || rotulo.scrollHeight > rotulo.clientHeight + 1,
        rotuloForaDoBotao: (() => {
          const q = rotulo.getBoundingClientRect();
          return q.left < r.left - 1 || q.right > r.right + 1 || q.top < r.top - 1 || q.bottom > r.bottom + 1;
        })(),
        fundo: getComputedStyle(btn).backgroundColor,
        ativo: btn.classList.contains("active"),
      };
    });
    const grupos = Array.from(barra.querySelectorAll(".admin-group-btn")).filter((b) => b.offsetParent !== null);
    const abasInternas = Array.from(document.querySelectorAll("#adminSub-usuarios .admin-inner-tab-btn")).filter((b) => b.offsetParent !== null);
    return {
      itens,
      grupoPx: grupos.map(px),
      abaInternaPx: abasInternas.map(px),
      escala: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--a11y-font-scale")) || 1,
    };
  });
}

function sobreposicoes(itens) {
  const achados = [];
  for (let i = 1; i < itens.length; i++) {
    if (itens[i].esquerda < itens[i - 1].direita - 1) achados.push(`${itens[i - 1].sub}/${itens[i].sub}`);
  }
  return achados;
}

async function ultimoAlcancavel(page) {
  return page.evaluate(async () => {
    const barra = document.querySelector(".admin-subtabs");
    const botoes = Array.from(barra.querySelectorAll(".admin-subtab-btn")).filter((b) => b.offsetParent !== null);
    const ultimo = botoes[botoes.length - 1];
    barra.scrollLeft = barra.scrollWidth;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const a = barra.getBoundingClientRect();
    const u = ultimo.getBoundingClientRect();
    return u.left >= a.left - 1 && u.right <= a.right + 1 && u.right <= window.innerWidth + 1;
  });
}

for (const [nome, tamanho] of LARGURAS_CELULAR) {
  test(`Administration submenu labels are readable at ${nome}px without clipping, overlap or page overflow`, async ({ page, context }) => {
    await abrirAdmin(page, context, tamanho);
    const m = await medirSeletores(page);

    expect(m.itens.length, "every superadmin selector is visible").toBe(9);
    for (const item of m.itens) {
      expect(item.rotuloPx, `${item.sub} label size`).toBeGreaterThanOrEqual(13);
      expect(item.rotuloPx, `${item.sub} label size`).toBeLessThanOrEqual(14.5);
      expect(item.altura, `${item.sub} tap target`).toBeGreaterThanOrEqual(44);
      expect(item.rotuloCortado, `${item.sub} label clipped`).toBe(false);
      expect(item.rotuloForaDoBotao, `${item.sub} label outside its button`).toBe(false);
    }
    expect(sobreposicoes(m.itens), "selectors overlapping").toEqual([]);

    // Only the selector labels grew: group headings, inner tabs and icons keep their sizes.
    m.grupoPx.forEach((v) => expect(v).toBeCloseTo(9.5, 1));
    m.abaInternaPx.forEach((v) => expect(v).toBeCloseTo(12.5, 1));
    m.itens.forEach((item) => expect(item.iconeLargura, `${item.sub} icon`).toBeLessThan(24));

    const ativo = m.itens.find((i) => i.ativo);
    const inativo = m.itens.find((i) => !i.ativo);
    expect(ativo.sub).toBe("usuarios");
    expect(ativo.fundo, "active selector is visually distinct").not.toBe(inativo.fundo);

    expect(await semRolagemHorizontal(page), "no page-wide horizontal scroll").toBe(true);
    expect(await ultimoAlcancavel(page), "the last selector is reachable by scrolling the row").toBe(true);
    expect(await semRolagemHorizontal(page), "scrolling the row does not scroll the page").toBe(true);
  });
}

test("Administration submenu selectors keep keyboard focus and selection at 360px", async ({ page, context }) => {
  await abrirAdmin(page, context, { width: 360, height: 800 });
  const alvo = page.locator('.admin-subtab-btn[data-sub="logs"]');
  await alvo.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(alvo).toBeFocused();
  const contorno = await alvo.evaluate((el) => ({ visivel: el.matches(":focus-visible"), estilo: getComputedStyle(el).outlineStyle }));
  expect(contorno.visivel).toBe(true);
  expect(contorno.estilo).not.toBe("none");

  await page.keyboard.press("Enter");
  await expect(page.locator("#adminSub-logs")).toBeVisible({ timeout: 15_000 });
  await expect(alvo).toHaveClass(/active/);
  expect(await semRolagemHorizontal(page)).toBe(true);
});

for (const [nome, tamanho] of [["320", { width: 320, height: 640 }], ["390", { width: 390, height: 844 }]]) {
  test(`Administration submenu labels scale with maximum accessibility text at ${nome}px`, async ({ page, context }) => {
    test.setTimeout(90_000);
    await abrirAdmin(page, context, tamanho, TEXTO_MAXIMO);
    const m = await medirSeletores(page);
    expect(m.escala).toBe(2);
    for (const item of m.itens) {
      expect(item.rotuloPx, `${item.sub} label follows the accessibility scale`).toBeGreaterThanOrEqual(26);
      expect(item.altura, `${item.sub} tap target`).toBeGreaterThanOrEqual(44);
      expect(item.rotuloCortado, `${item.sub} label clipped`).toBe(false);
      expect(item.rotuloForaDoBotao, `${item.sub} label outside its button`).toBe(false);
    }
    expect(sobreposicoes(m.itens)).toEqual([]);
    expect(await semRolagemHorizontal(page), "no page-wide horizontal scroll").toBe(true);
    expect(await ultimoAlcancavel(page)).toBe(true);
    expect(await semRolagemHorizontal(page)).toBe(true);
  });
}

test("Administration submenu labels stay readable in high contrast on a phone", async ({ page, context }) => {
  await abrirAdmin(page, context, { width: 390, height: 844 }, { remoteifes_high_contrast: "1" });
  const m = await medirSeletores(page);
  const ativo = m.itens.find((i) => i.ativo);
  const inativo = m.itens.find((i) => !i.ativo);
  expect(ativo.fundo).not.toBe(inativo.fundo);
  m.itens.forEach((item) => expect(item.rotuloPx).toBeGreaterThanOrEqual(13));
  expect(await semRolagemHorizontal(page)).toBe(true);
});

test("the 1024x600 sidebar keeps its selector size and reaches the last item", async ({ page, context }) => {
  await abrirAdmin(page, context, { width: 1024, height: 600 });
  const m = await medirSeletores(page);
  m.itens.forEach((item) => {
    expect(item.rotuloPx, item.sub).toBeCloseTo(14, 1);
    expect(item.rotuloCortado, item.sub).toBe(false);
  });
  m.grupoPx.forEach((v) => expect(v).toBeCloseTo(11, 1));
  expect(await semRolagemHorizontal(page)).toBe(true);
  const ultimo = page.locator('.admin-subtab-btn[data-sub="config"]');
  await ultimo.scrollIntoViewIfNeeded();
  await expect(ultimo).toBeInViewport();
  await ultimo.click();
  await expect(page.locator("#adminSub-config")).toBeVisible({ timeout: 15_000 });
});

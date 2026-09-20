const { test, expect, VIEWPORTS, injetarSessao, semRolagemHorizontal } = require("../harness/fixtures");

// Ajustes de texto no máximo (2×, entrelinha 3, espaçamento 0,25em): o Início não ganha
// rolagem horizontal e o selo dos cartões fica dentro do cartão. A barra lateral da
// Administração termina acima da barra inferior em qualquer posição de rolagem, com o
// último item alcançável.

const MAXIMO_A11Y = {
  remoteifes_font_scale: "2",
  remoteifes_line_height: "3",
  remoteifes_letter_spacing: "0.25",
};

async function abrir(page, context, papel, rota, tamanho, ajustes, seletor) {
  await injetarSessao(context, papel);
  await context.addInitScript((chaves) => {
    try {
      Object.entries(chaves).forEach(([k, v]) => window.localStorage.setItem(k, v));
    } catch (e) {}
  }, ajustes);
  await page.setViewportSize(tamanho);
  await page.goto(rota);
  await expect(page.locator(seletor)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[aria-busy="true"]:visible')).toHaveCount(0, { timeout: 15_000 });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

for (const [nome, tamanho] of [["mobile-compact", VIEWPORTS["mobile-compact"]], ["mobile-portrait", VIEWPORTS["mobile-portrait"]], ["mobile-large", VIEWPORTS["mobile-large"]], ["mobile-landscape", VIEWPORTS["mobile-landscape"]]]) {
  for (const papel of ["user", "superadmin"]) {
    test(`Início com texto máximo não rola na horizontal e os selos ficam nos cartões (${papel}, ${nome})`, async ({ page, context }) => {
      await abrir(page, context, papel, "/#/inicio", tamanho, MAXIMO_A11Y, "#screen-inicio");
      await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--a11y-font-scale").trim())).toBe("2");
      await expect(page.locator(".hub-card-badge:not(.hidden)").first()).toBeVisible();

      expect(await semRolagemHorizontal(page), "documento sem rolagem horizontal").toBe(true);
      const medida = await page.evaluate(() => {
        const limite = document.documentElement.clientWidth;
        const selos = Array.from(document.querySelectorAll(".hub-card-badge:not(.hidden)")).map((selo) => {
          const cartao = selo.closest(".hub-card").getBoundingClientRect();
          const caixa = selo.getBoundingClientRect();
          const faixa = document.createRange();
          faixa.selectNodeContents(selo);
          const texto = faixa.getBoundingClientRect();
          return { texto: selo.textContent.trim(), textoAlemDaCaixa: Math.round(texto.right - caixa.right), caixaAlemDoCartao: Math.round(caixa.right - cartao.right), alemDaTela: Math.round(Math.max(texto.right, caixa.right) - limite) };
        });
        const heroi = document.querySelector(".hub-hero").getBoundingClientRect();
        const textoHeroi = document.querySelector(".hub-hero-texto").getBoundingClientRect();
        return { selos, heroiTextoAlem: Math.round(textoHeroi.right - heroi.right) };
      });
      for (const selo of medida.selos) {
        expect(selo.textoAlemDaCaixa, `texto do selo «${selo.texto}» dentro da própria caixa`).toBeLessThanOrEqual(1);
        expect(selo.caixaAlemDoCartao, `selo «${selo.texto}» dentro do cartão`).toBeLessThanOrEqual(0);
        expect(selo.alemDaTela, `selo «${selo.texto}» dentro da tela`).toBeLessThanOrEqual(0);
      }
      expect(medida.heroiTextoAlem, "o texto do herói não alarga o bloco além dele").toBeLessThanOrEqual(0);
    });
  }
}

test("com texto padrão o selo continua na mesma linha do título do cartão", async ({ page, context }) => {
  await abrir(page, context, "superadmin", "/#/inicio", VIEWPORTS["mobile-compact"], {}, "#screen-inicio");
  const selo = page.locator('[data-hub-card="salas"] .hub-card-badge');
  await expect(selo).toBeVisible();
  const medida = await selo.evaluate((el) => {
    const titulo = el.closest(".hub-card").querySelector(".hub-card-title").getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const cartao = el.closest(".hub-card").getBoundingClientRect();
    return { mesmaLinha: r.top < titulo.bottom && r.bottom > titulo.top, aDireita: r.left > titulo.right, dentro: r.right <= cartao.right };
  });
  expect(medida.mesmaLinha).toBe(true);
  expect(medida.aDireita).toBe(true);
  expect(medida.dentro).toBe(true);
});

function medirLateral() {
  const nav = document.querySelector(".admin-subtabs");
  const barra = document.querySelector(".tabbar").getBoundingClientRect();
  const estilo = getComputedStyle(nav);
  const caixa = nav.getBoundingClientRect();
  const ultimo = Array.from(nav.querySelectorAll(".admin-subtab-btn:not(.hidden)")).pop();
  nav.scrollTop = nav.scrollHeight;
  const ru = ultimo.getBoundingClientRect();
  const noFim = document.elementFromPoint(ru.left + ru.width / 2, ru.bottom - 4);
  nav.scrollTop = 0;
  return {
    sticky: estilo.position === "sticky",
    caixaBase: Math.round(caixa.bottom),
    topoDaBarra: Math.round(barra.top),
    alturaDaBarra: Math.round(barra.height),
    piso: parseFloat(estilo.maxHeight) <= 140,
    ultimoAlcancavel: ultimo.contains(noFim),
    ultimoSobABarra: Math.round(Math.max(0, ru.bottom - barra.top)),
  };
}

const CENARIOS_LATERAL = [
  ["desktop curto 1024x600", { width: 1024, height: 600 }, {}],
  ["notebook", VIEWPORTS.notebook, {}],
  ["tablet", VIEWPORTS["tablet-compact"], {}],
  ["620 (início da barra lateral)", { width: 620, height: 900 }, {}],
  ["desktop curto 1024x600 com texto máximo", { width: 1024, height: 600 }, MAXIMO_A11Y],
  ["notebook com texto máximo", VIEWPORTS.notebook, MAXIMO_A11Y],
];

for (const [nome, tamanho, ajustes] of CENARIOS_LATERAL) {
  test(`a barra lateral da Administração termina acima da barra inferior parada e rolada (${nome})`, async ({ page, context }) => {
    await abrir(page, context, "superadmin", "/#/admin/config", tamanho, ajustes, "#adminSub-config");
    await expect(page.locator(".admin-subtabs")).toBeVisible();

    const parada = await page.evaluate(medirLateral);
    expect(parada.sticky, "a barra lateral é sticky neste tamanho").toBe(true);
    if (!parada.piso) {
      expect(parada.caixaBase, "parada: a caixa termina acima da barra inferior").toBeLessThanOrEqual(parada.topoDaBarra);
      expect(parada.ultimoSobABarra, "parada: o último item não fica sob a barra").toBe(0);
      expect(parada.ultimoAlcancavel, "parada: o último item recebe o toque").toBe(true);
    }

    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const rolada = await page.evaluate(medirLateral);
    // A folga é medida contra a barra inferior real (com texto máximo ela passa de 100px).
    expect(rolada.topoDaBarra - rolada.caixaBase, "rolada: folga até a barra inferior real").toBeGreaterThanOrEqual(20);
    expect(rolada.ultimoSobABarra, "rolada: o último item não fica sob a barra").toBe(0);
    expect(rolada.ultimoAlcancavel, "rolada: o último item recebe o toque").toBe(true);
  });
}

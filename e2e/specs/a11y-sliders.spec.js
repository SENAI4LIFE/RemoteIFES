const { test, expect, API_URL } = require("../harness/fixtures");

const WEB_URL = process.env.E2E_WEB_URL || "http://127.0.0.1:8790";

async function abrirPainel(page) {
  await page.goto("/");
  await expect(page.locator("#screen-portal")).toBeVisible({ timeout: 20_000 });
  await page.locator("#a11yToggleBtn").click();
  await expect(page.locator("#a11yPanel")).toBeVisible();
}

async function estadoVisual(slider) {
  return slider.evaluate((input) => {
    const estilo = getComputedStyle(input);
    return {
      valor: input.value,
      preenchimento: parseFloat(estilo.getPropertyValue("--a11y-slider-fill")),
      padding: estilo.padding,
      borda: estilo.borderTopWidth,
      altura: input.getBoundingClientRect().height,
    };
  });
}

test("sliders restauram valor e preenchimento e respondem imediatamente ao teclado", async ({ page, context }) => {
  await context.addInitScript(() => {
    if (localStorage.getItem("remoteifes_font_scale") === null) localStorage.setItem("remoteifes_font_scale", "1.5");
    if (localStorage.getItem("remoteifes_letter_spacing") === null) localStorage.setItem("remoteifes_letter_spacing", "0.12");
    if (localStorage.getItem("remoteifes_line_height") === null) localStorage.setItem("remoteifes_line_height", "2.1");
    if (localStorage.getItem("remoteifes_paragraph_width") === null) localStorage.setItem("remoteifes_paragraph_width", "4");
  });
  await abrirPainel(page);

  const casos = [
    ["#a11yFontSlider", "1.5", 60],
    ["#a11ySpacingSlider", "0.12", 48],
    ["#a11yLineSlider", "2.1", 50],
    ["#a11yParagraphSlider", "4", 66.666],
  ];
  for (const [seletor, valor, preenchimento] of casos) {
    const estado = await estadoVisual(page.locator(seletor));
    expect(estado.valor).toBe(valor);
    expect(estado.preenchimento).toBeCloseTo(preenchimento, 1);
    expect(estado.padding).toBe("0px");
    expect(estado.borda).toBe("0px");
    expect(estado.altura).toBeGreaterThanOrEqual(44);
  }

  const fonte = page.locator("#a11yFontSlider");
  await fonte.evaluate((input) => {
    input.value = "1.8";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.locator("#a11yFontValue")).toHaveText("180%");
  expect((await estadoVisual(fonte)).preenchimento).toBeCloseTo(84, 1);

  await fonte.focus();
  await page.keyboard.press("ArrowRight");
  await expect(fonte).toHaveValue("1.85");
  await expect(page.locator("#a11yFontValue")).toHaveText("185%");
  expect((await estadoVisual(fonte)).preenchimento).toBeCloseTo(88, 1);
  expect(await page.evaluate(() => localStorage.getItem("remoteifes_font_scale"))).toBe("1.85");

  await page.reload();
  await expect(page.locator("#screen-portal")).toBeVisible({ timeout: 20_000 });
  expect((await estadoVisual(page.locator("#a11yFontSlider"))).preenchimento).toBeCloseTo(88, 1);
});

test("slider mantém percurso e atualização visual por toque no mobile", async ({ browser }) => {
  const context = await browser.newContext({
    baseURL: WEB_URL,
    hasTouch: true,
    viewport: { width: 390, height: 844 },
  });
  await context.addInitScript((apiUrl) => localStorage.setItem("remoteifes_server_url", apiUrl), API_URL);
  const page = await context.newPage();
  await abrirPainel(page);
  const slider = page.locator("#a11ySpacingSlider");
  const caixa = await slider.boundingBox();
  await page.touchscreen.tap(caixa.x + caixa.width * 0.75, caixa.y + caixa.height / 2);
  const estado = await estadoVisual(slider);
  expect(estado.preenchimento).toBeGreaterThan(60);
  expect(estado.preenchimento).toBeLessThan(90);
  expect(parseFloat(estado.valor)).toBeGreaterThan(0.15);
  expect(await page.evaluate(() => localStorage.getItem("remoteifes_letter_spacing"))).toBe(estado.valor);
  await expect(page.locator("#a11yPanel")).toBeVisible();
  await context.close();
});

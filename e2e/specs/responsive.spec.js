const { test, expect, VIEWPORTS, injetarSessao, semRolagemHorizontal, irParaSala } = require("../harness/fixtures");

async function dentroDaViewport(locator) {
  const box = await locator.boundingBox();
  const vp = locator.page().viewportSize();
  expect(box, "elemento deve ter caixa visível").not.toBeNull();
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.y).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height + 1);
}

async function abrirComoUsuario(page, context, tamanho) {
  await injetarSessao(context, "user");
  await page.setViewportSize(tamanho);
  await page.goto("/");
  await expect(page.locator("#mainApp")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#screen-server-status")).toBeHidden();
}

for (const [nome, tamanho] of Object.entries(VIEWPORTS)) {
  test(`layout ${nome} (${tamanho.width}x${tamanho.height}): sem rolagem horizontal e controles acessíveis`, async ({ page, context }) => {
    await abrirComoUsuario(page, context, tamanho);
    expect(await semRolagemHorizontal(page), "tela de salas sem rolagem horizontal").toBe(true);

    const abaSalas = page.locator('.tab-btn[data-tab="salas"]');
    await expect(abaSalas).toBeVisible();
    await dentroDaViewport(abaSalas);

    await irParaSala(page, "A-108");
    expect(await semRolagemHorizontal(page), "painel sem rolagem horizontal").toBe(true);

    for (const sel of ["#btnPower", "#tempUp", "#tempDown"]) {
      const ctrl = page.locator(sel);
      await expect(ctrl).toBeVisible();
      await dentroDaViewport(ctrl);
    }
    await page.locator("#btnPower").click();
    await expect(page.locator("#modoValue")).toHaveText("Cool", { timeout: 15_000 });
    await page.locator("#btnPower").click();
    await expect(page.locator("#modoValue")).toHaveText("Off");
  });
}

test("rotação retrato -> paisagem preserva a tela e o estado do controlador", async ({ page, context }) => {
  await abrirComoUsuario(page, context, VIEWPORTS["mobile-portrait"]);
  await irParaSala(page, "A-108");
  await page.locator("#btnPower").click();
  await expect(page.locator("#modoValue")).toHaveText("Cool", { timeout: 15_000 });

  await page.setViewportSize(VIEWPORTS["mobile-landscape"]);
  await expect(page.locator("#screen-panel")).toBeVisible();
  await expect(page.locator("#modoValue")).toHaveText("Cool");
  await expect(page.locator("#btnPower")).toBeVisible();
  expect(await semRolagemHorizontal(page), "paisagem sem rolagem horizontal").toBe(true);

  await page.setViewportSize(VIEWPORTS["mobile-portrait"]);
  await expect(page.locator("#screen-panel")).toBeVisible();
  await expect(page.locator("#modoValue")).toHaveText("Cool");

  await page.locator("#btnPower").click();
  await expect(page.locator("#modoValue")).toHaveText("Off");
});

const { test, expect, VIEWPORTS, API_URL, injetarSessao, semRolagemHorizontal, irParaSala } = require("../harness/fixtures");

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

for (const nome of ["mobile-portrait", "mobile-landscape", "tablet-portrait", "notebook"]) {
  test(`planta baixa do cadastro de ESP32 não vaza da tela (${nome})`, async ({ page, context }) => {
    await injetarSessao(context, "superadmin");
    await page.setViewportSize(VIEWPORTS[nome]);
    await page.goto("/#/admin/macs");
    await expect(page.locator("#adminSub-macs")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("#macsFpInner .room.selectable").first()).toBeVisible({ timeout: 10_000 });

    expect(await semRolagemHorizontal(page), "página sem rolagem horizontal").toBe(true);

    const medida = await page.evaluate(() => {
      const inner = document.getElementById("macsFpInner");
      const secao = inner && inner.querySelector(".fp-section:not(.hidden)");
      const plan = secao && secao.querySelector(".plan");
      const wrap = secao && secao.querySelector(".plan-wrap");
      if (!plan || !wrap) return null;
      const pr = plan.getBoundingClientRect();
      const wr = wrap.getBoundingClientRect();
      return {
        vazaDireita: Math.round(pr.x + pr.width - (wr.x + wr.width)),
        rolavel: wrap.classList.contains("fp-zoomed"),
      };
    });
    expect(medida, "planta baixa renderizada").not.toBeNull();
    expect(medida.vazaDireita <= 1 || medida.rolavel, `planta cabe ou rola (${JSON.stringify(medida)})`).toBe(true);
  });
}

for (const nome of ["mobile-portrait", "mobile-landscape", "tablet-portrait"]) {
  test(`a página do aplicativo com APK publicado não vaza da tela (${nome})`, async ({ page, context, request }) => {
    await request.post(`${API_URL}/__e2e/publicar-apk`);
    try {
      await injetarSessao(context, "user");
      await page.setViewportSize(VIEWPORTS[nome]);
      await page.goto("/#/aplicativo");
      const baixar = page.locator(".mobile-app-download-btn");
      await expect(baixar).toBeVisible({ timeout: 20_000 });
      expect(await semRolagemHorizontal(page), "página do aplicativo sem rolagem horizontal").toBe(true);

      const medidas = await page.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        const btn = document.querySelector(".mobile-app-download-btn").getBoundingClientRect();
        const hash = document.querySelector(".mobile-app-hash");
        return {
          botaoVaza: Math.round(btn.x + btn.width - vw),
          hashVaza: hash.scrollWidth - hash.clientWidth,
        };
      });
      expect(medidas.botaoVaza, "botão de download cabe na largura").toBeLessThanOrEqual(1);
      expect(medidas.hashVaza, "o SHA-256 quebra dentro do cartão").toBeLessThanOrEqual(1);
    } finally {
      await request.post(`${API_URL}/__e2e/despublicar-apk`);
    }
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

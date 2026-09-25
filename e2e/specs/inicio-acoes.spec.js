const { test, expect, injetarSessao, VIEWPORTS } = require("../harness/fixtures");

async function abrirInicio(page, context, role, viewport) {
  await injetarSessao(context, role);
  if (viewport) await page.setViewportSize(viewport);
  await page.goto("/#/inicio");
  await expect(page.locator("#screen-inicio")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#hubGridPrincipal .hub-card").first()).toBeVisible();
}

const card = (page, chave) => page.locator(`.hub-card[data-hub-card="${chave}"]`);

const ACOES = {
  salas: { hash: "#/salas", visivel: "#screen-simple" },
  planta: { hash: /^#\/salas\/planta(\/|$)/, visivel: "#screen-floorplan" },
  agenda: { hash: "#/agenda", visivel: "#screen-agenda" },
  grade: { hash: "#/grade", visivel: "#screen-grade" },
  notificacoes: { visivel: "#notifPanel" },
  relatos: { visivel: "#relatosPanel" },
  ajuda: { visivel: "#screen-manual" },
  aplicativo: { visivel: "#screen-mobile-app" },
};

test("Início shows the greeting without the redundant RemoteIFES label", async ({ page, context }) => {
  await abrirInicio(page, context, "superadmin");
  await expect(page.locator("#hubHeroTitulo")).toHaveText("Olá, Superadministrador");
  await expect(page.locator(".hub-hero-eyebrow")).toHaveCount(0);
});

for (const role of ["user", "admin", "superadmin"]) {
  test(`every visible Início action works for ${role}`, async ({ page, context }) => {
    test.setTimeout(150_000);
    await abrirInicio(page, context, role);
    const chaves = await page.$$eval("#hubGridPrincipal .hub-card", (cs) => cs.map((c) => c.dataset.hubCard));
    expect(chaves.length).toBeGreaterThan(0);

    for (const chave of chaves) {
      const esperado = ACOES[chave];
      expect(esperado, `ação "${chave}" de Início sem cobertura`).toBeTruthy();

      const alvo = card(page, chave);
      await expect(alvo.locator(".hub-card-icon")).toHaveCount(1);
      await expect(alvo.locator(".hub-card-title")).toHaveCount(1);
      await expect(alvo).toBeVisible();
      const caixa = await alvo.boundingBox();
      expect(caixa.height, `alvo de toque de "${chave}"`).toBeGreaterThanOrEqual(44);

      await alvo.click();
      await expect(page.locator(esperado.visivel), `${chave} → ${esperado.visivel}`).toBeVisible({ timeout: 15_000 });
      if (esperado.hash instanceof RegExp) {
        await expect.poll(() => page.evaluate(() => location.hash)).toMatch(esperado.hash);
      } else if (esperado.hash) {
        await expect.poll(() => page.evaluate(() => location.hash)).toBe(esperado.hash);
      }

      await page.keyboard.press("Escape");
      await page.goto("/#/inicio");
      await page.reload();
      await expect(page.locator("#screen-inicio")).toBeVisible({ timeout: 20_000 });
      await expect(page.locator("#screen-manual")).toBeHidden();
    }
  });
}

test("Relatar problema opens the reports panel by keyboard and stays open", async ({ page, context }) => {
  await abrirInicio(page, context, "user");
  const relato = card(page, "relatos");
  await expect(relato).toContainText("Relatar problema");
  await relato.focus();
  await expect(relato).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#relatosPanel")).toBeVisible();
  await expect(page.locator("#relatosPanel")).toContainText("Relatar problema", { timeout: 15_000 });
  await page.waitForTimeout(300);
  await expect(page.locator("#relatosPanel")).toBeVisible();
  await expect(page.locator("#bugReportBtn")).toHaveAttribute("aria-expanded", "true");
});

test("Relatar problema from the quick help menu also opens the panel", async ({ page, context }) => {
  await injetarSessao(context, "user");
  await page.goto("/#/inicio");
  await expect(page.locator("#screen-inicio")).toBeVisible({ timeout: 20_000 });
  await page.locator("#helpFabToggleBtn").click();
  await expect(page.locator("#helpFabPanel")).toBeVisible();
  await page.locator('#helpFabPrimaryLinks [data-help-action="report"]').click();
  await expect(page.locator("#relatosPanel")).toBeVisible();
  await page.waitForTimeout(300);
  await expect(page.locator("#relatosPanel")).toBeVisible();
});

test("the Notificações card opens the bell panel and keeps the list visible", async ({ page, context }) => {
  await abrirInicio(page, context, "admin");
  await card(page, "notificacoes").click();
  await expect(page.locator("#notifPanel")).toBeVisible();
  await page.waitForTimeout(300);
  await expect(page.locator("#notifPanel")).toBeVisible();
  await expect(page.locator("#notifBellBtn")).toHaveAttribute("aria-expanded", "true");
});

test("hub Administration shortcuts open the matching sub-tab", async ({ page, context }) => {
  test.setTimeout(150_000);
  await abrirInicio(page, context, "superadmin");
  const atalhos = await page.$$eval("#hubGridAdmin .hub-card", (cs) => cs.map((c) => c.dataset.hubCard));
  expect(atalhos.length).toBeGreaterThan(0);
  for (const chave of atalhos) {
    const sub = chave.replace(/^adm-/, "");
    await page.locator(`.hub-card[data-hub-card="${chave}"]`).click();
    await expect(page.locator(`#adminSub-${sub}`), `${chave} → #adminSub-${sub}`).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => page.evaluate(() => location.hash)).toBe(`#/admin/${sub}`);
    await page.goto("/#/inicio");
    await expect(page.locator("#screen-inicio")).toBeVisible({ timeout: 15_000 });
  }
});

test("Início actions stay clickable on a phone in portrait", async ({ page, context }) => {
  await abrirInicio(page, context, "user", VIEWPORTS["mobile-portrait"]);
  const relato = card(page, "relatos");
  const caixa = await relato.boundingBox();
  expect(caixa.width).toBeGreaterThan(0);
  expect(caixa.height).toBeGreaterThanOrEqual(44);
  await relato.click();
  await expect(page.locator("#relatosPanel")).toBeVisible();
});

test("no Início action points to a route outside the user's role", async ({ page, context }) => {
  await abrirInicio(page, context, "user");
  const chaves = await page.$$eval("#hubGridPrincipal .hub-card", (cs) => cs.map((c) => c.dataset.hubCard));
  expect(chaves).not.toContain("agenda");
  expect(chaves).not.toContain("grade");
  expect(chaves).not.toContain("notificacoes");
  await expect(page.locator("#hubGridAdmin .hub-card")).toHaveCount(0);
});

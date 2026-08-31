const { test, expect, API_URL, injetarSessao, tokenDe, VIEWPORTS, semRolagemHorizontal } = require("../harness/fixtures");

test("histórico administrativo rejeita usuário e admin e aceita somente superadmin", async ({ request }) => {
  expect((await request.get(`${API_URL}/admin/auditoria`)).status()).toBe(401);
  expect((await request.get(`${API_URL}/admin/auditoria`, { headers: { Authorization: `Bearer ${tokenDe("user")}` } })).status()).toBe(403);
  expect((await request.get(`${API_URL}/admin/auditoria`, { headers: { Authorization: `Bearer ${tokenDe("admin")}` } })).status()).toBe(403);
  const superResp = await request.get(`${API_URL}/admin/auditoria?pagina=1&limite=25`, { headers: { Authorization: `Bearer ${tokenDe("superadmin")}` } });
  expect(superResp.status()).toBe(200);
  expect((await superResp.json()).itens).toBeInstanceOf(Array);
});

test("superadmin abre auditoria paginada e vê retenção configurada", async ({ page, context }) => {
  await injetarSessao(context, "superadmin");
  await page.goto("/#/admin/auditoria");
  await expect(page.locator("#adminSub-auditoria")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#auditRetentionCurrent")).toHaveText("7 dias");
  await expect(page.locator("#auditPageInfo")).toContainText("Página 1 de");
  await expect(page.locator("#connectPageInfo")).toContainText("Página 1 de");
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/admin/auditoria");
});

test("admin comum não abre auditoria por rota direta", async ({ page, context }) => {
  await injetarSessao(context, "admin");
  await page.goto("/#/admin/auditoria");
  await expect(page.locator("#adminSub-usuarios")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.admin-subtab-btn[data-sub="auditoria"]')).toBeHidden();
});

for (const nome of ["mobile-compact", "mobile-landscape", "desktop-compact"]) {
  test(`auditoria responsiva sem vazamento horizontal (${nome})`, async ({ page, context }) => {
    await injetarSessao(context, "superadmin");
    await page.setViewportSize(VIEWPORTS[nome]);
    await page.goto("/#/admin/auditoria");
    await expect(page.locator("#adminSub-auditoria")).toBeVisible({ timeout: 20_000 });
    expect(await semRolagemHorizontal(page)).toBe(true);
    await expect(page.locator("#auditFiltrarBtn")).toBeVisible();
    await expect(page.locator("#connectFiltrarBtn")).toBeVisible();
  });
}

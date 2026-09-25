const { test, expect, API_URL, injetarSessao, tokenDe, VIEWPORTS, semRolagemHorizontal } = require("../harness/fixtures");

test("administrative history rejects user and admin and accepts only superadmin", async ({ request }) => {
  expect((await request.get(`${API_URL}/admin/auditoria`)).status()).toBe(401);
  expect((await request.get(`${API_URL}/admin/auditoria`, { headers: { Authorization: `Bearer ${tokenDe("user")}` } })).status()).toBe(403);
  expect((await request.get(`${API_URL}/admin/auditoria`, { headers: { Authorization: `Bearer ${tokenDe("admin")}` } })).status()).toBe(403);
  const superResp = await request.get(`${API_URL}/admin/auditoria?pagina=1&limite=25`, { headers: { Authorization: `Bearer ${tokenDe("superadmin")}` } });
  expect(superResp.status()).toBe(200);
  expect((await superResp.json()).itens).toBeInstanceOf(Array);
});

test("a superadmin opens the paginated audit and sees the configured retention", async ({ page, context }) => {
  await injetarSessao(context, "superadmin");
  await page.goto("/#/admin/auditoria");
  await expect(page.locator("#logsAba-auditoria")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#auditRetentionCurrent")).toHaveText("7 dias");
  await expect(page.locator("#auditPageInfo")).toContainText("Página 1 de");
  await expect(page.locator("#connectPageInfo")).toContainText("Página 1 de");
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/admin/logs/auditoria");
});

test("a regular admin cannot open the audit by direct route", async ({ page, context }) => {
  await injetarSessao(context, "admin");
  await page.goto("/#/admin/auditoria");
  await expect(page.locator("#logsAba-comandos")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#logsAba-auditoria")).toBeHidden();
  await expect(page.locator('#adminSub-logs .admin-inner-tab-btn[data-aba="auditoria"]')).toBeHidden();
});

for (const nome of ["mobile-compact", "mobile-landscape", "desktop-compact"]) {
  test(`responsive audit without horizontal overflow (${nome})`, async ({ page, context }) => {
    await injetarSessao(context, "superadmin");
    await page.setViewportSize(VIEWPORTS[nome]);
    await page.goto("/#/admin/auditoria");
    await expect(page.locator("#logsAba-auditoria")).toBeVisible({ timeout: 20_000 });
    expect(await semRolagemHorizontal(page)).toBe(true);
    await expect(page.locator("#auditFiltrarBtn")).toBeVisible();
    await expect(page.locator("#connectFiltrarBtn")).toBeVisible();
  });
}

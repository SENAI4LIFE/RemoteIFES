const { test, expect, API_URL } = require("../harness/fixtures");

test("a regular user sees neither Admin, Agenda, Grade nor the device bell", async ({ page, sessaoComo }) => {
  await sessaoComo("user");
  await expect(page.locator('.tab-btn[data-tab="salas"]')).toBeVisible();
  await expect(page.locator("#adminTabBtn")).toBeHidden();
  await expect(page.locator("#agendaTabBtn")).toBeHidden();
  await expect(page.locator("#gradeTabBtn")).toBeHidden();
  await expect(page.locator("#notifWrap")).toBeHidden();
  await expect(page.locator("#bugWrap")).toBeVisible();
});

test("an administrator sees Admin, Agenda, Grade and the bell, but not the superadmin sub-tabs", async ({ page, sessaoComo }) => {
  await sessaoComo("admin");
  await expect(page.locator("#adminTabBtn")).toBeVisible();
  await expect(page.locator("#agendaTabBtn")).toBeVisible();
  await expect(page.locator("#gradeTabBtn")).toBeVisible();
  await expect(page.locator("#notifWrap")).toBeVisible();

  await page.locator("#adminTabBtn").click();
  await expect(page.locator("#screen-admin")).toBeVisible();
  await expect(page.locator('.admin-subtab-btn[data-sub="usuarios"]')).toBeVisible();
  await expect(page.locator('.admin-subtab-btn[data-sub="config"]')).toBeHidden();
  await expect(page.locator('.admin-subtab-btn[data-sub="macs"]')).toBeHidden();
  await expect(page.locator('.admin-subtab-btn[data-sub="esp32"]')).toBeHidden();
  await expect(page.locator('.admin-subtab-btn[data-sub="protocolos"]')).toBeHidden();
});

test("the superadministrator sees the exclusive sub-tabs (Configurações, Cadastro, Firmware / OTA, Protocolos IR)", async ({ page, sessaoComo }) => {
  await sessaoComo("superadmin");
  await page.locator("#adminTabBtn").click();
  await expect(page.locator("#screen-admin")).toBeVisible();
  await expect(page.locator('.admin-subtab-btn[data-sub="config"]')).toBeVisible();
  await expect(page.locator('.admin-subtab-btn[data-sub="macs"]')).toBeVisible();
  await expect(page.locator('.admin-subtab-btn[data-sub="esp32"]')).toBeVisible();
  await expect(page.locator('.admin-subtab-btn[data-sub="protocolos"]')).toBeVisible();
});

test("Monitoramento is superadministrator-only (interface and API)", async ({ page, sessaoComo, request, tokens }) => {
  await sessaoComo("admin");
  await page.locator("#adminTabBtn").click();
  await expect(page.locator("#screen-admin")).toBeVisible();
  await expect(page.locator('#adminSub-status .admin-inner-tab-btn[data-aba="sistema"]')).toBeHidden();

  const comAdmin = await request.get(`${API_URL}/admin/monitoramento`, {
    headers: { Authorization: `Bearer ${tokens.admin}` },
  });
  expect(comAdmin.status()).toBe(403);
  const comSuper = await request.get(`${API_URL}/admin/monitoramento`, {
    headers: { Authorization: `Bearer ${tokens.superadmin}` },
  });
  expect(comSuper.status()).toBe(200);
});

test("the superadministrator opens Monitoramento with status badges", async ({ page, sessaoComo }) => {
  await sessaoComo("superadmin");
  await page.locator("#adminTabBtn").click();
  await page.locator('.admin-subtab-btn[data-sub="status"]').click();
  await page.locator('#adminSub-status .admin-inner-tab-btn[data-aba="sistema"]').click();
  await expect(page.locator("#statusAba-sistema")).toBeVisible();
  await expect(page.locator("#monGrid .mon-card")).not.toHaveCount(0);
  await expect(page.locator("#monGrid .status-chip").first()).toBeVisible({ timeout: 10_000 });
});

test("the administrative API requires a token and admin level", async ({ request, tokens }) => {
  const semToken = await request.get(`${API_URL}/admin/usuarios`);
  expect(semToken.status()).toBe(401);

  const comComum = await request.get(`${API_URL}/admin/usuarios`, {
    headers: { Authorization: `Bearer ${tokens.user}` },
  });
  expect(comComum.status()).toBe(403);

  const comAdmin = await request.get(`${API_URL}/admin/usuarios`, {
    headers: { Authorization: `Bearer ${tokens.admin}` },
  });
  expect(comAdmin.status()).toBe(200);
});

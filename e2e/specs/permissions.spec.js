const { test, expect, API_URL } = require("../harness/fixtures");

test("usuário comum não vê Admin, Agenda, Grade nem o sino de dispositivos", async ({ page, sessaoComo }) => {
  await sessaoComo("user");
  await expect(page.locator('.tab-btn[data-tab="salas"]')).toBeVisible();
  await expect(page.locator("#adminTabBtn")).toBeHidden();
  await expect(page.locator("#agendaTabBtn")).toBeHidden();
  await expect(page.locator("#gradeTabBtn")).toBeHidden();
  await expect(page.locator("#notifWrap")).toBeHidden();
  await expect(page.locator("#bugWrap")).toBeVisible();
});

test("administrador vê Admin, Agenda, Grade e o sino, mas não as sub-abas de superadmin", async ({ page, sessaoComo }) => {
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
});

test("superadministrador vê as sub-abas exclusivas (Configurações, ESP32/MACs, ESP32)", async ({ page, sessaoComo }) => {
  await sessaoComo("superadmin");
  await page.locator("#adminTabBtn").click();
  await expect(page.locator("#screen-admin")).toBeVisible();
  await expect(page.locator('.admin-subtab-btn[data-sub="config"]')).toBeVisible();
  await expect(page.locator('.admin-subtab-btn[data-sub="macs"]')).toBeVisible();
  await expect(page.locator('.admin-subtab-btn[data-sub="esp32"]')).toBeVisible();
});

test("o Monitoramento é exclusivo do superadministrador (interface e API)", async ({ page, sessaoComo, request, tokens }) => {
  await sessaoComo("admin");
  await page.locator("#adminTabBtn").click();
  await expect(page.locator("#screen-admin")).toBeVisible();
  await expect(page.locator('.admin-subtab-btn[data-sub="monitoramento"]')).toBeHidden();

  const comAdmin = await request.get(`${API_URL}/admin/monitoramento`, {
    headers: { Authorization: `Bearer ${tokens.admin}` },
  });
  expect(comAdmin.status()).toBe(403);
  const comSuper = await request.get(`${API_URL}/admin/monitoramento`, {
    headers: { Authorization: `Bearer ${tokens.superadmin}` },
  });
  expect(comSuper.status()).toBe(200);
});

test("o superadministrador abre o Monitoramento com selos de estado", async ({ page, sessaoComo }) => {
  await sessaoComo("superadmin");
  await page.locator("#adminTabBtn").click();
  await page.locator('.admin-subtab-btn[data-sub="monitoramento"]').click();
  await expect(page.locator("#adminSub-monitoramento")).toBeVisible();
  await expect(page.locator("#monGrid .mon-card")).not.toHaveCount(0);
  await expect(page.locator("#monGrid .status-chip").first()).toBeVisible({ timeout: 10_000 });
});

test("a API administrativa exige token e nível de admin", async ({ request, tokens }) => {
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

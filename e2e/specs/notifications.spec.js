const { test, expect, API_URL, tokenDe, injetarSessao } = require("../harness/fixtures");

test("API de notificações exige autorização administrativa", async ({ request }) => {
  expect((await request.get(`${API_URL}/admin/notificacoes`)).status()).toBe(401);
  expect((await request.get(`${API_URL}/admin/notificacoes`, { headers: { Authorization: `Bearer ${tokenDe("user")}` } })).status()).toBe(403);
  expect((await request.get(`${API_URL}/admin/notificacoes`, { headers: { Authorization: `Bearer ${tokenDe("admin")}` } })).status()).toBe(200);
});

test("Dispositivos > Notificações mostra a mesma fila do sino sem duplicar dados", async ({ page, context }) => {
  await injetarSessao(context, "admin");
  await page.goto("/#/admin/notificacoes");
  await expect(page.locator('.admin-subtab-btn[data-sub="notificacoes"]')).toContainText("Notificações");
  await expect(page.locator('.admin-subtab-group[data-grupo="dispositivos"] .admin-group-btn')).toContainText("Dispositivos");
  await expect(page.locator("#adminSub-notificacoes")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#adminNotifList .notif-item").first()).toContainText("offline");
});

test("administrador abre o sino e vê a notificação de ESP32 offline", async ({ page, sessaoComo }) => {
  await sessaoComo("admin");
  await expect(page.locator("#notifWrap")).toBeVisible();

  await page.locator("#notifBellBtn").click();
  await expect(page.locator("#notifPanel")).toBeVisible();
  await expect(page.locator("#notifList li").first()).toContainText("offline");
});

test("marcar todas como lidas remove o indicador do sino", async ({ page, sessaoComo }) => {
  await sessaoComo("admin");
  await page.locator("#notifBellBtn").click();
  await expect(page.locator("#notifPanel")).toBeVisible();
  await page.locator("#notifMarcarTodasBtn").click();
  await expect(page.locator("#notifDot")).toBeHidden();
});

test("o sino e o ícone de inseto são indicadores distintos", async ({ page, sessaoComo }) => {
  await sessaoComo("admin");
  await expect(page.locator("#notifBellBtn")).toBeVisible();
  await expect(page.locator("#bugReportBtn")).toBeVisible();
  await expect(page.locator("#notifBellBtn")).toHaveAttribute("aria-label", /dispositivos/i);
  await expect(page.locator("#bugReportBtn")).toHaveAttribute("aria-label", /problema/i);
});

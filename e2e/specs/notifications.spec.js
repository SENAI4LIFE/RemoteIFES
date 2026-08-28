const { test, expect } = require("../harness/fixtures");

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

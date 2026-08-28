const { test, expect, API_URL } = require("../harness/fixtures");

test("o servidor central responde no /health independente de ESP32", async ({ request }) => {
  const resp = await request.get(`${API_URL}/health`);
  expect(resp.status()).toBe(200);
  const corpo = await resp.json();
  expect(corpo.ok).toBe(true);
  expect(corpo.banco).toBe("ok");
});

test("o app carrega, conecta ao servidor e mostra o portal de acesso", async ({ appPage }) => {
  await expect(appPage.locator("#screen-portal")).toBeVisible();
  await expect(appPage.locator("#screen-server-status")).toBeHidden();
  await expect(appPage.locator('.portal-option[data-tipo="normal"]')).toBeVisible();
  await expect(appPage.locator('.portal-option[data-tipo="admin"]')).toBeVisible();
});

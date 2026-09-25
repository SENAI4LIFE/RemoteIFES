const { test, expect } = require("../harness/fixtures");

test("a regular user login opens the home hub", async ({ appPage, loginComo }) => {
  await loginComo("user");
  await expect(appPage.locator("#mainApp")).toBeVisible();
  await expect(appPage.locator("#screen-inicio")).toBeVisible();
  await expect(appPage.locator('.tab-btn[data-tab="inicio"].active')).toBeVisible();
  await expect(appPage.locator('#hubGridPrincipal .hub-card[data-hub-card="salas"]')).toBeVisible();
  await appPage.locator("#accountMenuBtn").click();
  await expect(appPage.locator("#accountMenuName")).toContainText("Usuário E2E");
});

test("an administrator login shows the (admin) label", async ({ appPage, loginComo }) => {
  await loginComo("admin");
  await appPage.locator("#accountMenuBtn").click();
  await expect(appPage.locator("#accountMenuRole")).toHaveText("Administrador");
});

test("a wrong password does not authenticate and keeps the login screen", async ({ appPage }) => {
  await appPage.locator('.portal-option[data-tipo="normal"]').click();
  await appPage.fill("#username", "e2e_user");
  await appPage.fill("#password", "senha-errada");
  await appPage.click("#loginForm button[type=submit]");
  await expect(appPage.locator("#screen-login")).toBeVisible();
  await expect(appPage.locator("#mainApp")).toBeHidden();
});

test("entering through the administrator door with a regular account is refused", async ({ appPage }) => {
  await appPage.locator('.portal-option[data-tipo="admin"]').click();
  await appPage.fill("#username", "e2e_user");
  await appPage.fill("#password", "e2e-user-pass-123");
  await appPage.click("#loginForm button[type=submit]");
  await expect(appPage.locator("#mainApp")).toBeHidden();
  await expect(appPage.locator("#screen-login")).toBeVisible();
});

test("logout returns to the portal and hides the authenticated tabs", async ({ appPage, loginComo }) => {
  await loginComo("admin");
  await appPage.locator("#accountMenuBtn").click();
  await appPage.locator('[data-account-action="logout"]').click();
  await expect(appPage.locator("#screen-portal")).toBeVisible();
  await expect(appPage.locator("#mainApp")).toBeHidden();
  await expect(appPage.locator("#adminTabBtn")).toBeHidden();
  await expect(appPage.locator("#logoutBtn")).toBeHidden();
});

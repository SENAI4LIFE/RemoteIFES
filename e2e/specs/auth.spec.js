const { test, expect } = require("../harness/fixtures");

test("login de usuário comum abre o início (hub)", async ({ appPage, loginComo }) => {
  await loginComo("user");
  await expect(appPage.locator("#mainApp")).toBeVisible();
  await expect(appPage.locator("#screen-inicio")).toBeVisible();
  await expect(appPage.locator('.tab-btn[data-tab="inicio"].active')).toBeVisible();
  await expect(appPage.locator('#hubGridPrincipal .hub-card[data-hub-card="salas"]')).toBeVisible();
  await appPage.locator("#accountMenuBtn").click();
  await expect(appPage.locator("#accountMenuName")).toContainText("Usuário E2E");
});

test("login de administrador mostra o rótulo (admin)", async ({ appPage, loginComo }) => {
  await loginComo("admin");
  await appPage.locator("#accountMenuBtn").click();
  await expect(appPage.locator("#accountMenuRole")).toHaveText("Administrador");
});

test("senha incorreta não autentica e mantém a tela de login", async ({ appPage }) => {
  await appPage.locator('.portal-option[data-tipo="normal"]').click();
  await appPage.fill("#username", "e2e_user");
  await appPage.fill("#password", "senha-errada");
  await appPage.click("#loginForm button[type=submit]");
  await expect(appPage.locator("#screen-login")).toBeVisible();
  await expect(appPage.locator("#mainApp")).toBeHidden();
});

test("entrar pela porta de administrador com conta comum é recusado", async ({ appPage }) => {
  await appPage.locator('.portal-option[data-tipo="admin"]').click();
  await appPage.fill("#username", "e2e_user");
  await appPage.fill("#password", "e2e-user-pass-123");
  await appPage.click("#loginForm button[type=submit]");
  await expect(appPage.locator("#mainApp")).toBeHidden();
  await expect(appPage.locator("#screen-login")).toBeVisible();
});

test("logout volta ao portal e esconde as abas autenticadas", async ({ appPage, loginComo }) => {
  await loginComo("admin");
  await appPage.locator("#accountMenuBtn").click();
  await appPage.locator('[data-account-action="logout"]').click();
  await expect(appPage.locator("#screen-portal")).toBeVisible();
  await expect(appPage.locator("#mainApp")).toBeHidden();
  await expect(appPage.locator("#adminTabBtn")).toBeHidden();
  await expect(appPage.locator("#logoutBtn")).toBeHidden();
});

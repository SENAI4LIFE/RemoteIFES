const { test, expect, API_URL, semRolagemHorizontal } = require("../harness/fixtures");

test("contagem por papel e aviso da senha padrão aparecem no cabeçalho correto", async ({ appPage, loginComo }) => {
  await loginComo("user");
  await expect(appPage.locator("#accountSessionTimer")).toHaveText(/^\d{2}:\d{2}$/);
  await expect(appPage.locator("#defaultPasswordWarning")).toBeHidden();
  await appPage.locator("#accountMenuBtn").click();
  await appPage.locator('[data-account-action="logout"]').click();

  await loginComo("superadmin");
  await expect(appPage.locator("#accountSessionTimer")).toHaveText(/^11h \d+m$/);
  await expect(appPage.locator("#defaultPasswordWarning")).toBeVisible();
  await appPage.locator("#defaultPasswordChangeBtn").click();
  await expect(appPage.locator(".app-dialog-overlay")).toBeVisible();
});

test("atividade e continuar conectado renovam o prazo usando o ping autenticado", async ({ appPage, loginComo }) => {
  await loginComo("user");
  await appPage.evaluate(() => {
    IdleTimer.prazoServidorMs = IdleTimer._agoraServidor() + 30000;
    IdleTimer.ultimoPingMs = 0;
    IdleTimer._checar();
  });
  await expect(appPage.locator("#idleModal")).toBeVisible();
  await appPage.locator("#idleContinuarBtn").click();
  await expect(appPage.locator("#idleModal")).toBeHidden();
  await expect(appPage.locator("#accountSessionTimer")).toHaveText(/^59:\d{2}$/);

  await appPage.evaluate(() => {
    IdleTimer.prazoServidorMs = IdleTimer._agoraServidor() + 30000;
    IdleTimer.ultimoPingMs = 0;
  });
  await appPage.mouse.move(20, 20);
  await expect(appPage.locator("#accountSessionTimer")).toHaveText(/^59:\d{2}$/);
});

test("expiração automática revoga o token e volta ao login", async ({ appPage, loginComo, request }) => {
  await loginComo("user");
  const token = await appPage.evaluate(() => localStorage.getItem("remoteifes_token"));
  await appPage.evaluate(() => {
    IdleTimer.prazoServidorMs = IdleTimer._agoraServidor() - 1;
    IdleTimer._checar();
  });
  await expect(appPage.locator("#screen-login")).toBeVisible();
  await expect(appPage.locator("#mainApp")).toBeHidden();
  await expect.poll(async () => (await request.get(`${API_URL}/me`, { headers: { Authorization: `Bearer ${token}` } })).status()).toBe(401);
});

test("atividade e logout são sincronizados entre abas", async ({ appPage, loginComo, context }) => {
  await loginComo("admin");
  const segunda = await context.newPage();
  await segunda.goto("/");
  await expect(segunda.locator("#mainApp")).toBeVisible();
  await appPage.evaluate(() => {
    IdleTimer.prazoServidorMs = IdleTimer._agoraServidor() + 30000;
    IdleTimer.ultimoPingMs = 0;
  });
  await segunda.evaluate(() => {
    IdleTimer.prazoServidorMs = IdleTimer._agoraServidor() + 30000;
    IdleTimer._checar();
  });
  await appPage.mouse.move(20, 20);
  await expect(segunda.locator("#accountSessionTimer")).toHaveText(/^11h \d+m$/);
  await appPage.locator("#accountMenuBtn").click();
  await appPage.locator('[data-account-action="logout"]').click();
  await expect(segunda.locator("#screen-login")).toBeVisible();
  await expect(segunda.locator("#mainApp")).toBeHidden();
});

test("timer e aviso não criam rolagem horizontal no celular", async ({ appPage, loginComo }) => {
  await appPage.setViewportSize({ width: 360, height: 800 });
  await loginComo("superadmin");
  await expect(appPage.locator("#accountSessionTimer")).toBeVisible();
  await expect(appPage.locator("#defaultPasswordWarning")).toBeVisible();
  expect(await semRolagemHorizontal(appPage)).toBe(true);
});

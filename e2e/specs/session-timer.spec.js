const { test, expect, API_URL, semRolagemHorizontal } = require("../harness/fixtures");

test("the per-role countdown and default-password warning appear in the right header", async ({ appPage, loginComo }) => {
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

test("activity and staying connected renew the deadline using the authenticated ping", async ({ appPage, loginComo }) => {
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

test("automatic expiry revokes the token and returns to login", async ({ appPage, loginComo, request }) => {
  await loginComo("user");
  const token = await appPage.evaluate(() => localStorage.getItem("remoteifes_token"));
  let liberar;
  const pendente = new Promise(resolve => { liberar = resolve; });
  await appPage.route("**/logout", async rota => {
    await pendente;
    await rota.continue();
  });
  try {
    await appPage.evaluate(() => {
      IdleTimer.prazoServidorMs = IdleTimer._agoraServidor() - 1;
      IdleTimer._checar();
    });
    expect(await appPage.evaluate(() => Api.temTokenSalvo())).toBe(false);
    await expect(appPage.locator("#screen-login")).toBeVisible();
    await expect(appPage.locator("#mainApp")).toBeHidden();
    await expect.poll(() => appPage.evaluate(() => ServerStatus.estaConectado())).toBe(true);
  } finally {
    liberar();
  }
  await expect.poll(async () => (await request.get(`${API_URL}/me`, { headers: { Authorization: `Bearer ${token}` } })).status()).toBe(401);
});

test("activity and logout are synchronized across tabs", async ({ appPage, loginComo, context }) => {
  await loginComo("admin");
  const segunda = await context.newPage();
  await segunda.goto("/");
  await expect(segunda.locator("#mainApp")).toBeVisible();
  await expect(segunda.locator("#accountSessionTimer")).toHaveText(/^11h \d+m$/);
  for (const pagina of [appPage, segunda]) {
    await pagina.evaluate(() => {
      if (IdleTimer.pingPendente) {
        clearTimeout(IdleTimer.pingPendente);
        IdleTimer.pingPendente = null;
      }
      IdleTimer.prazoServidorMs = IdleTimer._agoraServidor() + 120000;
      IdleTimer.ultimoPingMs = 0;
      IdleTimer._checar();
    });
    await expect(pagina.locator("#accountSessionTimer")).toHaveText(/^0[12]:\d{2}$/);
    await expect(pagina.locator("#idleModal")).toBeHidden();
  }
  const recebidoNaSegunda = segunda.evaluate(() => new Promise((resolve) => {
    IdleTimer._canal.addEventListener("message", (evento) => { if (evento.data && evento.data.tipo === "prazo") resolve(evento.data); }, { once: true });
  }));
  const ping = appPage.waitForResponse((r) => r.url().endsWith("/ping") && r.ok());
  await appPage.mouse.move(20, 20);
  await ping;
  await expect(appPage.locator("#accountSessionTimer")).toHaveText(/^11h \d+m$/);
  const prazo = await recebidoNaSegunda;
  expect(typeof prazo.sessaoExpiraEm).toBe("string");
  await expect(segunda.locator("#accountSessionTimer")).toHaveText(/^11h \d+m$/);
  await expect(segunda.locator("#idleModal")).toBeHidden();

  const tokenApagadoNaSegunda = segunda.evaluate(() => new Promise((resolve) => {
    window.addEventListener("storage", (evento) => { if (evento.key === "remoteifes_token" && !evento.newValue) resolve(true); }, { once: true });
  }));
  const logout = appPage.waitForResponse((r) => r.url().endsWith("/logout"));
  await appPage.locator("#accountMenuBtn").click();
  await appPage.locator('[data-account-action="logout"]').click();
  await logout;
  expect(await tokenApagadoNaSegunda).toBe(true);
  await expect(segunda.locator("#screen-login")).toBeVisible();
  await expect(segunda.locator("#mainApp")).toBeHidden();
  expect(await segunda.evaluate(() => Api.temTokenSalvo())).toBe(false);
});

test("the timer and warning create no horizontal scroll on a phone", async ({ appPage, loginComo }) => {
  await appPage.setViewportSize({ width: 360, height: 800 });
  await loginComo("superadmin");
  await expect(appPage.locator("#accountSessionTimer")).toBeVisible();
  await expect(appPage.locator("#defaultPasswordWarning")).toBeVisible();
  expect(await semRolagemHorizontal(appPage)).toBe(true);
});

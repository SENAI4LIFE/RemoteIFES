const { test, expect, injetarSessao } = require("../harness/fixtures");

async function abrirComo(page, context, role, hash = "/") {
  await injetarSessao(context, role);
  await page.goto(hash === "/" ? "/" : `/#${hash.replace(/^#/, "")}`);
  await expect(page.locator("#mainApp")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#screen-server-status")).toBeHidden();
}

test("refreshing the page preserves the Grade tab", async ({ page, context }) => {
  await abrirComo(page, context, "admin");
  await page.locator('#gradeTabBtn').click();
  await expect(page.locator("#screen-grade")).toBeVisible();
  await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/^#\/grade/);

  await page.reload();
  await expect(page.locator("#screen-grade")).toBeVisible({ timeout: 20_000 });
});

test("refreshing the page preserves the administration sub-tab", async ({ page, context }) => {
  await abrirComo(page, context, "superadmin");
  await page.locator("#adminTabBtn").click();
  await page.locator('.admin-subtab-btn[data-sub="macs"]').click();
  await expect(page.locator("#adminSub-macs")).toBeVisible();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/admin/macs");

  await page.reload();
  await expect(page.locator("#adminSub-macs")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#adminSub-usuarios")).toBeHidden();
});

test("refreshing the page preserves the open room's control panel", async ({ page, context }) => {
  await abrirComo(page, context, "user", "/sala/A-108");
  await expect(page.locator("#screen-panel")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#panelRoomName")).toContainText("A-108");

  await page.reload();
  await expect(page.locator("#screen-panel")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#panelRoomName")).toContainText("A-108");
});

test("a direct link to a floor plan section activates the right tab", async ({ page, context }) => {
  await abrirComo(page, context, "user", "/salas/planta/b-2pav");
  await expect(page.locator("#screen-floorplan")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#screen-floorplan .fp-tab-btn.active')).toHaveAttribute("data-fp-section", "b-2pav");
});

test("a regular user with a direct link to administration lands on the rooms", async ({ page, context }) => {
  await abrirComo(page, context, "user", "/admin/macs");
  await expect(page.locator("#screen-admin")).toBeHidden();
  await expect(page.locator("#adminTabBtn")).toBeHidden();
  await expect(
    page.locator("#screen-simple, #screen-location, #screen-rooms").first()
  ).toBeVisible();
});

test("a regular administrator with a direct link to technical Status lands on Usuários ativos", async ({ page, context }) => {
  await abrirComo(page, context, "admin", "/admin/monitoramento");
  await expect(page.locator("#screen-admin")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#adminSub-status")).toBeVisible();
  await expect(page.locator("#statusAba-ativos")).toBeVisible();
  await expect(page.locator("#statusAba-sistema")).toBeHidden();
  await expect(page.locator('#adminSub-status .admin-inner-tab-btn[data-aba="sistema"]')).toBeHidden();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/admin/status");
});

test("an unknown route falls back to Início and normalizes the address", async ({ page, context }) => {
  await abrirComo(page, context, "user", "/rota-que-nao-existe");
  await expect(page.locator("#screen-inicio")).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/inicio");
});

test("closing the app page returns to Início", async ({ page, context }) => {
  await abrirComo(page, context, "user", "/aplicativo");
  await expect(page.locator("#screen-mobile-app")).toBeVisible({ timeout: 20_000 });
  await page.locator("#mobileAppBackBtn").click();
  await expect(page.locator("#screen-mobile-app")).toBeHidden();
  await expect(page.locator("#screen-inicio")).toBeVisible();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/inicio");
});

test("logout clears the navigation address", async ({ page, loginComo }) => {
  await page.goto("/");
  await loginComo("admin");
  await page.locator("#gradeTabBtn").click();
  await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/^#\/grade/);
  await page.locator("#accountMenuBtn").click();
  await page.locator('[data-account-action="logout"]').click();
  await expect(page.locator("#screen-portal")).toBeVisible();
  expect(await page.evaluate(() => location.hash)).toBe("");
});

test("browser back and forward walk through the visited sections", async ({ page, context }) => {
  await abrirComo(page, context, "superadmin");
  await expect(page.locator("#screen-inicio")).toBeVisible();

  await page.locator("#gradeTabBtn").click();
  await expect(page.locator("#screen-grade")).toBeVisible();
  await page.locator("#adminTabBtn").click();
  await expect(page.locator("#screen-admin")).toBeVisible();

  await expect
    .poll(() => page.evaluate(() => history.length))
    .toBeGreaterThanOrEqual(3);

  await page.goBack();
  await expect(page.locator("#screen-grade")).toBeVisible();
  await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/^#\/grade/);

  await page.goBack();
  await expect(page.locator("#screen-inicio")).toBeVisible();

  await page.goForward();
  await expect(page.locator("#screen-grade")).toBeVisible();
});

test("back walks through the visited administration sub-tabs", async ({ page, context }) => {
  await abrirComo(page, context, "superadmin");
  await page.locator("#adminTabBtn").click();
  await page.locator('.admin-subtab-btn[data-sub="logs"]').click();
  await page.locator('#adminSub-logs .admin-inner-tab-btn[data-aba="dispositivos"]').click();
  await expect(page.locator("#logsAba-dispositivos")).toBeVisible();
  await page.locator('.admin-subtab-btn[data-sub="esp32"]').click();
  await expect(page.locator("#adminSub-esp32")).toBeVisible();

  await page.goBack();
  await expect(page.locator("#logsAba-dispositivos")).toBeVisible();
  await expect(page.locator("#adminSub-esp32")).toBeHidden();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/admin/logs/dispositivos");
});

test("back switches the active floor plan section", async ({ page, context }) => {
  await abrirComo(page, context, "user", "/salas/planta/a-2pav");
  await expect(page.locator("#screen-floorplan .fp-tab-btn.active")).toHaveAttribute(
    "data-fp-section",
    "a-2pav"
  );

  await page.locator('#screen-floorplan .fp-tab-btn[data-fp-section="b-3pav"]').click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/salas/planta/b-3pav");

  await page.goBack();
  await expect(page.locator("#screen-floorplan .fp-tab-btn.active")).toHaveAttribute(
    "data-fp-section",
    "a-2pav"
  );
});

test("a direct link opens the ESP32 sub-tab and survives a refresh (superadmin)", async ({ page, context }) => {
  await abrirComo(page, context, "superadmin", "/admin/esp32");
  await expect(page.locator("#adminSub-esp32")).toBeVisible({ timeout: 20_000 });
  await page.reload();
  await expect(page.locator("#adminSub-esp32")).toBeVisible({ timeout: 20_000 });
});

test("direct link /relatos opens the reports panel", async ({ page, context }) => {
  await abrirComo(page, context, "user", "/relatos");
  await expect(page.locator("#relatosPanel")).toBeVisible({ timeout: 20_000 });
});

test("direct link /admin/relatos opens the report management sub-tab and survives a refresh (superadmin)", async ({ page, context }) => {
  await abrirComo(page, context, "superadmin", "/admin/relatos");
  await expect(page.locator("#screen-admin")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#adminSub-relatos")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#adminRelatosFiltros .relato-chip").first()).toBeVisible();
  await page.reload();
  await expect(page.locator("#adminSub-relatos")).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/admin/relatos");
});

test("direct link /admin/relatos does not grant report management to a regular admin", async ({ page, context }) => {
  await abrirComo(page, context, "admin", "/admin/relatos");
  await expect(page.locator("#screen-admin")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#adminSub-relatos")).toBeHidden();
  await expect(page.locator('.admin-subtab-btn[data-sub="relatos"]')).toBeHidden();
});

test("the /agendamentos alias opens the Agenda tab", async ({ page, context }) => {
  await abrirComo(page, context, "admin", "/agendamentos");
  await expect(page.locator("#screen-agenda")).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/agenda");
});

test("documentation link /ajuda/ota opens the manual at the OTA section", async ({ page, context }) => {
  await abrirComo(page, context, "superadmin", "/ajuda/ota");
  await expect(page.locator("#screen-manual")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#manual-sec-ota-credenciais")).toBeVisible();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/ajuda/ota-credenciais");
});

test("the manual opens by direct link even logged out, without exposing restricted sections", async ({ page }) => {
  await page.goto("/#/ajuda/monitoramento");
  await expect(page.locator("#screen-manual")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#manual-sec-inicio")).toBeVisible();
  await expect(page.locator("#manual-sec-monitoramento")).toHaveCount(0);
});

test("navigation never changes the URL path, only the fragment (Cordova/file://)", async ({ page, context }) => {
  await abrirComo(page, context, "superadmin");
  const caminho = await page.evaluate(() => location.pathname);

  await page.locator("#gradeTabBtn").click();
  await page.locator("#adminTabBtn").click();
  await page.locator('.admin-subtab-btn[data-sub="status"]').click();
  await page.locator('#adminSub-status .admin-inner-tab-btn[data-aba="mapa"]').click();
  await expect(page.locator("#statusAba-mapa")).toBeVisible();

  expect(await page.evaluate(() => location.pathname)).toBe(caminho);
  expect(await page.evaluate(() => location.search)).toBe("");
});

test("a deep link on a path with /index.html is restored after refresh (Cordova style)", async ({ page, context }) => {
  await injetarSessao(context, "user");
  await page.goto("/index.html#/sala/A-108");
  await expect(page.locator("#mainApp")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#screen-panel")).toBeVisible({ timeout: 20_000 });

  await page.reload();
  await expect(page.locator("#screen-panel")).toBeVisible({ timeout: 20_000 });
  expect(await page.evaluate(() => location.pathname)).toMatch(/\/index\.html$/);
});

test("the manual opens by direct link even offline, served from the PWA cache", async ({ page, context, browserName }) => {
  test.skip(browserName === "webkit", "no projeto WebKit o service worker fica bloqueado para que page.route intercepte a API; a emulação offline do Playwright tampouco alcança navegações servidas pelo worker nesse motor");
  await page.goto("/");
  await expect(page.locator("#screen-portal")).toBeVisible({ timeout: 20_000 });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect(page.locator("#screen-portal")).toBeVisible({ timeout: 20_000 });

  await context.setOffline(true);
  try {
    await page.goto("/#/ajuda/pwa");
    await expect(page.locator("#screen-manual")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("#manual-sec-pwa-mobile")).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/ajuda/pwa-mobile");
  } finally {
    await context.setOffline(false);
  }
});

test("a protected route in the address grants no access: a regular user at /admin lands on the rooms", async ({ page, context }) => {
  await abrirComo(page, context, "user", "/admin/config");
  await expect(page.locator("#screen-admin")).toBeHidden();
  await expect(page.locator("#adminTabBtn")).toBeHidden();
  await expect(
    page.locator("#screen-simple, #screen-location, #screen-rooms").first()
  ).toBeVisible();
  await expect(page.locator("#adminSub-config")).toBeHidden();
});

test("a route with a nonexistent room does not leave an infinite retry running after navigating to another screen", async ({ page, context }) => {
  await injetarSessao(context, "admin");
  await context.addInitScript(() => {
    window.__retentativas = 0;
    const original = window.setTimeout;
    window.setTimeout = function (fn, atraso, ...resto) {
      if (atraso === 120) window.__retentativas += 1;
      return original.call(window, fn, atraso, ...resto);
    };
  });
  await page.goto("/#/agenda/SALA-QUE-NAO-EXISTE");
  await expect(page.locator("#screen-agenda")).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => window.__retentativas)).toBeGreaterThan(0);

  await page.evaluate(() => Router.ir("/inicio"));
  await expect(page.locator("#screen-inicio")).toBeVisible();
  await page.waitForTimeout(300);
  const aoSair = await page.evaluate(() => window.__retentativas);
  await page.waitForTimeout(2000);
  expect(await page.evaluate(() => window.__retentativas), "no new attempt after navigating").toBe(aoSair);

  await page.evaluate(() => Router.ir("/agenda/OUTRA-INEXISTENTE"));
  await expect(page.locator("#screen-agenda")).toBeVisible();
  await expect
    .poll(async () => {
      const antes = await page.evaluate(() => window.__retentativas);
      await page.waitForTimeout(1500);
      return (await page.evaluate(() => window.__retentativas)) - antes;
    }, { message: "a repetição é limitada mesmo permanecendo na rota inválida", timeout: 20_000 })
    .toBe(0);
  const limitadas = await page.evaluate(() => window.__retentativas);
  expect(limitadas - aoSair).toBeLessThanOrEqual(26);
});

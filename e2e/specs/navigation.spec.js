const { test, expect, injetarSessao } = require("../harness/fixtures");

async function abrirComo(page, context, role, hash = "/") {
  await injetarSessao(context, role);
  await page.goto(hash === "/" ? "/" : `/#${hash.replace(/^#/, "")}`);
  await expect(page.locator("#mainApp")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#screen-server-status")).toBeHidden();
}

test("atualizar a página preserva a aba Grade", async ({ page, context }) => {
  await abrirComo(page, context, "admin");
  await page.locator('#gradeTabBtn').click();
  await expect(page.locator("#screen-grade")).toBeVisible();
  await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/^#\/grade/);

  await page.reload();
  await expect(page.locator("#screen-grade")).toBeVisible({ timeout: 20_000 });
});

test("atualizar a página preserva a sub-aba de administração", async ({ page, context }) => {
  await abrirComo(page, context, "superadmin");
  await page.locator("#adminTabBtn").click();
  await page.locator('.admin-subtab-btn[data-sub="macs"]').click();
  await expect(page.locator("#adminSub-macs")).toBeVisible();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/admin/macs");

  await page.reload();
  await expect(page.locator("#adminSub-macs")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#adminSub-usuarios")).toBeHidden();
});

test("atualizar a página preserva o painel de controle da sala aberta", async ({ page, context }) => {
  await abrirComo(page, context, "user", "/sala/A-108");
  await expect(page.locator("#screen-panel")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#panelRoomName")).toContainText("A-108");

  await page.reload();
  await expect(page.locator("#screen-panel")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#panelRoomName")).toContainText("A-108");
});

test("link direto para uma seção da planta baixa ativa a aba certa", async ({ page, context }) => {
  await abrirComo(page, context, "user", "/salas/planta/b-2pav");
  await expect(page.locator("#screen-floorplan")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#screen-floorplan .fp-tab-btn.active')).toHaveAttribute("data-fp-section", "b-2pav");
});

test("usuário comum com link direto para a administração cai nas salas", async ({ page, context }) => {
  await abrirComo(page, context, "user", "/admin/macs");
  await expect(page.locator("#screen-admin")).toBeHidden();
  await expect(page.locator("#adminTabBtn")).toBeHidden();
  await expect(
    page.locator("#screen-simple, #screen-location, #screen-rooms").first()
  ).toBeVisible();
});

test("administrador comum com link direto para o monitoramento cai em Usuários", async ({ page, context }) => {
  await abrirComo(page, context, "admin", "/admin/monitoramento");
  await expect(page.locator("#screen-admin")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#adminSub-usuarios")).toBeVisible();
  await expect(page.locator("#adminSub-monitoramento")).toBeHidden();
});

test("sair limpa o endereço de navegação", async ({ page, loginComo }) => {
  await page.goto("/");
  await loginComo("admin");
  await page.locator("#gradeTabBtn").click();
  await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/^#\/grade/);
  await page.locator("#logoutBtn").click();
  await expect(page.locator("#screen-portal")).toBeVisible();
  expect(await page.evaluate(() => location.hash)).toBe("");
});

test("voltar e avançar do navegador percorrem as seções visitadas", async ({ page, context }) => {
  await abrirComo(page, context, "superadmin");
  await expect(page.locator("#screen-simple")).toBeVisible();

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
  await expect(page.locator("#screen-simple")).toBeVisible();

  await page.goForward();
  await expect(page.locator("#screen-grade")).toBeVisible();
});

test("voltar percorre as sub-abas de administração visitadas", async ({ page, context }) => {
  await abrirComo(page, context, "superadmin");
  await page.locator("#adminTabBtn").click();
  await page.locator('.admin-subtab-btn[data-sub="dispositivos"]').click();
  await expect(page.locator("#adminSub-dispositivos")).toBeVisible();
  await page.locator('.admin-subtab-btn[data-sub="esp32"]').click();
  await expect(page.locator("#adminSub-esp32")).toBeVisible();

  await page.goBack();
  await expect(page.locator("#adminSub-dispositivos")).toBeVisible();
  await expect(page.locator("#adminSub-esp32")).toBeHidden();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/admin/dispositivos");
});

test("voltar troca a seção ativa da planta baixa", async ({ page, context }) => {
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

test("link direto abre a sub-aba ESP32 e sobrevive ao refresh (superadmin)", async ({ page, context }) => {
  await abrirComo(page, context, "superadmin", "/admin/esp32");
  await expect(page.locator("#adminSub-esp32")).toBeVisible({ timeout: 20_000 });
  await page.reload();
  await expect(page.locator("#adminSub-esp32")).toBeVisible({ timeout: 20_000 });
});

test("link direto /relatos abre o painel de relatos", async ({ page, context }) => {
  await abrirComo(page, context, "user", "/relatos");
  await expect(page.locator("#relatosPanel")).toBeVisible({ timeout: 20_000 });
});

test("link direto /admin/relatos abre o painel de relatos para o superadmin", async ({ page, context }) => {
  await abrirComo(page, context, "superadmin", "/admin/relatos");
  await expect(page.locator("#relatosPanel")).toBeVisible({ timeout: 20_000 });
});

test("o alias /agendamentos abre a aba Agenda", async ({ page, context }) => {
  await abrirComo(page, context, "admin", "/agendamentos");
  await expect(page.locator("#screen-agenda")).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/agenda");
});

test("link de documentação /ajuda/ota abre o manual na seção de OTA", async ({ page, context }) => {
  await abrirComo(page, context, "superadmin", "/ajuda/ota");
  await expect(page.locator("#screen-manual")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#manual-sec-ota-credenciais")).toBeVisible();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/ajuda/ota-credenciais");
});

test("o manual abre por link direto mesmo deslogado, sem expor seções restritas", async ({ page }) => {
  await page.goto("/#/ajuda/monitoramento");
  await expect(page.locator("#screen-manual")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#manual-sec-inicio")).toBeVisible();
  await expect(page.locator("#manual-sec-monitoramento")).toHaveCount(0);
});

test("a navegação nunca altera o caminho da URL, apenas o fragmento (Cordova/file://)", async ({ page, context }) => {
  await abrirComo(page, context, "superadmin");
  const caminho = await page.evaluate(() => location.pathname);

  await page.locator("#gradeTabBtn").click();
  await page.locator("#adminTabBtn").click();
  await page.locator('.admin-subtab-btn[data-sub="mapa"]').click();
  await expect(page.locator("#adminSub-mapa")).toBeVisible();

  expect(await page.evaluate(() => location.pathname)).toBe(caminho);
  expect(await page.evaluate(() => location.search)).toBe("");
});

test("deep link em caminho com /index.html é restaurado após refresh (estilo Cordova)", async ({ page, context }) => {
  await injetarSessao(context, "user");
  await page.goto("/index.html#/sala/A-108");
  await expect(page.locator("#mainApp")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#screen-panel")).toBeVisible({ timeout: 20_000 });

  await page.reload();
  await expect(page.locator("#screen-panel")).toBeVisible({ timeout: 20_000 });
  expect(await page.evaluate(() => location.pathname)).toMatch(/\/index\.html$/);
});

test("o manual abre por link direto mesmo offline, servido pelo cache do PWA", async ({ page, context }) => {
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

test("uma rota protegida no endereço não concede acesso: usuário comum em /admin cai nas salas", async ({ page, context }) => {
  await abrirComo(page, context, "user", "/admin/config");
  await expect(page.locator("#screen-admin")).toBeHidden();
  await expect(page.locator("#adminTabBtn")).toBeHidden();
  await expect(
    page.locator("#screen-simple, #screen-location, #screen-rooms").first()
  ).toBeVisible();
  await expect(page.locator("#adminSub-config")).toBeHidden();
});

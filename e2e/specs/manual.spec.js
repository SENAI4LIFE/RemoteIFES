const { test, expect, injetarSessao, semRolagemHorizontal, API_URL } = require("../harness/fixtures");

async function abrirApp(page, context, role) {
  if (role) await injetarSessao(context, role);
  await page.goto("/");
  await expect(page.locator(role ? "#mainApp" : "#screen-portal")).toBeVisible({ timeout: 20_000 });
}

async function abrirManualPeloFab(page) {
  await page.locator("#helpFabToggleBtn").click();
  await expect(page.locator("#helpFabPanel")).toBeVisible();
  await page.locator("#helpFabManualBtn").click();
  await expect(page.locator("#screen-manual")).toBeVisible({ timeout: 10_000 });
}

test("\"Precisa de ajuda?\" abre o manual completo, não um popup", async ({ page, context }) => {
  await abrirApp(page, context, "user");
  await abrirManualPeloFab(page);
  await expect(page.locator("#helpFabPanel")).toBeHidden();
  await expect(page.locator("#manualToc .manual-toc-link")).not.toHaveCount(0);
  const total = await page.locator("#manualConteudo .manual-secao").count();
  expect(total).toBeGreaterThanOrEqual(8);
  await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/^#\/ajuda/);
});

test("o manual esconde as seções de administração de um usuário comum", async ({ page, context }) => {
  await abrirApp(page, context, "user");
  await abrirManualPeloFab(page);
  await expect(page.locator("#manual-sec-monitoramento")).toHaveCount(0);
  await expect(page.locator("#manual-sec-administracao")).toHaveCount(0);
});

test("o manual mostra as seções de administração ao administrador principal", async ({ page, context }) => {
  await injetarSessao(context, "superadmin");
  await page.goto("/#/ajuda/monitoramento");
  await expect(page.locator("#screen-manual")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#manual-sec-monitoramento")).toHaveCount(1);
  await expect(page.locator("#manual-sec-administracao")).toHaveCount(1);
});

test("busca do manual filtra as seções", async ({ page, context }) => {
  await abrirApp(page, context, "admin");
  await abrirManualPeloFab(page);
  const total = await page.locator("#manualConteudo .manual-secao").count();
  await page.fill("#manualBusca", "agendamento");
  await expect
    .poll(() => page.locator("#manualConteudo .manual-secao:not(.hidden)").count())
    .toBeLessThan(total);
  await expect(page.locator("#manualConteudo .manual-secao:not(.hidden)")).not.toHaveCount(0);
});

test("\"Ver no app\" leva à tela correspondente e fecha o manual", async ({ page, context }) => {
  await injetarSessao(context, "superadmin");
  await page.goto("/#/ajuda/esp32-cadastro");
  await expect(page.locator("#screen-manual")).toBeVisible({ timeout: 20_000 });
  await page.locator('#manual-sec-esp32-cadastro .manual-ver-app').click();
  await expect(page.locator("#screen-manual")).toBeHidden();
  await expect(page.locator("#adminSub-macs")).toBeVisible({ timeout: 10_000 });
});

test("o ícone de ajuda de uma tela leva à seção do manual", async ({ page, context }) => {
  await abrirApp(page, context, "user");
  await page.locator('#screen-simple .help-icon-btn').click();
  await expect(page.locator("#helpModal")).toBeVisible();
  await page.locator("#helpModalManualBtn").click();
  await expect(page.locator("#screen-manual")).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/ajuda/selecao-sala");
});

test("Esc fecha o manual e volta para a tela anterior", async ({ page, context }) => {
  await abrirApp(page, context, "admin");
  await page.locator("#gradeTabBtn").click();
  await expect(page.locator("#screen-grade")).toBeVisible();
  await abrirManualPeloFab(page);
  await page.keyboard.press("Escape");
  await expect(page.locator("#screen-manual")).toBeHidden();
  await expect(page.locator("#screen-grade")).toBeVisible();
});

test("o manual não faz requisições externas e cabe no celular", async ({ page, context }) => {
  const externas = [];
  await page.route("**/*", (route) => {
    const u = route.request().url();
    const local = u.startsWith("data:") || u.startsWith("blob:") || u.startsWith(API_URL) ||
      u.startsWith("http://127.0.0.1:") || u.startsWith("ws://127.0.0.1:");
    if (!local) externas.push(u);
    route.continue();
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await abrirApp(page, context, "user");
  await abrirManualPeloFab(page);
  await page.locator('.manual-toc-link').nth(3).click();
  expect(externas.filter((u) => !u.includes("cordova.js"))).toEqual([]);
  expect(await semRolagemHorizontal(page)).toBe(true);
});

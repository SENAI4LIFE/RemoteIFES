const { test, expect, API_URL, injetarSessao, semRolagemHorizontal } = require("../harness/fixtures");

test("avatar usa duas iniciais e o menu funciona por teclado", async ({ page, context }) => {
  await injetarSessao(context, "user");
  await page.goto("/");
  await expect(page.locator("#accountMenuBtn")).toHaveText("UE");
  expect(await page.evaluate(() => AccountMenu.iniciais("Bruno de Almeida Martins"))).toBe("BA");
  expect(await page.evaluate(() => AccountMenu.iniciais("Bruno Alexander Vailante Martins"))).toBe("BA");
  await page.locator("#accountMenuBtn").focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("#accountMenu")).toBeVisible();
  await expect(page.locator("#accountMenu [role=menuitem]").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#accountMenu")).toBeHidden();
  await expect(page.locator("#accountMenuBtn")).toBeFocused();
});

test("página móvel é autenticada, responsiva e não oferece APK não publicado", async ({ page, context }) => {
  await injetarSessao(context, "user");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/aplicativo");
  await expect(page.locator("#screen-mobile-app")).toBeVisible();
  await expect(page.locator(".mobile-app-unavailable")).toContainText("não foi publicado");
  await expect(page.locator(".mobile-app-download-btn")).toHaveCount(0);
  expect(await semRolagemHorizontal(page), "página do aplicativo sem rolagem horizontal").toBe(true);
});

test("rota direta do aplicativo não abre sem autenticação", async ({ page }) => {
  await page.goto("/#/aplicativo");
  await expect(page.locator("#screen-portal")).toBeVisible();
  await expect(page.locator("#screen-mobile-app")).toBeHidden();
});

test("documentação privilegiada é entregue pelo servidor conforme o papel", async ({ request, tokens }) => {
  const anonimo = await request.get(`${API_URL}/documentation`);
  expect(anonimo.status()).toBe(401);
  const comum = await request.get(`${API_URL}/documentation`, { headers: { Authorization: `Bearer ${tokens.user}` } });
  expect((await comum.json()).secoes).toHaveLength(0);
  const admin = await request.get(`${API_URL}/documentation`, { headers: { Authorization: `Bearer ${tokens.admin}` } });
  const adminIds = (await admin.json()).secoes.map((secao) => secao.id);
  expect(adminIds).toContain("administracao");
  expect(adminIds).not.toContain("operacao-admin");
  expect(adminIds).not.toContain("monitoramento");
  const superadmin = await request.get(`${API_URL}/documentation`, { headers: { Authorization: `Bearer ${tokens.superadmin}` } });
  const superIds = (await superadmin.json()).secoes.map((secao) => secao.id);
  expect(superIds).toContain("administracao");
  expect(superIds).toContain("operacao-admin");
  expect(superIds).toContain("monitoramento");
});

test("download Android exige sessão e não publica artefato ausente", async ({ request, tokens }) => {
  expect((await request.get(`${API_URL}/mobile-app/android`)).status()).toBe(401);
  const autenticado = await request.get(`${API_URL}/mobile-app/android`, { headers: { Authorization: `Bearer ${tokens.user}` } });
  expect(autenticado.status()).toBe(404);
  expect((await autenticado.json()).erro).toContain("não publicado");
});

test("assets públicos não contêm procedimentos privilegiados", async ({ request }) => {
  const manual = await (await request.get("/js/manual-content.js")).text();
  const ajuda = await (await request.get("/js/help.js")).text();
  for (const conteudo of [manual, ajuda]) {
    expect(conteudo).not.toContain("deploy.sh");
    expect(conteudo).not.toContain("restore-backup.js");
    expect(conteudo).not.toContain("operacao-admin\", titulo");
    expect(conteudo).not.toContain("Modo de manutenção");
  }
});

test("administrador comum não abre documentação de infraestrutura por URL", async ({ page, context }) => {
  await injetarSessao(context, "admin");
  await page.goto("/#/ajuda/operacao-admin");
  await expect(page.locator("#screen-manual")).toBeVisible();
  await expect(page.locator("#manual-sec-administracao")).toBeVisible();
  await expect(page.locator("#manual-sec-operacao-admin")).toHaveCount(0);
});

test("menu rápido de ajuda expõe todas as ações comuns e fecha com Escape", async ({ page, context }) => {
  await injetarSessao(context, "user");
  await page.goto("/");
  await page.locator("#helpFabToggleBtn").click();
  await expect(page.locator("#helpFabPanel")).toBeVisible();
  await expect(page.locator("#helpFabPrimaryLinks")).toContainText("Ajuda desta página");
  await expect(page.locator("#helpFabPrimaryLinks")).toContainText("Manual completo");
  await expect(page.locator("#helpFabPrimaryLinks")).toContainText("Solução de problemas");
  await expect(page.locator("#helpFabPrimaryLinks")).toContainText("Relatar um problema");
  await expect(page.locator("#helpFabPrimaryLinks")).toContainText("Aplicativo móvel");
  await page.keyboard.press("Escape");
  await expect(page.locator("#helpFabPanel")).toBeHidden();
  await expect(page.locator("#helpFabToggleBtn")).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#helpFabToggleBtn")).toBeFocused();
});

test("atalhos do menu de ajuda de admin não incluem infraestrutura", async ({ page, context }) => {
  await injetarSessao(context, "admin");
  await page.goto("/");
  await page.locator("#helpFabToggleBtn").click();
  await expect(page.locator("#helpFabLinks")).toContainText("Administração");
  await expect(page.locator("#helpFabLinks")).not.toContainText("Monitoramento");
});

test("atalhos do menu de ajuda de superadmin incluem infraestrutura", async ({ page, context }) => {
  await injetarSessao(context, "superadmin");
  await page.goto("/");
  await page.locator("#helpFabToggleBtn").click();
  await expect(page.locator("#helpFabLinks")).toContainText("Monitoramento");
  await expect(page.locator("#helpFabLinks")).toContainText("Operação, implantação e manutenção");
});

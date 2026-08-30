const { test, expect, injetarSessao, semRolagemHorizontal, VIEWPORTS } = require("../harness/fixtures");

async function abrir(page, context, role, hash = "/") {
  await injetarSessao(context, role);
  await page.goto(hash === "/" ? "/" : `/#${hash.replace(/^#/, "")}`);
  await expect(page.locator("#mainApp")).toBeVisible({ timeout: 20_000 });
}

const chaves = (page, sel) =>
  page.$$eval(`${sel} .hub-card`, (cs) => cs.map((c) => c.dataset.hubCard));

test("a sessão abre no hub de início com a aba Início ativa", async ({ page, sessaoComo }) => {
  await sessaoComo("user");
  await expect(page.locator("#screen-inicio")).toBeVisible();
  await expect(page.locator('.tab-btn[data-tab="inicio"].active')).toBeVisible();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/inicio");
});

test("hub do usuário comum: ações operacionais, sem administração nem saúde", async ({ page, context }) => {
  await abrir(page, context, "user");
  const cards = await chaves(page, "#hubGridPrincipal");
  expect(cards).toEqual(expect.arrayContaining(["salas", "planta", "relatos", "ajuda", "aplicativo"]));
  expect(cards).not.toContain("agenda");
  expect(cards).not.toContain("notificacoes");
  await expect(page.locator("#hubAdminBloco")).toBeHidden();
  await expect(page.locator("#hubResumo")).toBeHidden();
});

test("hub do administrador: agenda/grade/notificações e atalhos de administração sem os de superadmin", async ({ page, context }) => {
  await abrir(page, context, "admin");
  const cards = await chaves(page, "#hubGridPrincipal");
  expect(cards).toEqual(expect.arrayContaining(["agenda", "grade", "notificacoes"]));
  await expect(page.locator("#hubAdminBloco")).toBeVisible();
  const adm = await chaves(page, "#hubGridAdmin");
  expect(adm).toContain("adm-usuarios");
  expect(adm).not.toContain("adm-config");
  expect(adm).not.toContain("adm-monitoramento");
  await expect(page.locator("#hubResumo")).toBeHidden();
});

test("hub do superadministrador: atalhos completos e faixa de saúde do sistema", async ({ page, context }) => {
  await abrir(page, context, "superadmin");
  const adm = await chaves(page, "#hubGridAdmin");
  expect(adm).toEqual(expect.arrayContaining(["adm-macs", "adm-config", "adm-monitoramento", "adm-relatos"]));
  await expect(page.locator("#hubResumo")).toBeVisible();
  await expect(page.locator("#hubResumo .status-chip").first()).toBeVisible();
  await page.locator("#hubResumo .hub-resumo-link").click();
  await expect(page.locator("#adminSub-monitoramento")).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/admin/monitoramento");
});

test("um card do hub navega para a seção e o voltar retorna ao início", async ({ page, context }) => {
  await abrir(page, context, "user");
  await page.locator('#hubGridPrincipal .hub-card[data-hub-card="salas"]').click();
  await expect(page.locator("#screen-simple")).toBeVisible();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/salas");
  await page.goBack();
  await expect(page.locator("#screen-inicio")).toBeVisible();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/inicio");
});

test("link direto /inicio e refresh mantêm o hub, sem rolagem horizontal no celular", async ({ page, context }) => {
  await page.setViewportSize(VIEWPORTS["mobile-portrait"]);
  await abrir(page, context, "superadmin", "/inicio");
  await expect(page.locator("#screen-inicio")).toBeVisible({ timeout: 20_000 });
  await page.reload();
  await expect(page.locator("#screen-inicio")).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/inicio");
  expect(await semRolagemHorizontal(page), "hub sem rolagem horizontal no celular").toBe(true);
});

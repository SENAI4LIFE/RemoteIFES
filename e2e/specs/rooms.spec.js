const { test, expect } = require("../harness/fixtures");

async function abrirSalas(page) {
  await page.locator('.tab-btn[data-tab="salas"]').click();
  await expect(page.locator("#screen-simple")).toBeVisible();
}

test("assistente simples: bloco -> andar -> sala abre o painel de controle", async ({ page, sessaoComo }) => {
  await sessaoComo("user");
  await abrirSalas(page);

  await page.locator('#simpleGridBloco .simple-tile[data-bloco="A"]').click();
  await expect(page.locator("#simpleStepAndar")).toBeVisible();

  await page.locator('#simpleGridAndar .simple-tile[data-andar="1"]').click();
  await expect(page.locator("#simpleStepSala")).toBeVisible();
  await expect(page.locator(".simple-tile-sala")).not.toHaveCount(0);

  await page.locator('.simple-tile-sala[data-sala="A-108"]').click();
  await expect(page.locator("#screen-panel")).toBeVisible();
  await expect(page.locator("#panelRoomName")).toContainText("A-108");
});

test("navegação em lista tradicional (bloco/andar) chega à mesma sala", async ({ page, sessaoComo }) => {
  await sessaoComo("user");
  await abrirSalas(page);
  await page.locator("#simpleListBtn").click();
  await expect(page.locator("#screen-location")).toBeVisible();

  await page.locator('#blocoChoices .choice-btn[data-bloco="A"]').click();
  await page.locator('#andarChoices .choice-btn[data-andar="1"]').click();
  await page.locator("#verSalasBtn").click();

  await expect(page.locator("#screen-rooms")).toBeVisible();
  await page.locator('#roomList li[data-sala="A-108"]').click();
  await expect(page.locator("#screen-panel")).toBeVisible();
  await expect(page.locator("#panelRoomName")).toContainText("A-108");
});

test("planta baixa mostra as seis seções e permite voltar para o assistente", async ({ page, sessaoComo }) => {
  await sessaoComo("user");
  await abrirSalas(page);
  await page.locator("#simpleFloorplanBtn").click();
  await expect(page.locator("#screen-floorplan")).toBeVisible();
  await expect(page.locator(".fp-tab-btn")).toHaveCount(6);
  await page.locator("#floorplanSimpleBtn").click();
  await expect(page.locator("#screen-simple")).toBeVisible();
});

test("sala com ESP32 conectado aparece como online na lista", async ({ page, sessaoComo }) => {
  await sessaoComo("user");
  await abrirSalas(page);
  await page.locator("#simpleListBtn").click();
  await page.locator('#blocoChoices .choice-btn[data-bloco="A"]').click();
  await page.locator('#andarChoices .choice-btn[data-andar="1"]').click();
  await page.locator("#verSalasBtn").click();
  const badge = page.locator('#roomList li[data-sala="A-108"] .status-badge');
  await expect(badge).toHaveText("online", { timeout: 15_000 });
});

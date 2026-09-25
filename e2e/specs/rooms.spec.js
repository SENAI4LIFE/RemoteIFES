const { test, expect } = require("../harness/fixtures");

async function abrirSalas(page) {
  await page.locator('.tab-btn[data-tab="salas"]').click();
  await expect(page.locator("#screen-simple")).toBeVisible();
}

test("simple wizard: block -> floor -> room opens the control panel", async ({ page, sessaoComo }) => {
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

test("traditional list navigation (block/floor) reaches the same room", async ({ page, sessaoComo }) => {
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

test("the floor plan shows the six sections and allows returning to the wizard", async ({ page, sessaoComo }) => {
  await sessaoComo("user");
  await abrirSalas(page);
  await page.locator("#simpleFloorplanBtn").click();
  await expect(page.locator("#screen-floorplan")).toBeVisible();
  await expect(page.locator(".fp-tab-btn")).toHaveCount(6);
  await page.locator("#floorplanSimpleBtn").click();
  await expect(page.locator("#screen-simple")).toBeVisible();
});

test("a room with a connected ESP32 appears online in the list", async ({ page, sessaoComo }) => {
  await sessaoComo("user");
  await abrirSalas(page);
  await page.locator("#simpleListBtn").click();
  await page.locator('#blocoChoices .choice-btn[data-bloco="A"]').click();
  await page.locator('#andarChoices .choice-btn[data-andar="1"]').click();
  await page.locator("#verSalasBtn").click();
  const badge = page.locator('#roomList li[data-sala="A-108"] .status-badge');
  await expect(badge).toHaveText("online", { timeout: 15_000 });
});

const { test, expect, irParaSala, API_URL } = require("../harness/fixtures");

test("a late response from another room does not replace the current panel", async ({ page, sessaoComo }) => {
  await sessaoComo("admin");
  let liberar;
  const respostaPendente = new Promise((resolve) => { liberar = resolve; });
  let iniciou;
  const requisicaoIniciada = new Promise((resolve) => { iniciou = resolve; });
  await page.route("**/status?sala=A-108", async (route) => {
    const resposta = await route.fetch();
    iniciou();
    await respostaPendente;
    await route.fulfill({ response: resposta });
  });
  await page.evaluate(() => { window.aberturaPendente = openRoom("A-108", "Sala inicial"); });
  await requisicaoIniciada;
  await page.evaluate(() => openRoom("A-103a", "Sala seguinte"));
  const esperado = await page.locator("#tempTarget").textContent();
  liberar();
  await page.evaluate(() => window.aberturaPendente);
  await expect(page.locator("#panelRoomName")).toContainText("A-103a");
  await expect(page.locator("#conexaoValue")).toHaveText("offline");
  await expect(page.locator("#tempTarget")).toHaveText(esperado);
});

test("old HTTP does not overwrite newer state received over WebSocket", async ({ page, sessaoComo, tokens }) => {
  await sessaoComo("admin");
  await irParaSala(page, "A-108");
  let liberar;
  const respostaPendente = new Promise((resolve) => { liberar = resolve; });
  let iniciou;
  const requisicaoIniciada = new Promise((resolve) => { iniciou = resolve; });
  await page.route("**/status?sala=A-108", async (route) => {
    const resposta = await route.fetch();
    iniciou();
    await respostaPendente;
    await route.fulfill({ response: resposta });
  });
  await page.evaluate(() => { window.consultaPendente = refreshStatus(); });
  await requisicaoIniciada;
  const alvo = (await page.locator("#tempTarget").textContent()).startsWith("25") ? 24 : 25;
  const resposta = await page.request.post(`${API_URL}/comando`, {
    headers: { Authorization: `Bearer ${tokens.admin}` },
    data: { sala: "A-108", cmd: "temperatura", valor: alvo },
  });
  expect(resposta.ok()).toBe(true);
  await expect(page.locator("#tempTarget")).toHaveText(`${alvo}°C`);
  liberar();
  await page.evaluate(() => window.consultaPendente);
  await expect(page.locator("#tempTarget")).toHaveText(`${alvo}°C`);
});

test("leaving during opening does not reactivate the room observation", async ({ page, sessaoComo }) => {
  await sessaoComo("admin");
  let liberar;
  const respostaPendente = new Promise((resolve) => { liberar = resolve; });
  let iniciou;
  const requisicaoIniciada = new Promise((resolve) => { iniciou = resolve; });
  await page.route("**/status?sala=A-108", async (route) => {
    const resposta = await route.fetch();
    iniciou();
    await respostaPendente;
    await route.fulfill({ response: resposta });
  });
  await page.evaluate(() => { window.aberturaPendente = openRoom("A-108", "Sala inicial"); });
  await requisicaoIniciada;
  await page.locator('.tab-btn[data-tab="inicio"]').click();
  liberar();
  await page.evaluate(() => window.aberturaPendente);
  await expect(page.locator("#screen-inicio")).toBeVisible();
  expect(await page.evaluate(() => _panelPararStatus === null)).toBe(true);
});

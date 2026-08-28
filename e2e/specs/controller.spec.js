const { test, expect, irParaSala } = require("../harness/fixtures");

test("liga e desliga o ar-condicionado de uma sala com ESP32 conectado", async ({ page, sessaoComo }) => {
  await sessaoComo("user");
  await irParaSala(page, "A-108");

  await expect(page.locator("#conexaoValue")).toHaveText("online", { timeout: 15_000 });
  await expect(page.locator("#modoValue")).toHaveText("Off");

  await page.locator("#btnPower").click();
  await expect(page.locator("#modoValue")).toHaveText("Cool");
  await expect(page.locator("#statusValue")).toHaveText("ligado");
  await expect(page.locator("#btnPower")).toHaveClass(/is-on/);

  await page.locator("#btnPower").click();
  await expect(page.locator("#modoValue")).toHaveText("Off");
  await expect(page.locator("#statusValue")).toHaveText("desligado");
});

test("ajuste de temperatura respeita os limites e atualiza o alvo exibido", async ({ page, sessaoComo }) => {
  await sessaoComo("user");
  await irParaSala(page, "A-108");

  const alvo = page.locator("#tempTarget");
  const lerAlvo = async () => parseInt((await alvo.textContent()).replace(/\D/g, ""), 10);

  let atual = await lerAlvo();
  expect(atual).toBeGreaterThanOrEqual(23);
  expect(atual).toBeLessThanOrEqual(25);

  if (atual >= 25) {
    await expect(page.locator("#tempUp")).toBeDisabled();
  } else {
    await page.locator("#tempUp").click();
    await expect(alvo).toHaveText(`${atual + 1}°C`);
    atual += 1;
  }

  if (atual <= 23) {
    await expect(page.locator("#tempDown")).toBeDisabled();
  } else {
    await page.locator("#tempDown").click();
    await expect(alvo).toHaveText(`${atual - 1}°C`);
  }
});

test("usuário sem permissão de controle vê o painel em modo somente leitura", async ({ page, sessaoComo }) => {
  await sessaoComo("readonly");
  await irParaSala(page, "A-108");

  await expect(page.locator("#panelSomenteLeitura")).toBeVisible();
  await expect(page.locator("#btnPower")).toBeDisabled();
  await expect(page.locator("#tempUp")).toBeDisabled();
  await expect(page.locator("#tempDown")).toBeDisabled();
});

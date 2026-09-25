const { test, expect, API_URL, SALA_ONLINE, irParaSala, injetarSessao } = require("../harness/fixtures");

async function definirAutoLigar(request, ligado) {
  const resp = await request.post(`${API_URL}/__e2e/auto-ligar/${ligado ? "on" : "off"}`);
  expect(resp.ok()).toBe(true);
}

async function lerAlvo(page) {
  return parseInt((await page.locator("#tempTarget").textContent()).replace(/\D/g, ""), 10);
}

test.afterEach(async ({ request }) => {
  await definirAutoLigar(request, true);
});

test("Auto-ON is enabled by default in the global configuration and the user does not need to configure anything", async ({ page, context, request }) => {
  await definirAutoLigar(request, true);
  await injetarSessao(context, "superadmin");
  await page.goto("/#/admin/config");
  await expect(page.locator("#adminSub-config")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#cfgAutoLigar")).toBeChecked();
  await expect(page.locator("#cfgCriticoCard")).toContainText("Auto-ON");
});

test("with Auto-ON, adjusting the temperature or Turbo of an appliance that is off turns it on", async ({ page, sessaoComo }) => {
  await sessaoComo("user");
  await irParaSala(page, SALA_ONLINE);
  await expect(page.locator("#conexaoValue")).toHaveText("online", { timeout: 15_000 });
  await expect(page.locator("#modoValue")).toHaveText("Off");
  await expect(page.locator("#btnTurbo")).toBeEnabled();

  const alvo = await lerAlvo(page);
  const botao = alvo < 25 ? "#tempUp" : "#tempDown";
  const esperado = alvo < 25 ? alvo + 1 : alvo - 1;
  await page.locator(botao).click();
  await expect(page.locator("#tempTarget")).toHaveText(`${esperado}°C`);
  await expect(page.locator("#modoValue")).toHaveText("Cool");
  await expect(page.locator("#statusValue")).toHaveText("ligado");

  await page.locator("#btnPower").click();
  await expect(page.locator("#modoValue")).toHaveText("Off");
  await expect(page.locator("#btnTurbo")).toBeEnabled();
  await page.locator("#btnTurbo").click();
  await expect(page.locator("#modoValue")).toHaveText("Cool");
  await expect(page.locator("#btnTurbo")).toHaveClass(/is-on/);

  await page.locator("#btnPower").click();
  await expect(page.locator("#modoValue")).toHaveText("Off");
  await expect(page.locator("#btnTurbo")).not.toHaveClass(/is-on/);
});

test("with Auto-ON disabled by the superadministrator, the panel reflects the option: temperature does not turn on and Turbo requires the appliance on", async ({ page, context, request }) => {
  await injetarSessao(context, "superadmin");
  await page.goto("/#/admin/config");
  await expect(page.locator("#adminSub-config")).toBeVisible({ timeout: 20_000 });
  await page.locator("#cfgAutoLigar").uncheck();
  await page.locator("#salvarConfigBtn").click();
  await expect(page.locator("#configSavedHint")).toBeVisible();
  await page.reload();
  await expect(page.locator("#adminSub-config")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#cfgAutoLigar")).not.toBeChecked();

  const reset = await request.post(`${API_URL}/__e2e/resetar-dispositivo`);
  expect(reset.ok()).toBe(true);
  await irParaSala(page, SALA_ONLINE);
  await expect(page.locator("#conexaoValue")).toHaveText("online", { timeout: 15_000 });
  await expect(page.locator("#modoValue")).toHaveText("Off");
  await expect(page.locator("#btnTurbo")).toBeDisabled();

  const alvo = await lerAlvo(page);
  const botao = alvo < 25 ? "#tempUp" : "#tempDown";
  const esperado = alvo < 25 ? alvo + 1 : alvo - 1;
  await page.locator(botao).click();
  await expect(page.locator("#tempTarget")).toHaveText(`${esperado}°C`);
  await expect(page.locator("#modoValue")).toHaveText("Off");
  await expect(page.locator("#statusValue")).toHaveText("desligado");
  await expect(page.locator("#btnTurbo")).toBeDisabled();

  await page.locator("#btnPower").click();
  await expect(page.locator("#modoValue")).toHaveText("Cool");
  await expect(page.locator("#btnTurbo")).toBeEnabled();

  await definirAutoLigar(request, true);
  await page.locator("#btnPower").click();
  await expect(page.locator("#modoValue")).toHaveText("Off");
  await expect(page.locator("#btnTurbo")).toBeEnabled({ timeout: 15_000 });
});
